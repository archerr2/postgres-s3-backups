// Record each backup's outcome in the dashboard database's job_heartbeat, so
// the app can alert when no verified backup has landed (backend
// services/backup_monitor.py). Written with psql - already in this image for
// pg_dump - so no driver dependency is added.
//
// The row is ('db_backup', '') - store_id '' is the dashboard's sentinel for a
// global job. last_success_at only moves on a VERIFIED upload.
import { spawn } from "child_process";
import { env } from "./env.js";

const SQL = `
INSERT INTO job_heartbeat
    (job_name, store_id, last_run_at, last_success_at, last_status, last_error,
     runs, updated_at, metadata)
VALUES ('db_backup', '', now(),
        CASE WHEN :'status' = 'success' THEN now() END,
        :'status', NULLIF(:'err', ''), 1, now(), :'meta'::jsonb)
ON CONFLICT (job_name, store_id) DO UPDATE SET
    last_run_at = now(),
    last_success_at = COALESCE(EXCLUDED.last_success_at, job_heartbeat.last_success_at),
    last_status = EXCLUDED.last_status,
    last_error = EXCLUDED.last_error,
    runs = job_heartbeat.runs + 1,
    updated_at = now(),
    metadata = EXCLUDED.metadata;
`;

/** Resolves true when the row was written; never throws. */
export const recordHeartbeat = (
  status: "success" | "failed",
  metadata: object,
  error = "",
): Promise<boolean> =>
  new Promise((resolve) => {
    const psql = spawn(
      "psql",
      [
        env.BACKUP_DATABASE_URL,
        "-X",
        "-q",
        "-v", "ON_ERROR_STOP=1",
        "-v", `status=${status}`,
        "-v", `err=${error.slice(0, 2000)}`,
        "-v", `meta=${JSON.stringify(metadata)}`,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    psql.stderr.on("data", (c) => (stderr += c.toString()));
    psql.on("error", (e) => {
      console.error("Heartbeat not recorded:", e.message);
      resolve(false);
    });
    psql.on("close", (code) => {
      if (code !== 0) console.error("Heartbeat not recorded:", stderr.trim());
      resolve(code === 0);
    });
    psql.stdin.end(SQL);
  });
