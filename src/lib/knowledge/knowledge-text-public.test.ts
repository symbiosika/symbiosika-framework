import { describe, it, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createKnowledgeText,
  getKnowledgeText,
  getKnowledgeTextById,
  updateKnowledgeText,
  buildKnowledgeTextVisibilityConditions,
} from "./knowledge-texts";
import {
  setKnowledgeTextPublicMode,
  recomputePublicEffectiveForTenant,
  propagatePublicEffectiveFrom,
  getPublicPageIds,
} from "./knowledge-text-public";
import { searchKnowledgeTexts } from "./knowledge-text-search";
import { resolveKnowledgeTextPath } from "./knowledge-text-path";
import { createTeam, addTeamMember } from "../../lib/usermanagement/teams";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1, // tenant owner
  TEST_ORG1_USER_2, // tenant member, in the team
  TEST_ORG1_USER_3, // tenant member, NOT in the team
} from "../../test/init.test";

const TENANT = TEST_ORGANISATION_1.id;
const OWNER = TEST_ORG1_USER_1.id;
const MEMBER = TEST_ORG1_USER_2.id;
const OUTSIDER = TEST_ORG1_USER_3.id;

const uniqueTitle = (name: string) => `${name} ${crypto.randomUUID()}`;

/** Read the derived flag straight from the row, bypassing every read path. */
const storedPublicEffective = async (id: string): Promise<boolean> => {
  const rows = await getDb()
    .select({ publicEffective: knowledgeText.publicEffective })
    .from(knowledgeText)
    .where(eq(knowledgeText.id, id));
  return rows[0]!.publicEffective;
};

const makePage = async (opts: {
  title: string;
  text?: string;
  parentId?: string;
  teamId?: string;
  tenantWide?: boolean;
}) =>
  await createKnowledgeText({
    title: uniqueTitle(opts.title),
    text: opts.text ?? "content",
    tenantId: TENANT,
    userId: OWNER,
    parentId: opts.parentId,
    teamId: opts.teamId,
    tenantWide: opts.tenantWide ?? (opts.teamId ? false : true),
  });

let teamId: string;

