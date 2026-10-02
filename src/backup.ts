import { spawn } from "child_process";
import {
  S3Client,
  S3ClientConfig,
  PutObjectCommandInput,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, createWriteStream, statSync, unlinkSync } from "fs";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";
import { filesize } from "filesize";
import path from "path";
import os from "os";

import { env } from "./env.js";
import { createMD5 } from "./util.js";
import {
  BackupObject,
  dated,
  planMonthlyCopies,
  planPrune,
} from "./retention.js";

/** Never prune a prefix below this many objects, whatever their age. */
const MIN_DAILIES_KEPT = 7;
const MIN_MONTHLIES_KEPT = 3;

const client = (): S3Client => {
  const options: S3ClientConfig = {
    region: env.AWS_S3_REGION,
    forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE,
  };
  if (env.AWS_S3_ENDPOINT) options.endpoint = env.AWS_S3_ENDPOINT;
  return new S3Client(options);
};

const prefixOf = (folder: string) => (folder ? folder.replace(/\/+$/, "") + "/" : "");

const uploadToS3 = async (s3: S3Client, key: string, filePath: string) => {
  console.log(`Uploading backup to S3 as ${key}...`);
  const params: PutObjectCommandInput = {
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    Body: createReadStream(filePath),
  };
  if (env.SUPPORT_OBJECT_LOCK) {
    const md5Hash = await createMD5(filePath);
    params.ContentMD5 = Buffer.from(md5Hash, "hex").toString("base64");
  }
  await new Upload({ client: s3, params }).done();
};

/** The object as R2 reports it - the only evidence that the upload landed. */
const verifyObject = async (s3: S3Client, key: string, expectedBytes: number) => {
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }),
  );
  if (head.ContentLength !== expectedBytes) {
    throw new Error(
      `${key}: R2 reports ${head.ContentLength} bytes, expected ${expectedBytes}`,
    );
  }
};

/**
 * pg_dump -> gzip -> file, without a shell.
 *
 * Until 2026-10-02 this was `pg_dump ... | gzip > file` through a shell, where
 * the pipeline's exit status is gzip's: a pg_dump that died halfway produced a
 * truncated, non-empty archive that passed the "is it empty?" check and was
 * uploaded as a good backup. pg_dump's own exit code now decides.
 */
export const dumpToFile = async (filePath: string) => {
  console.log("Dumping DB to file...");
  const args = [
    `--dbname=${env.BACKUP_DATABASE_URL}`,
    "--format=tar",
    ...env.BACKUP_OPTIONS.split(/\s+/).filter(Boolean),
  ];
  const dump = spawn("pg_dump", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  dump.stderr.on("data", (c) => (stderr += c.toString()));
  const exited = new Promise<number>((resolve, reject) => {
    dump.on("error", reject);
    dump.on("close", (code) => resolve(code ?? -1));
  });
  await pipeline(dump.stdout, createGzip(), createWriteStream(filePath));
  const code = await exited;
  if (stderr.trim()) console.log({ stderr: stderr.trimEnd() });
  if (code !== 0) {
    throw new Error(`pg_dump exited ${code}: ${stderr.trim().slice(-500)}`);
  }
  const size = statSync(filePath).size;
  if (size < 1024) throw new Error(`backup archive is ${size} bytes`);
  console.log("Backup filesize:", filesize(size));
  return size;
};

const listPrefix = async (s3: S3Client, prefix: string): Promise<BackupObject[]> => {
  const out: BackupObject[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.AWS_S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const o of page.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
    }
    token = page.NextContinuationToken;
  } while (token);
  return out;
};

export interface RetentionReport {
  dry_run: boolean;
  dailies: number;
  monthlies: number;
  monthly_copied: string[];
  daily_pruned: number;
  monthly_pruned: number;
  undated: string[];
  newest_monthly: string | null;
}

/**
 * Keep the first backup of each month under MONTHLY_SUBFOLDER, then prune both
 * prefixes. Runs only after a backup has been uploaded AND verified, so a
 * period in which backups fail can never prune anything.
 */
