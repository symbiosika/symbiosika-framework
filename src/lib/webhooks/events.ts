/**
 * Central, code-side registry of the events an outgoing webhook can subscribe
 * to. This is the single source of truth for "which events exist".
 *
 * Why a registry instead of a database enum: adding a new event is now a code
 * change here (plus a `dispatchEvent(...)` call at the source of the event) and
 * needs NO database migration. The `webhooks.event` column is plain text and is
 * validated against this map on write.
 *
 * Event naming convention: `<domain>.<action>` (lower snake domain, dot,
 * verb in past tense), e.g. `knowledge_text.created`.
 */

export const WEBHOOK_EVENTS = {
  /** A chat/agent produced output (legacy; historically "chat-output"). */
  "chat.output": {
    description: "A chat or agent produced an output message.",
  },
  /** A wiki knowledge page (knowledge_text) was created. */
  "knowledge_text.created": {
    description: "A knowledge (wiki) page was created.",
  },
  /** A wiki knowledge page (knowledge_text) had its content/metadata changed. */
  "knowledge_text.updated": {
    description: "A knowledge (wiki) page was updated.",
  },
  /** A wiki knowledge page (knowledge_text) was deleted. */
  "knowledge_text.deleted": {
    description: "A knowledge (wiki) page was deleted.",
  },
} as const;

export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

/**
 * Legacy/friendly event aliases → canonical event name.
 *
 * - `chat-output` is the value historically stored in the pgEnum column, kept
 *   working so existing webhook rows and n8n registrations do not break.
 * - the `...Created/Updated/Deleted` camelCase forms are what the n8n register
 *   endpoint accepts as `event`, mirroring the existing `chatOutput`/`tool`
 *   friendly names.
 */
const EVENT_ALIASES: Record<string, WebhookEvent> = {
  "chat-output": "chat.output",
  chatOutput: "chat.output",
  knowledgeTextCreated: "knowledge_text.created",
  knowledgeTextUpdated: "knowledge_text.updated",
  knowledgeTextDeleted: "knowledge_text.deleted",
};

/**
 * Resolve a stored/friendly event string to its canonical event name, or
 * return null if it is not a known event. Accepts canonical names, the legacy
 * `chat-output` value, and the camelCase register aliases.
 */
export const resolveWebhookEvent = (event: string): WebhookEvent | null => {
  if (event in WEBHOOK_EVENTS) {
    return event as WebhookEvent;
  }
  return EVENT_ALIASES[event] ?? null;
};

/** Type guard: is this string a canonical, known webhook event? */
export const isKnownWebhookEvent = (event: string): event is WebhookEvent =>
  event in WEBHOOK_EVENTS;

/** All canonical event names, e.g. for validation error messages / docs. */
export const ALL_WEBHOOK_EVENTS = Object.keys(
  WEBHOOK_EVENTS
) as WebhookEvent[];
