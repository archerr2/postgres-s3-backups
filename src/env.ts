import { envsafe, str, bool, num } from "envsafe";

export const env = envsafe({
  AWS_ACCESS_KEY_ID: str(),
  AWS_SECRET_ACCESS_KEY: str(),
  AWS_S3_BUCKET: str(),
  AWS_S3_REGION: str(),
  BACKUP_DATABASE_URL: str({
    desc: 'The connection string of the database to backup.'
  }),
  // REQUIRED, no default. Until 2026-10-02 this defaulted to '0 5 * * *' and the
  // service carried BACKUP_SCHEDULE - a name nothing read - so the schedule
  // that ran was the default and the variable that looked like it controlled
  // it did nothing. A missing schedule now stops the service at startup.
  BACKUP_CRON_SCHEDULE: str({
    desc: 'The cron schedule to run the backup on.',
  }),
  AWS_S3_ENDPOINT: str({
    desc: 'The S3 custom endpoint you want to use.',
    default: '',
    allowEmpty: true,
  }),
  AWS_S3_FORCE_PATH_STYLE: bool({
    desc: 'Use path style for the endpoint instead of the default subdomain style, useful for MinIO',
    default: false,
    allowEmpty: true
  }),
  RUN_ON_STARTUP: bool({
    desc: 'Run a backup on startup of this application',
    default: false,
    allowEmpty: true,
  }),
  BACKUP_FILE_PREFIX: str({
    desc: 'Prefix to the file name',
    default: 'backup',
  }),
  BUCKET_SUBFOLDER: str({
    desc: 'A subfolder to place the backup files in',
    default: '',
    allowEmpty: true
  }),
  SINGLE_SHOT_MODE: bool({
    desc: 'Run a single backup on start and exit when completed',
    default: false,
    allowEmpty: true,
  }),
  // This is both time consuming and resource intensive so we leave it disabled by default
  SUPPORT_OBJECT_LOCK: bool({
    desc: 'Enables support for buckets with object lock by providing an MD5 hash with the backup file',
    default: false
  }),
  // Retention (src/retention.ts). REQUIRED: RETENTION_DAYS was set on this
  // service for months and read by nothing, so every backup was kept.
  RETENTION_DAYS: num({
    desc: 'Days to keep daily backups under BUCKET_SUBFOLDER.',
  }),
  MONTHLY_RETENTION_DAYS: num({
    desc: 'Days to keep the monthly copy (first backup of each month).',
  }),
  MONTHLY_SUBFOLDER: str({
    desc: 'Prefix holding the monthly copies; must differ from BUCKET_SUBFOLDER.',
  }),
  // Deleting backups is irreversible, so the safe direction is the default:
  // retention only reports what it WOULD delete until this is set to false.
  PRUNE_DRY_RUN: bool({
    desc: 'Report retention deletions without making them.',
    default: true,
  }),
  BACKUP_OPTIONS: str({
    desc: 'Any valid pg_dump option.',
    default: '',
    allowEmpty: true,
  }),
})
