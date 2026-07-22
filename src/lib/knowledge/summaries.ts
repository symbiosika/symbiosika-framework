/**
 * AI page summaries: the "docstring" of every knowledge page.
 *
 * A short (1-2 sentence) description is stored per page and delivered in all
 * list-type responses, so an agent can tell similar pages apart without
 * opening them.
 *
 * Generation is decoupled from saving (debounce, not save-trigger):
 *   1. A content write only sets `summaryStale = true` (cheap, no LLM). See the
 *      write paths in knowledge-texts.ts / knowledge-text-blocks.ts.
 *   2. A per-minute cron sweeper (`sweepStaleSummaries`) finds pages that have
 *      been stale AND quiet for the configured debounce window (default 60 min,
 *      overridable at runtime via the app-config key
 *      `knowledge_summary_debounce_minutes`) and enqueues one durable job per page.
 *      Every new save pushes `updatedAt`
 *      forward, so a page is only picked up once editing has actually stopped —
 *      one generation per editing session, regardless of autosave frequency.
 *   3. The job (`knowledge:summarize`) regenerates the summary — but first compares a
 *      content hash and skips the LLM entirely if the content is unchanged
 *      (a save without edits, or a revert).
 *
 * The whole pipeline is gated on `isAiEnabled()` (a global LLM must be
 * configured) and, per tenant, on `knowledge.autoSummaries`. When either is off the
 * sweeper is a no-op and existing/manual summaries keep being served.
 */

import { and, eq, isNull, lte, sql, inArray } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import type { KnowledgeTextSelect } from "../db/schema/knowledge";
import { jobs } from "../db/schema/jobs";
import { createJob } from "../jobs";
import type { JobHandlerRegister } from "../jobs";
import { computeSourceHash } from "./source-hash";
import { generateText, isAiEnabled } from "../ai";
import { getAppSpecificData } from "../specific-data";
import { getKnowledgeTenantConfig } from "./knowledge-config";
import log from "../log";

/** Job type for the durable per-page summary generation. */
export const SUMMARY_JOB_TYPE = "knowledge:summarize";

/**
 * App-config key (in the global specific-data store) holding the summary
 * debounce window as `{ minutes: number }`. Tunable at runtime without a
 * redeploy; falls back to the default below when unset.
 */
export const SUMMARY_DEBOUNCE_CONFIG_KEY = "knowledge_summary_debounce_minutes";

/** Debounce default (minutes) when the app-config value is unset. */
export const DEFAULT_SUMMARY_DEBOUNCE_MINUTES = 60;

/** Read the configured summary debounce window (minutes) from app config. */
const getSummaryDebounceMinutes = async (): Promise<number> => {
  try {
    const row = await getAppSpecificData(SUMMARY_DEBOUNCE_CONFIG_KEY);
    const minutes = (row.data as { minutes?: unknown })?.minutes;
    return typeof minutes === "number" && Number.isFinite(minutes)
      ? minutes
      : DEFAULT_SUMMARY_DEBOUNCE_MINUTES;
  } catch {
    return DEFAULT_SUMMARY_DEBOUNCE_MINUTES;
  }
};

/** Above this content length the LLM gets a compressed excerpt, not full text. */
const INPUT_COMPRESSION_THRESHOLD = 24_000;
/** Hard cap on the compressed excerpt sent to the LLM. */
const INPUT_BUDGET = 8_000;
/** How many pages one sweep enqueues (throttles cost / queue depth). */
const SWEEP_BATCH_SIZE = 50;

/**
 * Optional cheaper model for summaries (a trivial task). When unset the
 * provider's configured default model is used.
 */
const summaryModelId = (): string | undefined =>
  process.env.KNOWLEDGE_SUMMARY_MODEL || undefined;

/** Stable content hash used to skip no-op regenerations. */
export const computeSummaryContentHash = (
  title: string,
  text: string
): string => computeSourceHash(`${title}\n\n${text}`);

