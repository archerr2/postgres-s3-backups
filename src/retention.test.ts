// node --test dist/  (after `npm run build`)
//
// MUTATIONS (run 2026-10-02, each fails the named test):
//   - expire monthlies by copy time instead of the filename date
//       -> "a monthly copy is dated by its backup, not its copy"
//   - minKeep ignored in planPrune
//       -> "never prunes below minKeep, however old"
//   - an undated key treated as epoch (deletable)
//       -> "an undated object is never planned for deletion"
//   - an existing monthly not consulted
//       -> "does not copy a month that already has a monthly"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backupDate,
  dated,
  planMonthlyCopies,
  planPrune,
} from "./retention.js";

const key = (iso: string) =>
  `postgres-backups/dashboard--${iso.replace(/[:.]/g, "-")}.tar.gz`;
const obj = (iso: string) => ({ key: key(iso), size: 1 });
const NOW = new Date("2026-10-02T06:00:00Z");

test("backupDate reads the filename stamp", () => {
  assert.equal(
    backupDate(key("2026-10-01T05:00:00.101Z"))?.toISOString(),
    "2026-10-01T05:00:00.000Z",
  );
  assert.equal(backupDate("postgres-backups/notes.txt"), null);
});

test("an undated object is never planned for deletion", () => {
  const { dated: d, undated } = dated([
    obj("2026-01-29T05:00:00.000Z"),
    { key: "postgres-backups/manual.tar.gz", size: 1 },
  ]);
  assert.equal(undated.length, 1);
  const pruned = planPrune(d, NOW, 35, 0).map((o) => o.key);
  assert.ok(!pruned.includes("postgres-backups/manual.tar.gz"));
});

test("prunes dailies older than the retention window", () => {
  const { dated: d } = dated([
    obj("2026-08-20T05:00:00.000Z"),
    obj("2026-08-27T05:00:00.000Z"),
    obj("2026-08-29T05:00:00.000Z"),
    obj("2026-10-01T05:00:00.000Z"),
  ]);
  const pruned = planPrune(d, NOW, 35, 1).map((o) => o.takenAt.toISOString());
  assert.deepEqual(pruned, [
    "2026-08-20T05:00:00.000Z",
    "2026-08-27T05:00:00.000Z",
  ]);
});

test("never prunes below minKeep, however old", () => {
  // Backups stopped in June: everything is past retention.
  const { dated: d } = dated([
    obj("2026-06-01T05:00:00.000Z"),
    obj("2026-06-02T05:00:00.000Z"),
    obj("2026-06-03T05:00:00.000Z"),
  ]);
  assert.equal(planPrune(d, NOW, 35, 7).length, 0);
  assert.equal(planPrune(d, NOW, 35, 2).length, 1);
});

test("copies the first backup of each month", () => {
  const { dated: d } = dated([
    obj("2026-09-01T05:00:00.000Z"),
    obj("2026-09-02T05:00:00.000Z"),
    obj("2026-10-01T05:00:00.000Z"),
  ]);
  const plan = planMonthlyCopies(d, [], NOW, 365).map((o) =>
    o.takenAt.toISOString(),
  );
  assert.deepEqual(plan, [
    "2026-09-01T05:00:00.000Z",
    "2026-10-01T05:00:00.000Z",
  ]);
});

test("does not copy a month that already has a monthly", () => {
  const { dated: d } = dated([obj("2026-10-01T05:00:00.000Z")]);
  const { dated: m } = dated([
    {
      key: "postgres-backups-monthly/dashboard--2026-10-01T05-00-00-101Z.tar.gz",
      size: 1,
    },
  ]);
  assert.equal(planMonthlyCopies(d, m, NOW, 365).length, 0);
});

test("does not copy a month already past monthly retention", () => {
  const { dated: d } = dated([obj("2025-09-01T05:00:00.000Z")]);
  assert.equal(planMonthlyCopies(d, [], NOW, 365).length, 0);
});

test("a monthly copy is dated by its backup, not its copy", () => {
  // A January backup copied today must still expire a year after JANUARY.
  const { dated: m } = dated([
    {
      key: "postgres-backups-monthly/dashboard--2025-09-01T05-00-00-000Z.tar.gz",
      size: 1,
    },
    {
      key: "postgres-backups-monthly/dashboard--2026-10-01T05-00-00-000Z.tar.gz",
      size: 1,
    },
  ]);
  const pruned = planPrune(m, NOW, 365, 1).map((o) => o.takenAt.getUTCFullYear());
  assert.deepEqual(pruned, [2025]);
});
