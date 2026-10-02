// Retention planning: pure functions, no I/O, so the rules that decide what is
// deleted are testable without a bucket (src/retention.test.ts).
//
// Two prefixes:
//   daily   - every backup, kept RETENTION_DAYS
//   monthly - a copy of the FIRST backup of each calendar month, kept
//             MONTHLY_RETENTION_DAYS
//
// A backup's date is read from its FILENAME (dashboard--2026-10-01T05-00-00-101Z
// .tar.gz), never from LastModified: a monthly copy made today of a January
// backup has today's LastModified, and expiring it by that would keep January
// for another year. An object whose name carries no date is never deleted -
// it is reported instead.

export interface BackupObject {
  key: string;
  size: number;
}

export interface DatedBackup extends BackupObject {
  takenAt: Date;
}

const STAMP = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;

export function backupDate(key: string): Date | null {
  const m = STAMP.exec(key);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isNaN(t) ? null : new Date(t);
}

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function dated(objects: BackupObject[]): {
  dated: DatedBackup[];
  undated: BackupObject[];
} {
  const out: DatedBackup[] = [];
  const undated: BackupObject[] = [];
  for (const o of objects) {
    const takenAt = backupDate(o.key);
    if (takenAt) out.push({ ...o, takenAt });
    else undated.push(o);
  }
  out.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  return { dated: out, undated };
}

const DAY_MS = 86_400_000;

/**
 * Monthly copies that should exist and do not: for each month that has a daily
 * backup, the earliest one, unless that month already has a monthly copy or
 * the backup is too old to be kept as a monthly anyway.
 */
export function planMonthlyCopies(
  dailies: DatedBackup[],
  monthlies: DatedBackup[],
  now: Date,
  monthlyRetentionDays: number,
): DatedBackup[] {
  const have = new Set(monthlies.map((m) => monthOf(m.takenAt)));
  const firstOfMonth = new Map<string, DatedBackup>();
  for (const d of dailies) {
    const m = monthOf(d.takenAt);
    if (!firstOfMonth.has(m)) firstOfMonth.set(m, d); // dailies are sorted
  }
  const cutoff = now.getTime() - monthlyRetentionDays * DAY_MS;
  return [...firstOfMonth.entries()]
    .filter(([m, d]) => !have.has(m) && d.takenAt.getTime() >= cutoff)
    .map(([, d]) => d);
}

/**
 * Objects older than `retentionDays`, except that the newest `minKeep` are
 * never deleted whatever their age - so a long gap in backups can never prune
 * a prefix down to nothing.
 */
export function planPrune(
  objects: DatedBackup[],
  now: Date,
  retentionDays: number,
  minKeep: number,
): DatedBackup[] {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const protectedKeys = new Set(objects.slice(-minKeep).map((o) => o.key));
  return objects.filter(
    (o) => o.takenAt.getTime() < cutoff && !protectedKeys.has(o.key),
  );
}