export const applyRetention = async (s3: S3Client): Promise<RetentionReport> => {
  const dailyPrefix = prefixOf(env.BUCKET_SUBFOLDER);
  const monthlyPrefix = prefixOf(env.MONTHLY_SUBFOLDER);
  if (!monthlyPrefix || monthlyPrefix === dailyPrefix) {
    throw new Error("MONTHLY_SUBFOLDER must be set and differ from BUCKET_SUBFOLDER");
  }
  const now = new Date();
  const daily = dated(await listPrefix(s3, dailyPrefix));
  const monthly = dated(await listPrefix(s3, monthlyPrefix));

  const copies = planMonthlyCopies(
    daily.dated,
    monthly.dated,
    now,
    env.MONTHLY_RETENTION_DAYS,
  );
  const copied: string[] = [];
  for (const c of copies) {
    const target = monthlyPrefix + path.posix.basename(c.key);
    // Copies are made even in dry-run: they only ADD, and they must exist
    // and be checked before any daily they duplicate may be pruned.
    await s3.send(
      new CopyObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        CopySource: encodeURI(`${env.AWS_S3_BUCKET}/${c.key}`),
        Key: target,
      }),
    );
    await verifyObject(s3, target, c.size);
    copied.push(target);
    monthly.dated.push({ ...c, key: target });
  }
  monthly.dated.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());

  const dailyPrune = planPrune(daily.dated, now, env.RETENTION_DAYS, MIN_DAILIES_KEPT);
  const monthlyPrune = planPrune(
    monthly.dated,
    now,
    env.MONTHLY_RETENTION_DAYS,
    MIN_MONTHLIES_KEPT,
  );
  const doomed = [...dailyPrune, ...monthlyPrune];
  console.log(
    `Retention: ${daily.dated.length} dailies, ${monthly.dated.length} monthlies; ` +
      `copied ${copied.length} monthly; ` +
      `${env.PRUNE_DRY_RUN ? "WOULD prune" : "pruning"} ${dailyPrune.length} daily + ` +
      `${monthlyPrune.length} monthly`,
  );
  for (const d of doomed) {
    if (env.PRUNE_DRY_RUN) {
      console.log(`  would delete ${d.key}`);
      continue;
    }
    await s3.send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: d.key }));
  }
  const undated = [...daily.undated, ...monthly.undated].map((o) => o.key);
  if (undated.length) console.log("Retention: not dated, never pruned:", undated);
  return {
    dry_run: env.PRUNE_DRY_RUN,
    dailies: daily.dated.length - (env.PRUNE_DRY_RUN ? 0 : dailyPrune.length),
    monthlies: monthly.dated.length - (env.PRUNE_DRY_RUN ? 0 : monthlyPrune.length),
    monthly_copied: copied,
    daily_pruned: env.PRUNE_DRY_RUN ? 0 : dailyPrune.length,
    monthly_pruned: env.PRUNE_DRY_RUN ? 0 : monthlyPrune.length,
    undated,
    newest_monthly: monthly.dated.slice(-1)[0]?.key ?? null,
  };
};

export interface BackupResult {
  key: string;
  bytes: number;
  retention: RetentionReport | null;
  retention_error: string | null;
}

export const backup = async (): Promise<BackupResult> => {
  console.log("Initiating DB backup...");
  const timestamp = new Date().toISOString().replace(/[:.]+/g, "-");
  const filename = `${env.BACKUP_FILE_PREFIX}-${timestamp}.tar.gz`;
  const filePath = path.join(os.tmpdir(), filename);
  const key = prefixOf(env.BUCKET_SUBFOLDER) + filename;
  const s3 = client();
  try {
    const bytes = await dumpToFile(filePath);
    await uploadToS3(s3, key, filePath);
    await verifyObject(s3, key, bytes);
    console.log(`Backup verified in R2: ${key} (${filesize(bytes)})`);

    // A retention failure must not turn a good backup into a failed one -
    // it is reported separately and alerted on by the app.
    let retention: RetentionReport | null = null;
    let retentionError: string | null = null;
    try {
      retention = await applyRetention(s3);
    } catch (e) {
      retentionError = e instanceof Error ? e.message : String(e);
      console.error("Retention failed:", retentionError);
    }
    console.log("DB backup complete...");
    return { key, bytes, retention, retention_error: retentionError };
  } finally {
    try {
      unlinkSync(filePath);
    } catch {
      // already gone
    }
  }
};