/**
 * Build the LLM input for a summary. For a 1-2 sentence summary the model does
 * not need the whole page: over a length threshold we send a structured
 * excerpt (title + heading outline + intro + first line under each heading),
 * hard-capped to a fixed budget. This keeps the price per generation bounded
 * regardless of page length.
 */
export const buildSummaryInput = (title: string, text: string): string => {
  if (text.length <= INPUT_COMPRESSION_THRESHOLD) {
    return `# ${title}\n\n${text}`;
  }

  const lines = text.split("\n");
  const headings: string[] = [];
  const firstLineAfterHeading: string[] = [];
  let expectBody = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      headings.push(trimmed);
      expectBody = true;
    } else if (expectBody && trimmed.length > 0) {
      firstLineAfterHeading.push(trimmed);
      expectBody = false;
    }
  }

  const intro = text.slice(0, 1_500);
  const outline = headings.join("\n");
  const bodies = firstLineAfterHeading.join("\n");

  const parts = [
    `# ${title}`,
    "\n## Introduction\n",
    intro,
    "\n## Section outline\n",
    outline,
    "\n## Section leads\n",
    bodies,
  ];
  return parts.join("\n").slice(0, INPUT_BUDGET);
};

const SUMMARY_SYSTEM_PROMPT =
  "You write terse catalog descriptions for knowledge base pages. Given a page, respond " +
  "with a single 1-2 sentence summary of what the page is about and what a " +
  "reader would find on it. Be concrete and specific; name the topic. Do not " +
  "start with 'This page' or 'This document'. Write in the page's language. " +
  "Respond with the summary text only — no preamble, no quotes, no markdown.";

/** Token cap for the generated summary (1-2 sentences, keeps cost bounded). */
const SUMMARY_MAX_OUTPUT_TOKENS = 200;

/**
 * Generate a fresh summary string for a page via the configured LLM. Plain
 * text generation — the result is a single free-text sentence, so no JSON /
 * structured output is needed (which not every model supports reliably).
 * Assumes `isAiEnabled()` was already checked by the caller.
 */
export const generatePageSummary = async (page: {
  title: string;
  text: string;
}): Promise<string> => {
  const input = buildSummaryInput(page.title, page.text);
  const summary = await generateText({
    system: SUMMARY_SYSTEM_PROMPT,
    prompt: input,
    model: summaryModelId(),
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
  });
  return summary.trim();
};

/**
 * Process a single page's summary (the job body). Re-checks everything since
 * the page may have changed between enqueue and execution:
 *   - global LLM must be enabled, page must be `auto`, tenant must allow it
 *   - if the content hash is unchanged, clear the flag without an LLM call
 * Idempotent and safe to run more than once for the same page.
 */
export const processSummaryForPage = async (
  pageId: string,
  tenantId: string
): Promise<{ status: "generated" | "skipped" | "unchanged" }> => {
  const rows = await getDb()
    .select()
    .from(knowledgeText)
    .where(
      and(eq(knowledgeText.id, pageId), eq(knowledgeText.tenantId, tenantId))
    )
    .limit(1);
  const page = rows[0];
  if (!page || page.deletedAt) return { status: "skipped" };

  // Only auto pages are generated; manual/off are left untouched. Clear the
  // stale flag so we don't keep re-visiting them.
  if (page.summaryMode !== "auto") {
    if (page.summaryStale) await clearStale(pageId);
    return { status: "skipped" };
  }

  if (!isAiEnabled()) return { status: "skipped" };

  const tenantConfig = await getKnowledgeTenantConfig(tenantId);
  if (!tenantConfig.autoSummaries) return { status: "skipped" };

  const hash = computeSummaryContentHash(page.title, page.text);
  if (hash === page.summaryContentHash) {
    // Content unchanged since last generation (e.g. save with no edit, revert).
    if (page.summaryStale) await clearStale(pageId);
    return { status: "unchanged" };
  }

  // Empty pages get no summary (but the flag is cleared).
  if (page.text.trim().length === 0) {
    await getDb()
      .update(knowledgeText)
      .set({ summaryStale: false, summaryContentHash: hash })
      .where(eq(knowledgeText.id, pageId));
    return { status: "unchanged" };
  }

  const summary = await generatePageSummary(page);
  await getDb()
    .update(knowledgeText)
    .set({
      summary,
      summaryModel: summaryModelId() ?? "default",
      summaryContentHash: hash,
      summaryUpdatedAt: sql`now()`,
      summaryStale: false,
    })
    .where(eq(knowledgeText.id, pageId));

  return { status: "generated" };
};

