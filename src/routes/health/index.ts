/**
 * Health check routes.
 *
 * - GET /health        Public liveness probe for Coolify / docker / load balancers.
 *                      Stays lightweight (no dependency checks) so it answers
 *                      immediately on container start, even before the DB is ready.
 * - GET /health/detail Readiness probe behind login. Reports DB, SMTP and
 *                      job-queue status. Returns 503 when a dependency is down.
 *
 * Both are registered at the root (not under the versioned API basePath) because
 * infra health checks conventionally target a fixed top-level path.
 */

import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { describeRoute, resolver } from "hono-openapi";
import * as v from "valibot";
import { sql } from "drizzle-orm";
import { getDb } from "../../lib/db/db-connection";
import { jobs, type JobStatus } from "../../lib/db/schema/jobs";
import { smtpService } from "../../lib/email";
import { isJobQueueRunning } from "../../lib/jobs";
import { authAndSetUsersInfo } from "../../lib/utils/hono-middlewares";
import log from "../../lib/log";

const componentStatusSchema = v.object({
  status: v.picklist(["up", "down"]),
  latencyMs: v.nullable(v.number()),
  error: v.nullable(v.string()),
});

const healthDetailSchema = v.object({
  status: v.picklist(["ok", "degraded"]),
  checkedAt: v.string(),
  components: v.object({
    database: componentStatusSchema,
    smtp: componentStatusSchema,
    jobQueue: v.object({
      status: v.picklist(["up", "down"]),
      running: v.boolean(),
      counts: v.record(v.string(), v.number()),
    }),
  }),
});

/**
 * Run a check and capture status + latency, never throwing.
 */
async function timedCheck(
  fn: () => Promise<boolean>
): Promise<{ status: "up" | "down"; latencyMs: number; error: string | null }> {
  const start = Date.now();
  try {
    const ok = await fn();
    return {
      status: ok ? "up" : "down",
      latencyMs: Date.now() - start,
      error: ok ? null : "check returned false",
    };
  } catch (e) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export default function defineHealthRoute(app: SymbiosikaFrameworkHonoApp) {
  /**
   * Public liveness probe. No dependency checks - just confirms the process
   * is up and serving requests.
   */
  app.get(
    "/health",
    describeRoute({
      tags: ["admin"],
      summary: "Public liveness health check",
      responses: {
        200: {
          description: "Service is up",
          content: {
            "application/json": {
              schema: resolver(v.object({ status: v.literal("ok") })),
            },
          },
        },
      },
    }),
    (c) => c.json({ status: "ok" as const })
  );

  /**
   * Detailed readiness probe behind authentication.
   * Reports DB / SMTP / job-queue status.
   */
  app.get(
    "/health/detail",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["admin"],
      summary: "Detailed health check (DB / SMTP / job queue)",
      responses: {
        200: {
          description: "All components healthy",
          content: {
            "application/json": { schema: resolver(healthDetailSchema) },
          },
        },
        503: {
          description: "One or more components are unhealthy",
          content: {
            "application/json": { schema: resolver(healthDetailSchema) },
          },
        },
      },
    }),
    async (c) => {
      // Database: simple round-trip query.
      const database = await timedCheck(async () => {
        await getDb().execute(sql`select 1`);
        return true;
      });

      // SMTP: verify transporter connection (always true in console mode).
      const smtp = await timedCheck(() => smtpService.verifyConnection());

      // Job queue: report whether the queue loop runs and current job counts.
      const running = isJobQueueRunning();
      const counts: Record<string, number> = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
      };
      try {
        const rows = await getDb()
          .select({
            status: jobs.status,
            count: sql<number>`count(*)::int`,
          })
          .from(jobs)
          .groupBy(jobs.status);
        for (const row of rows) {
          counts[row.status as JobStatus] = Number(row.count);
        }
      } catch (e) {
        log.error(`Health check: failed to read job counts: ${e}`);
      }

      const components = {
        database,
        smtp,
        jobQueue: {
          status: (running ? "up" : "down") as "up" | "down",
          running,
          counts,
        },
      };

      const healthy =
        database.status === "up" &&
        smtp.status === "up" &&
        components.jobQueue.status === "up";

      const body = {
        status: (healthy ? "ok" : "degraded") as "ok" | "degraded",
        checkedAt: new Date().toISOString(),
        components,
      };

      return c.json(body, healthy ? 200 : 503);
    }
  );
}
