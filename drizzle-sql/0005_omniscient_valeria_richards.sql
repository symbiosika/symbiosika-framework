DELETE FROM "base_connections";
ALTER TABLE "base_connections" ALTER COLUMN "initiated_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "base_connections" ALTER COLUMN "initiated_by" SET DEFAULT 'local'::text;--> statement-breakpoint
DROP TYPE "public"."initiated_by";--> statement-breakpoint
CREATE TYPE "public"."initiated_by" AS ENUM('local', 'remote');--> statement-breakpoint
ALTER TABLE "base_connections" ALTER COLUMN "initiated_by" SET DEFAULT 'local'::"public"."initiated_by";--> statement-breakpoint
ALTER TABLE "base_connections" ALTER COLUMN "initiated_by" SET DATA TYPE "public"."initiated_by" USING "initiated_by"::"public"."initiated_by";