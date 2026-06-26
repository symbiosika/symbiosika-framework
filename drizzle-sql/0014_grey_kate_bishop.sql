ALTER TABLE "base_jobs" ADD COLUMN "scheduled_at" timestamp;--> statement-breakpoint
CREATE INDEX "jobs_scheduled_at_idx" ON "base_jobs" USING btree ("scheduled_at");