/**
 * Chunk-Kontext einer Seite: der Chunk an `order` plus seine Nachbarn
 * (davor/danach), in Lesereihenfolge. Erlaubt einem Agenten, den Kontext
 * nachzuladen, den ein einzelner Such-Snippet verloren hat.
 *
 * Die Chunks gehören zum knowledge_entry, in den die Seite bei aktiviertem
 * Embedding gespiegelt wird (knowledgeText.knowledgeEntryId). Die
 * knowledgeEntryId wird aus der sichtbaren Seite abgeleitet — Sichtbarkeit
 * der Seite == Sichtbarkeit ihrer Chunks.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeChunks } from "../db/schema/knowledge";
import { getKnowledgeTextById } from "./knowledge-texts";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

export type PageChunkContextItem = {
  order: number;
  header: string | null;
  text: string;
  /** source page number (PDF), when known */
  sourcePage: number | null;
  /** true für den per `order` adressierten Chunk (der Treffer), false für Nachbarn */
  matched: boolean;
};

export type PageChunkContext = {
  pageId: string;
  title: string;
  /** null, wenn die Seite keine Embeddings hat (nicht gechunkt) */
  knowledgeEntryId: string | null;
  /** Gesamtzahl der Chunks des knowledge_entry (Grenzen für den Agenten) */
  totalChunks: number;
  chunks: PageChunkContextItem[];
};

const DEFAULT_BEFORE = 2;
const DEFAULT_AFTER = 2;
const MAX_SPAN = 20; // Kappe pro Seite, damit ein Aufruf den Kontext nicht sprengt

export const getPageChunkContext = async (
  pageId: string,
  context: Context,
  options: { order?: number; before?: number; after?: number } = {}
): Promise<PageChunkContext> => {
  // Permission-Check + verknüpften knowledge_entry auflösen (wirft, wenn unsichtbar)
  const page = await getKnowledgeTextById(pageId, context);
  const base = { pageId: page.id, title: page.title };

  if (!page.knowledgeEntryId) {
    // Seite ohne Embeddings: keine Chunks vorhanden
    return { ...base, knowledgeEntryId: null, totalChunks: 0, chunks: [] };
  }

  const before = Math.min(
    Math.max(options.before ?? DEFAULT_BEFORE, 0),
    MAX_SPAN
  );
  const after = Math.min(Math.max(options.after ?? DEFAULT_AFTER, 0), MAX_SPAN);
  const center = options.order ?? 0;

  const countRows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.knowledgeEntryId, page.knowledgeEntryId));
  const totalChunks = countRows[0]?.count ?? 0;

  const rows = await getDb()
    .select({
      order: knowledgeChunks.order,
      header: knowledgeChunks.header,
      text: knowledgeChunks.text,
      meta: knowledgeChunks.meta,
    })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.knowledgeEntryId, page.knowledgeEntryId),
        gte(knowledgeChunks.order, center - before),
        lte(knowledgeChunks.order, center + after)
      )
    )
    .orderBy(asc(knowledgeChunks.order));

  return {
    ...base,
    knowledgeEntryId: page.knowledgeEntryId,
    totalChunks,
    chunks: rows.map((r) => ({
      order: r.order,
      header: r.header,
      text: r.text,
      sourcePage: r.meta?.page ?? null,
      matched: r.order === center,
    })),
  };
};
