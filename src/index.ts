import { CronJob } from "cron";
import { backup } from "./backup.js";
import { env } from "./env.js";
import { recordHeartbeat } from "./heartbeat.js";

console.log("NodeJS Version: " + process.version);
console.log(
  `Schedule ${env.BACKUP_CRON_SCHEDULE}; retention ${env.RETENTION_DAYS}d daily, ` +
    `${env.MONTHLY_RETENTION_DAYS}d monthly; prune ${env.PRUNE_DRY_RUN ? "DRY RUN" : "LIVE"}`,
);

const tryBackup = async () => {
  try {
    const result = await backup();
    await recordHeartbeat("success", {
      ...result,
      schedule: env.BACKUP_CRON_SCHEDULE,
      retention_days: env.RETENTION_DAYS,
      monthly_retention_days: env.MONTHLY_RETENTION_DAYS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error while running backup: ", message);
    const recorded = await recordHeartbeat(
      "failed",
      { schedule: env.BACKUP_CRON_SCHEDULE },
      message,
    );
    // The app alerts on a recorded failure within minutes. If the failure
    // could not even be recorded (the database is unreachable or the
    // credential is wrong), exit instead: Railway's restarts then end in a
    // Crashed deployment, which its webhook reports. Either way it is seen.
    if (!recorded) process.exit(1);
  }
};

if (env.RUN_ON_STARTUP || env.SINGLE_SHOT_MODE) {
  console.log("Running on start backup...");
  await tryBackup();
  if (env.SINGLE_SHOT_MODE) {
    console.log("Database backup complete, exiting...");
    process.exit(0);
  }
}

const job = new CronJob(env.BACKUP_CRON_SCHEDULE, async () => {
  await tryBackup();
});

job.start();

console.log("Backup cron scheduled...");
