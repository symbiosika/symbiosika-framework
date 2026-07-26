/**
 * Public publishing of wiki pages — resolving inheritance.
 *
 * A page carries an explicit publishing INTENT in `knowledgeText.publicMode`:
 *
 *   "public"    publish this page and, by inheritance, everything below it
 *   "excluded"  keep this page and its subtree internal, even below a
 *               published ancestor
 *   NULL        inherit whatever the parent resolved to (the default)
 *
 * Reads never resolve that chain. They filter on the derived
 * `knowledgeText.publicEffective` boolean, which this module maintains. The
 * split exists because the read-side filter
 * (buildKnowledgeTextVisibilityConditions) is pure SQL and runs in hot paths —
 * including the semantic search leg right next to the HNSW index — so walking
 * the ancestor chain per query would be paid on every read instead of on the
 * comparatively rare write that changes publishing.
 *
 * Anything that can change the resolved state must call in here:
 *   - creating a page            -> resolvePublicEffectiveForNewPage()
 *   - publishing / unpublishing  -> setKnowledgeTextPublicMode()
 *   - re-parenting (a "move")    -> propagatePublicEffectiveFrom()
 *
 * recomputePublicEffectiveForTenant() rebuilds the whole tenant from intent
 * alone and is the repair path: it is the definition of correct, so a bug in
 * the incremental paths above can always be healed without data loss.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText, knowledgeEntry } from "../db/schema/knowledge";
// Mutually circular with knowledge-texts.ts (which calls back in here on
// create/update). Both sides only use each other at call time, matching the
// existing knowledge-texts <-> knowledge-text-links/-files relationship.
import {
  getKnowledgeTextById,
  checkKnowledgeTextWritePermission,
} from "./knowledge-texts";
import log from "../log";

/** Explicit publishing intent; NULL/undefined means "inherit from parent". */
export type KnowledgePublicMode = "public" | "excluded";

/** Postgres caps parameters per statement — update ids in bounded batches. */
const UPDATE_BATCH_SIZE = 500;

/** The one place the inheritance rule is written down. */
const resolveEffective = (
  mode: KnowledgePublicMode | null,
  parentEffective: boolean
): boolean => {
  if (mode === "public") return true;
  if (mode === "excluded") return false;
  return parentEffective;
};

type PageRow = {
  id: string;
  parentId: string | null;
  publicMode: KnowledgePublicMode | null;
  publicEffective: boolean;
  knowledgeEntryId: string | null;
};

/** Narrow projection of a tenant's pages — enough to resolve inheritance. */
const loadTenantPages = async (tenantId: string): Promise<PageRow[]> =>
  (await getDb()
    .select({
      id: knowledgeText.id,
      parentId: knowledgeText.parentId,
      publicMode: knowledgeText.publicMode,
      publicEffective: knowledgeText.publicEffective,
      knowledgeEntryId: knowledgeText.knowledgeEntryId,
    })
    .from(knowledgeText)
    .where(eq(knowledgeText.tenantId, tenantId))) as PageRow[];

const childrenByParent = (pages: PageRow[]): Map<string, PageRow[]> => {
  const map = new Map<string, PageRow[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const list = map.get(page.parentId);
    if (list) list.push(page);
    else map.set(page.parentId, [page]);
  }
  return map;
};

/**
 * Walk a subtree top-down and record the resolved state of every page.
 *
 * `visited` guards against a parentId cycle: the schema cannot rule one out
 * (parentId is a plain self-FK), and a cycle here would otherwise hang the
 * request rather than just mis-resolve a page.
 */
const resolveSubtree = (
  root: PageRow,
  rootEffective: boolean,
  children: Map<string, PageRow[]>,
  into: Map<string, boolean>
): void => {
  const stack: { page: PageRow; effective: boolean }[] = [
    { page: root, effective: rootEffective },
  ];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const { page, effective } = stack.pop()!;
    if (visited.has(page.id)) continue;
    visited.add(page.id);
    into.set(page.id, effective);

    for (const child of children.get(page.id) ?? []) {
      stack.push({
        page: child,
        effective: resolveEffective(child.publicMode, effective),
      });
    }
  }
};

