import "server-only";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlInList, timestamps, tstz } from "./columns";
import { orders } from "./commerce";
import {
  alertSeverityEnum,
  EMAIL_MESSAGE_STATUSES,
  type EmailMessageStatus,
  jobKindEnum,
  jobStatusEnum,
  localeEnum,
  SETTINGS_KEYS,
  type SettingsKey,
} from "./enums";

/** Transactional outbox (emails, tax documents, refunds). Payload holds ids only. */
export const outboxJobs = pgTable(
  "outbox_jobs",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: jobKindEnum().notNull(),
    dedupeKey: text().notNull().unique("outbox_jobs_dedupe_key_unique"),
    payload: jsonb().notNull().default({}),
    status: jobStatusEnum().notNull().default("PENDING"),
    attempts: integer().notNull().default(0),
    runAfter: tstz().notNull().defaultNow(),
    lockedUntil: tstz(),
    lastError: text(),
    doneAt: tstz(),
    ...timestamps,
  },
  (t) => [
    check("outbox_jobs_attempts_nonnegative", sql`${t.attempts} >= 0`),
    index("outbox_jobs_status_run_after_idx").on(t.status, t.runAfter),
  ],
);

export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    dedupeKey: text().notNull().unique("email_messages_dedupe_key_unique"),
    template: text().notNull(),
    toEmail: text().notNull(),
    locale: localeEnum().notNull(),
    subject: text().notNull(),
    driver: text().notNull(),
    providerMessageId: text(),
    status: text().$type<EmailMessageStatus>().notNull().default("PENDING"),
    /** Log driver only; purged after 30 days. */
    html: text(),
    text: text(),
    /** Attachment metadata (file keys, names, sizes), never bytes. */
    attachments: jsonb(),
    orderId: uuid().references(() => orders.id, { onDelete: "restrict" }),
    sentAt: tstz(),
    error: text(),
    ...timestamps,
  },
  (t) => [
    check(
      "email_messages_status_values",
      sql`${t.status} IN (${sqlInList(EMAIL_MESSAGE_STATUSES)})`,
    ),
    index("email_messages_order_idx").on(t.orderId),
    index("email_messages_created_idx").on(t.createdAt),
  ],
);

export const adminAlerts = pgTable(
  "admin_alerts",
  {
    id: uuid().primaryKey().defaultRandom(),
    severity: alertSeverityEnum().notNull(),
    kind: text().notNull(),
    entity: text(),
    entityId: text(),
    params: jsonb().notNull().default({}),
    dedupeKey: text().notNull().unique("admin_alerts_dedupe_key_unique"),
    acknowledgedAt: tstz(),
    acknowledgedBy: text(),
    ...timestamps,
  },
  (t) => [
    index("admin_alerts_open_idx")
      .on(t.severity, t.createdAt)
      .where(sql`${t.acknowledgedAt} IS NULL`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz().notNull().defaultNow(),
    actor: text().notNull(),
    action: text().notNull(),
    entity: text().notNull(),
    entityId: text(),
    before: jsonb(),
    /** Redacted. */
    after: jsonb(),
    ipHash: text(),
    ...timestamps,
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entity, t.entityId, t.at),
    index("audit_log_at_idx").on(t.at),
  ],
);

/** Postgres fixed-window rate limiter (`security/rate-limit.ts`). Distinct from Better Auth's `rate_limit`. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text().notNull(),
    windowStart: tstz().notNull(),
    count: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    primaryKey({
      name: "rate_limits_pk",
      columns: [t.key, t.windowStart],
    }),
    check("rate_limits_count_nonnegative", sql`${t.count} >= 0`),
    index("rate_limits_window_idx").on(t.windowStart),
  ],
);

/** Zod-validated JSONB rows (`settings/schemas.ts`). */
export const settings = pgTable(
  "settings",
  {
    key: text().$type<SettingsKey>().primaryKey(),
    value: jsonb().notNull(),
    updatedBy: text(),
    ...timestamps,
  },
  (t) => [
    check(
      "settings_key_values",
      sql`${t.key} IN (${sqlInList(SETTINGS_KEYS)})`,
    ),
  ],
);

export const cronRuns = pgTable(
  "cron_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    job: text().notNull(),
    startedAt: tstz().notNull().defaultNow(),
    finishedAt: tstz(),
    ok: boolean(),
    stats: jsonb(),
    error: text(),
    ...timestamps,
  },
  (t) => [index("cron_runs_job_started_idx").on(t.job, t.startedAt.desc())],
);

export type OutboxJob = typeof outboxJobs.$inferSelect;
export type NewOutboxJob = typeof outboxJobs.$inferInsert;
export type EmailMessage = typeof emailMessages.$inferSelect;
export type AdminAlert = typeof adminAlerts.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type CronRun = typeof cronRuns.$inferSelect;