const clearStale = async (pageId: string): Promise<void> => {
  await getDb()
    .update(knowledgeText)
    .set({ summaryStale: false })
    .where(eq(knowledgeText.id, pageId));
};

/** Durable job registration for per-page summary generation. */
export const summaryJobRegister: JobHandlerRegister = {
  type: SUMMARY_JOB_TYPE,
  handler: {
    execute: async (metadata: { pageId: string; tenantId: string }) => {
      return processSummaryForPage(metadata.pageId, metadata.tenantId);
    },
  },
};

/**
 * Cron body (run per minute): enqueue summary jobs for pages that are stale AND
 * have been quiet for the debounce window. No-op when no global LLM is
 * configured. Dedupes against pages that already have a pending/running job.
 */
export const sweepStaleSummaries = async (): Promise<{
  enqueued: number;
}> => {
  if (!isAiEnabled()) return { enqueued: 0 };

  const debounceMinutes = await getSummaryDebounceMinutes();

  const candidates = await getDb()
    .select({ id: knowledgeText.id, tenantId: knowledgeText.tenantId })
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.summaryStale, true),
        eq(knowledgeText.summaryMode, "auto"),
        isNull(knowledgeText.deletedAt),
        lte(
          knowledgeText.updatedAt,
          sql`now() - make_interval(mins => ${debounceMinutes})`
        )
      )
    )
    .orderBy(knowledgeText.updatedAt)
    .limit(SWEEP_BATCH_SIZE);

  if (candidates.length === 0) return { enqueued: 0 };

  // Skip pages that already have a queued/running summary job.
  const pending = await getDb()
    .select({ metadata: jobs.metadata })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, SUMMARY_JOB_TYPE),
        inArray(jobs.status, ["pending", "running"])
      )
    );
  const alreadyQueued = new Set(
    pending
      .map((j) => (j.metadata as { pageId?: string } | null)?.pageId)
      .filter((id): id is string => typeof id === "string")
  );

  let enqueued = 0;
  for (const c of candidates) {
    if (alreadyQueued.has(c.id)) continue;
    await createJob(
      SUMMARY_JOB_TYPE,
      { pageId: c.id, tenantId: c.tenantId },
      c.tenantId
    );
    enqueued++;
  }

  if (enqueued > 0) log.debug(`knowledge summary sweep: enqueued ${enqueued} page(s)`);
  return { enqueued };
};

/**
 * Backfill: flag existing pages that have no summary yet as stale, so the
 * normal sweeper pipeline generates them (naturally throttled by the sweep
 * batch size + job queue). Returns the number of pages flagged. Only touches
 * `auto` pages with a null summary.
 */
export const enqueueSummaryBackfill = async (
  tenantId: string
): Promise<{ flagged: number }> => {
  const updated = await getDb()
    .update(knowledgeText)
    .set({ summaryStale: true })
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        eq(knowledgeText.summaryMode, "auto"),
        isNull(knowledgeText.summary),
        isNull(knowledgeText.deletedAt)
      )
    )
    .returning({ id: knowledgeText.id });
  return { flagged: updated.length };
};

/** Fields to merge into a knowledgeText update when its content changed. */
export const summaryStaleOnContentChange = (): Pick<
  KnowledgeTextSelect,
  "summaryStale"
> => ({ summaryStale: true });
