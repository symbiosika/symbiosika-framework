import { sql } from "drizzle-orm";
import {
  pgEnum,
  text,
  timestamp,
  uuid,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants, users } from "./users";
import { pgBaseTable } from ".";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export type JobStatus = "pending" | "running" | "completed" | "failed";

// Table for jobs. Jobs are long running tasks that are executed by the system.
export const jobs = pgBaseTable(
  "jobs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, {
        onDelete: "cascade",
      })
      .notNull(),
    type: text("type").notNull(),
    status: jobStatusEnum("status").notNull().default("pending"),
    metadata: jsonb("metadata"),
    result: jsonb("result"),
    error: jsonb("error"),
    // Earliest point in time at which a pending job may be picked up by the
    // worker. When null the job is eligible for execution immediately. Use this
    // to schedule/delay queue entries (e.g. "run not before X").
    scheduledAt: timestamp("scheduled_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (jobs) => [
    index("jobs_created_at_idx").on(jobs.createdAt),
    index("jobs_user_id_idx").on(jobs.userId),
    index("jobs_status_idx").on(jobs.status),
    index("jobs_scheduled_at_idx").on(jobs.scheduledAt),
  ]
);

export const jobsRelations = relations(jobs, ({ one }) => ({
  user: one(users, {
    fields: [jobs.userId],
    references: [users.id],
  }),
}));

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

export const jobsSelectSchema = createSelectSchema(jobs);
export const jobsInsertSchema = createInsertSchema(jobs);
export const jobsUpdateSchema = createUpdateSchema(jobs);