/**
 * Persist the resolved values for the pages whose state actually changed, and
 * mirror the change onto the RAG entries so similarity search agrees with the
 * wiki. Returns the number of pages updated.
 */
const persistResolved = async (
  pages: PageRow[],
  resolved: Map<string, boolean>
): Promise<number> => {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const turnOn: string[] = [];
  const turnOff: string[] = [];
  const entriesOn: string[] = [];
  const entriesOff: string[] = [];

  for (const [id, effective] of resolved) {
    const page = byId.get(id);
    if (!page || page.publicEffective === effective) continue;
    (effective ? turnOn : turnOff).push(id);
    if (page.knowledgeEntryId) {
      (effective ? entriesOn : entriesOff).push(page.knowledgeEntryId);
    }
  }

  const applyPages = async (ids: string[], value: boolean) => {
    for (let i = 0; i < ids.length; i += UPDATE_BATCH_SIZE) {
      await getDb()
        .update(knowledgeText)
        .set({ publicEffective: value })
        .where(inArray(knowledgeText.id, ids.slice(i, i + UPDATE_BATCH_SIZE)));
    }
  };
  const applyEntries = async (ids: string[], value: boolean) => {
    for (let i = 0; i < ids.length; i += UPDATE_BATCH_SIZE) {
      await getDb()
        .update(knowledgeEntry)
        .set({ publicEffective: value })
        .where(inArray(knowledgeEntry.id, ids.slice(i, i + UPDATE_BATCH_SIZE)));
    }
  };

  await applyPages(turnOn, true);
  await applyPages(turnOff, false);
  await applyEntries(entriesOn, true);
  await applyEntries(entriesOff, false);

  return turnOn.length + turnOff.length;
};

/**
 * Rebuild `publicEffective` for an entire tenant from `publicMode` alone.
 *
 * This is the authoritative definition of the derived state and the repair
 * path for drift. Safe to run at any time; it only writes rows whose resolved
 * value differs from what is stored.
 */
export const recomputePublicEffectiveForTenant = async (
  tenantId: string
): Promise<{ updated: number }> => {
  const pages = await loadTenantPages(tenantId);
  if (pages.length === 0) return { updated: 0 };

  const children = childrenByParent(pages);
  const byId = new Set(pages.map((page) => page.id));
  const resolved = new Map<string, boolean>();

  // Roots are pages without a parent — plus pages whose parent lives outside
  // this tenant's set (a dangling parentId), which behave like roots rather
  // than silently dropping out of the rebuild.
  for (const page of pages) {
    const isRoot = !page.parentId || !byId.has(page.parentId);
    if (!isRoot) continue;
    resolveSubtree(
      page,
      resolveEffective(page.publicMode, false),
      children,
      resolved
    );
  }

  // A parentId cycle leaves its members unreachable from any root. They are
  // not published (inheriting from nothing), but they must still be resolved
  // so a stale `true` cannot survive in a cycle.
  for (const page of pages) {
    if (!resolved.has(page.id)) {
      resolved.set(page.id, resolveEffective(page.publicMode, false));
    }
  }

  const updated = await persistResolved(pages, resolved);
  if (updated > 0) {
    log.debug(
      `recomputePublicEffectiveForTenant(${tenantId}): ${updated} page(s) changed`
    );
  }
  return { updated };
};

/**
 * Re-resolve the subtree rooted at `pageId` after its intent or its parent
 * changed. The seed comes from the page's own intent combined with the
 * PARENT's stored state, so only the affected branch is touched.
 */
export const propagatePublicEffectiveFrom = async (
  pageId: string,
  tenantId: string
): Promise<{ updated: number }> => {
  const pages = await loadTenantPages(tenantId);
  const root = pages.find((page) => page.id === pageId);
  if (!root) return { updated: 0 };

  let parentEffective = false;
  if (root.parentId) {
    const parent = pages.find((page) => page.id === root.parentId);
    parentEffective = parent?.publicEffective ?? false;
  }

  const resolved = new Map<string, boolean>();
  resolveSubtree(
    root,
    resolveEffective(root.publicMode, parentEffective),
    childrenByParent(pages),
    resolved
  );

  return { updated: await persistResolved(pages, resolved) };
};