describe("Public wiki visibility", () => {
  beforeAll(async () => {
    await initTests();
    const team = await createTeam({
      name: `Public Test Team ${crypto.randomUUID()}`,
      tenantId: TENANT,
    });
    teamId = team.id;
    // OWNER authors the team pages in these tests, MEMBER only reads them.
    // OUTSIDER is deliberately left out of the team.
    await addTeamMember(teamId, TENANT, OWNER, "admin");
    await addTeamMember(teamId, TENANT, MEMBER, "member");
  });

  describe("nothing is public by default", () => {
    it("a freshly created page is not published", async () => {
      const page = await makePage({ title: "Fresh" });
      expect(await storedPublicEffective(page.id)).toBe(false);
      expect(page.publicMode).toBeNull();
    });

    it("a public read of a tenant that published nothing returns nothing", async () => {
      await makePage({ title: "Unpublished" });
      const pages = await getKnowledgeText({ tenantId: TENANT, publicOnly: true });
      // may contain pages published by other tests, but never an unpublished one
      for (const page of pages) {
        expect(await storedPublicEffective(page.id)).toBe(true);
      }
    });
  });

  describe("inheritance down the tree", () => {
    it("publishing a page publishes its whole subtree", async () => {
      const root = await makePage({ title: "Root" });
      const child = await makePage({ title: "Child", parentId: root.id });
      const grandchild = await makePage({
        title: "Grandchild",
        parentId: child.id,
      });

      await setKnowledgeTextPublicMode(root.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });

      expect(await storedPublicEffective(root.id)).toBe(true);
      expect(await storedPublicEffective(child.id)).toBe(true);
      expect(await storedPublicEffective(grandchild.id)).toBe(true);
    });

    it("a page created below a published branch is published immediately", async () => {
      const root = await makePage({ title: "Live Root" });
      await setKnowledgeTextPublicMode(root.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });

      const late = await makePage({ title: "Late Child", parentId: root.id });
      // no follow-up propagation call — createKnowledgeText resolves it
      expect(await storedPublicEffective(late.id)).toBe(true);
    });

    it('"excluded" keeps a page and its subtree internal below a published parent', async () => {
      const root = await makePage({ title: "Mixed Root" });
      const secret = await makePage({ title: "Secret", parentId: root.id });
      const belowSecret = await makePage({
        title: "Below Secret",
        parentId: secret.id,
      });

      await setKnowledgeTextPublicMode(root.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });
      await setKnowledgeTextPublicMode(secret.id, "excluded", {
        tenantId: TENANT,
        userId: OWNER,
      });

      expect(await storedPublicEffective(root.id)).toBe(true);
      expect(await storedPublicEffective(secret.id)).toBe(false);
      expect(await storedPublicEffective(belowSecret.id)).toBe(false);
    });

    it("unpublishing a page takes its subtree with it", async () => {
      const root = await makePage({ title: "Temp Root" });
      const child = await makePage({ title: "Temp Child", parentId: root.id });
      await setKnowledgeTextPublicMode(root.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });
      expect(await storedPublicEffective(child.id)).toBe(true);

      await setKnowledgeTextPublicMode(root.id, null, {
        tenantId: TENANT,
        userId: OWNER,
      });
      expect(await storedPublicEffective(root.id)).toBe(false);
      expect(await storedPublicEffective(child.id)).toBe(false);
    });
  });

  describe("moving a page re-resolves publishing", () => {
    it("an internal subtree moved under a published parent becomes public", async () => {
      const publicRoot = await makePage({ title: "Published Root" });
      await setKnowledgeTextPublicMode(publicRoot.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });

      const internal = await makePage({ title: "Internal Branch" });
      const internalChild = await makePage({
        title: "Internal Leaf",
        parentId: internal.id,
      });
      expect(await storedPublicEffective(internalChild.id)).toBe(false);

      await updateKnowledgeText(
        internal.id,
        { parentId: publicRoot.id },
        { tenantId: TENANT, userId: OWNER }
      );

      expect(await storedPublicEffective(internal.id)).toBe(true);
      expect(await storedPublicEffective(internalChild.id)).toBe(true);
    });

    it("a published subtree moved out to the root becomes internal again", async () => {
      const publicRoot = await makePage({ title: "Src Root" });
      const branch = await makePage({ title: "Branch", parentId: publicRoot.id });
      const leaf = await makePage({ title: "Leaf", parentId: branch.id });
      await setKnowledgeTextPublicMode(publicRoot.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });
      expect(await storedPublicEffective(leaf.id)).toBe(true);

      await updateKnowledgeText(
        branch.id,
        { parentId: null },
        { tenantId: TENANT, userId: OWNER }
      );

      expect(await storedPublicEffective(branch.id)).toBe(false);
      expect(await storedPublicEffective(leaf.id)).toBe(false);
    });
  });

  describe("public reads never expose internal content", () => {
    it("getKnowledgeTextById refuses an unpublished page", async () => {
      const page = await makePage({ title: "Internal Only" });
      await expect(
        getKnowledgeTextById(page.id, { tenantId: TENANT, publicOnly: true })
      ).rejects.toThrow();
    });

    it("getKnowledgeTextById refuses an excluded page below a published parent", async () => {
      const root = await makePage({ title: "Pub Parent" });
      const excluded = await makePage({ title: "Excluded Child", parentId: root.id });
      await setKnowledgeTextPublicMode(root.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });
      await setKnowledgeTextPublicMode(excluded.id, "excluded", {
        tenantId: TENANT,
        userId: OWNER,
      });

      // the parent is readable...
      const parent = await getKnowledgeTextById(root.id, {
        tenantId: TENANT,
        publicOnly: true,
      });
      expect(parent.id).toBe(root.id);

      // ...the excluded child is not
      await expect(
        getKnowledgeTextById(excluded.id, { tenantId: TENANT, publicOnly: true })
      ).rejects.toThrow();
    });

    it("a team page stays internal for a public read even though nobody is signed in", async () => {
      const teamPage = await makePage({ title: "Team Secret", teamId });
      const pages = await getKnowledgeText({ tenantId: TENANT, publicOnly: true });
      expect(pages.some((p) => p.id === teamPage.id)).toBe(false);
    });

    it("hybrid search does not return an unpublished page that matches the query", async () => {
      const needle = `zzqq${crypto.randomUUID().replaceAll("-", "")}`;
      const internal = await makePage({
        title: "Internal Match",
        text: `this internal page mentions ${needle} exactly once`,
      });
      const published = await makePage({
        title: "Published Match",
        text: `this published page mentions ${needle} too`,
      });
      await setKnowledgeTextPublicMode(published.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });

      // fulltext mode keeps the assertion independent of an embedding provider
      const hits = await searchKnowledgeTexts(
        needle,
        { tenantId: TENANT, publicOnly: true },
        { mode: "fulltext", limit: 20 }
      );

      const ids = hits.map((h) => h.id);
      expect(ids).toContain(published.id);
      expect(ids).not.toContain(internal.id);
    });

    it("a signed-in user searching the same term still sees the internal page", async () => {
      const needle = `zzrr${crypto.randomUUID().replaceAll("-", "")}`;
      const internal = await makePage({
        title: "Internal Match 2",
        text: `internal content with ${needle}`,
      });

      const hits = await searchKnowledgeTexts(
        needle,
        { tenantId: TENANT, userId: OWNER },
        { mode: "fulltext", limit: 20 }
      );
      expect(hits.map((h) => h.id)).toContain(internal.id);
    });

    it("a breadcrumb of a page published below an internal parent hides the parent", async () => {
      const internalParent = await makePage({ title: "Hidden Parent" });
      const publishedChild = await makePage({
        title: "Visible Child",
        parentId: internalParent.id,
      });
      await setKnowledgeTextPublicMode(publishedChild.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });

      const internalPath = await resolveKnowledgeTextPath(
        publishedChild.id,
        TENANT
      );
      // signed-in view shows the full breadcrumb
      expect(internalPath!.pathIds).toContain(internalParent.id);

      const publicPath = await resolveKnowledgeTextPath(publishedChild.id, TENANT, {
        publicOnly: true,
      });
      expect(publicPath!.pathIds).toEqual([publishedChild.id]);
      expect(publicPath!.path).not.toContain(internalParent.title);
    });
  });

  describe("derived state cannot be forged", () => {
    it("updateKnowledgeText ignores a caller-supplied publicEffective", async () => {
      const page = await makePage({ title: "Forge Attempt" });
      await updateKnowledgeText(
        page.id,
        { publicEffective: true } as { publicEffective: boolean },
        { tenantId: TENANT, userId: OWNER }
      );
      expect(await storedPublicEffective(page.id)).toBe(false);
    });

    it("createKnowledgeText ignores a caller-supplied publicEffective", async () => {
      const page = await createKnowledgeText({
        title: uniqueTitle("Forge On Create"),
        text: "x",
        tenantId: TENANT,
        userId: OWNER,
        tenantWide: true,
        publicEffective: true,
      });
      expect(await storedPublicEffective(page.id)).toBe(false);
    });

    it("publishing requires write access to the page", async () => {
      const teamPage = await makePage({ title: "Team Owned", teamId });
      // OUTSIDER is a tenant member but not in the team, so the page is not
      // even visible to them — publishing must fail
      await expect(
        setKnowledgeTextPublicMode(teamPage.id, "public", {
          tenantId: TENANT,
          userId: OUTSIDER,
        })
      ).rejects.toThrow();
      expect(await storedPublicEffective(teamPage.id)).toBe(false);
    });
  });

  describe("recompute is the repair path", () => {
    it("rebuilds a flag that drifted out of sync", async () => {
      const root = await makePage({ title: "Drift Root" });
      const child = await makePage({ title: "Drift Child", parentId: root.id });
      await setKnowledgeTextPublicMode(root.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });

      // simulate drift: flip the derived flag behind the module's back
      await getDb()
        .update(knowledgeText)
        .set({ publicEffective: false })
        .where(eq(knowledgeText.id, child.id));
      expect(await storedPublicEffective(child.id)).toBe(false);

      await recomputePublicEffectiveForTenant(TENANT);
      expect(await storedPublicEffective(child.id)).toBe(true);
    });

    it("clears a stale published flag that intent no longer supports", async () => {
      const orphan = await makePage({ title: "Stale Public" });
      await getDb()
        .update(knowledgeText)
        .set({ publicEffective: true })
        .where(eq(knowledgeText.id, orphan.id));

      await recomputePublicEffectiveForTenant(TENANT);
      expect(await storedPublicEffective(orphan.id)).toBe(false);
    });

    it("survives a parentId cycle instead of hanging", async () => {
      const a = await makePage({ title: "Cycle A" });
      const b = await makePage({ title: "Cycle B", parentId: a.id });
      // force a cycle directly in the DB (the API would not allow it)
      await getDb()
        .update(knowledgeText)
        .set({ parentId: b.id })
        .where(eq(knowledgeText.id, a.id));

      const result = await recomputePublicEffectiveForTenant(TENANT);
      expect(result).toBeDefined();
      // members of a cycle inherit from nothing, so they are not published
      expect(await storedPublicEffective(a.id)).toBe(false);
      expect(await storedPublicEffective(b.id)).toBe(false);

      // leave the tenant in a clean state for the other tests
      await getDb()
        .update(knowledgeText)
        .set({ parentId: null })
        .where(eq(knowledgeText.id, a.id));
    });

    it("propagating from an unknown page is a no-op", async () => {
      const result = await propagatePublicEffectiveFrom(
        crypto.randomUUID(),
        TENANT
      );
      expect(result.updated).toBe(0);
    });
  });

  describe("backward compatibility", () => {
    it("a context without publicOnly keeps the previous user/team rules", async () => {
      const teamPage = await makePage({ title: "Compat Team Page", teamId });

      // team member sees it
      const asMember = await getKnowledgeTextById(teamPage.id, {
        tenantId: TENANT,
        userId: MEMBER,
      });
      expect(asMember.id).toBe(teamPage.id);

      // non-member does not
      await expect(
        getKnowledgeTextById(teamPage.id, { tenantId: TENANT, userId: OUTSIDER })
      ).rejects.toThrow();
    });

    it("a service context (tenant only) still sees the whole tenant", async () => {
      const page = await makePage({ title: "Service Visible", teamId });
      const found = await getKnowledgeTextById(page.id, { tenantId: TENANT });
      expect(found.id).toBe(page.id);
    });

    it("publicOnly wins over userId, so a preview matches the anonymous view", async () => {
      const teamPage = await makePage({ title: "Preview Team Page", teamId });
      // MEMBER can normally read it, but a public preview must not
      await expect(
        getKnowledgeTextById(teamPage.id, {
          tenantId: TENANT,
          userId: MEMBER,
          publicOnly: true,
        })
      ).rejects.toThrow();
    });

    it("the visibility builder adds exactly one condition for a public read", () => {
      const withUser = buildKnowledgeTextVisibilityConditions({
        tenantId: TENANT,
        userId: OWNER,
      });
      const asPublic = buildKnowledgeTextVisibilityConditions({
        tenantId: TENANT,
        publicOnly: true,
      });
      // tenant + hidden + (access rule) in both cases
      expect(withUser.length).toBe(3);
      expect(asPublic.length).toBe(3);
    });
  });

  describe("getPublicPageIds", () => {
    it("lists published pages and excludes internal ones", async () => {
      const published = await makePage({ title: "Listed" });
      const internal = await makePage({ title: "Not Listed" });
      await setKnowledgeTextPublicMode(published.id, "public", {
        tenantId: TENANT,
        userId: OWNER,
      });

      const ids = await getPublicPageIds(TENANT);
      expect(ids).toContain(published.id);
      expect(ids).not.toContain(internal.id);
    });
  });
});