/**
 * The value a page being created should start with: inherited from its parent,
 * unless the new page carries its own explicit intent.
 *
 * Called by createKnowledgeText, so a page added below a published branch is
 * public from its first read and never needs a follow-up propagation.
 */
export const resolvePublicEffectiveForNewPage = async (data: {
  tenantId: string;
  parentId?: string | null;
  publicMode?: KnowledgePublicMode | null;
}): Promise<boolean> => {
  const mode = data.publicMode ?? null;
  if (mode === "public") return true;
  if (mode === "excluded") return false;
  if (!data.parentId) return false;

  const parent = await getDb()
    .select({ publicEffective: knowledgeText.publicEffective })
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.id, data.parentId),
        eq(knowledgeText.tenantId, data.tenantId)
      )
    );

  return parent[0]?.publicEffective ?? false;
};

/**
 * Publish or unpublish a page (and, by inheritance, its subtree).
 *
 * `mode: null` drops the explicit intent and makes the page inherit again.
 * Requires WRITE access to the page — publishing is a write, even though it
 * only ever affects read access.
 */
export const setKnowledgeTextPublicMode = async (
  id: string,
  mode: KnowledgePublicMode | null,
  context: { tenantId: string; userId?: string }
): Promise<{ id: string; publicMode: KnowledgePublicMode | null; publicEffective: boolean }> => {
  const page = await getKnowledgeTextById(id, context);
  await checkKnowledgeTextWritePermission(page, context);

  await getDb()
    .update(knowledgeText)
    .set({ publicMode: mode, updatedAt: sql`now()` })
    .where(
      and(eq(knowledgeText.id, id), eq(knowledgeText.tenantId, context.tenantId))
    );

  await propagatePublicEffectiveFrom(id, context.tenantId);

  const after = await getDb()
    .select({
      id: knowledgeText.id,
      publicMode: knowledgeText.publicMode,
      publicEffective: knowledgeText.publicEffective,
    })
    .from(knowledgeText)
    .where(eq(knowledgeText.id, id));

  if (!after[0]) throw new Error("Knowledge text not found");
  return after[0] as {
    id: string;
    publicMode: KnowledgePublicMode | null;
    publicEffective: boolean;
  };
};

/**
 * Propagation that must not break the surrounding write.
 *
 * Used on paths where the page row is already committed (a completed move, a
 * finished update): throwing there would report a failure for a write that
 * succeeded. A miss is recoverable — it can only leave `publicEffective`
 * stale, and recomputePublicEffectiveForTenant() heals it.
 *
 * Deliberately fails CLOSED on the dangerous direction: if propagation after a
 * move cannot run, the subtree keeps its previous value, and a subtree moved
 * under a published parent stays internal until the next successful
 * propagation rather than silently going public.
 */
export const propagatePublicEffectiveSafe = async (
  pageId: string,
  tenantId: string
): Promise<void> => {
  try {
    await propagatePublicEffectiveFrom(pageId, tenantId);
  } catch (error) {
    log.error(
      `Failed to propagate public visibility for page ${pageId}: ${error}`
    );
  }
};

/**
 * Every page currently published in a tenant, as a flat id list.
 *
 * Convenience for callers that need the published id set outside a SQL filter
 * (e.g. grouping a public overview); read paths should filter with
 * `publicOnly` instead of round-tripping ids.
 */
export const getPublicPageIds = async (
  tenantId: string
): Promise<string[]> => {
  const rows = await getDb()
    .select({ id: knowledgeText.id })
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        eq(knowledgeText.publicEffective, true),
        eq(knowledgeText.hidden, false),
        isNull(knowledgeText.deletedAt)
      )
    );
  return rows.map((row) => row.id);
};
