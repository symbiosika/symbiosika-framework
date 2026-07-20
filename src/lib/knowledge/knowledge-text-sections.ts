/**
 * B4 — heading-based section addressing for long pages.
 *
 * Instead of reading a 3000-line page whole, an agent can fetch its heading
 * outline and then read just the relevant section. Markdown ATX headings
 * (`#`..`######`) define the structure; a section runs from its heading to the
 * next heading of the same or higher level.
 *
 * Anchors are GitHub-style slugs of the heading text, disambiguated with a
 * numeric suffix on collision (e.g. "setup", "setup-2"), so they are stable
 * addresses within a page.
 */

import { getKnowledgeTextById } from "./knowledge-texts";

export interface OutlineHeading {
  level: number;
  title: string;
  /** stable slug anchor, unique within the page */
  anchor: string;
  /** 1-based line number of the heading in the page text */
  line: number;
}

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const parseHeadings = (
  text: string
): { level: number; title: string; line: number; anchor: string }[] => {
  const lines = text.split("\n");
  const seen = new Map<string, number>();
  const headings: {
    level: number;
    title: string;
    line: number;
    anchor: string;
  }[] = [];
  let inFence = false;
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (!m) return;
    const level = m[1].length;
    const title = m[2].trim();
    let anchor = slugify(title) || `section-${i + 1}`;
    const count = seen.get(anchor) ?? 0;
    seen.set(anchor, count + 1);
    if (count > 0) anchor = `${anchor}-${count + 1}`;
    headings.push({ level, title, line: i + 1, anchor });
  });
  return headings;
};

/**
 * Get a page's heading outline (structure without the body text).
 */
export const getPageOutline = async (
  id: string,
  context: { tenantId: string; userId?: string; teamId?: string }
): Promise<{ id: string; title: string; outline: OutlineHeading[] }> => {
  const page = await getKnowledgeTextById(id, context);
  return {
    id: page.id,
    title: page.title,
    outline: parseHeadings(page.text),
  };
};

export interface PageSection {
  id: string;
  anchor: string;
  heading: string;
  level: number;
  content: string;
  /** true if the requested anchor was not found */
  notFound?: boolean;
}

/**
 * Read a single section of a page addressed by its heading anchor. The section
 * spans from the heading to the next heading of the same or higher level
 * (subsections are included). Returns { notFound: true } if the anchor is
 * unknown.
 */
export const readPageSection = async (
  id: string,
  anchor: string,
  context: { tenantId: string; userId?: string; teamId?: string }
): Promise<PageSection> => {
  const page = await getKnowledgeTextById(id, context);
  const lines = page.text.split("\n");
  const headings = parseHeadings(page.text);

  const target = headings.find((h) => h.anchor === anchor);
  if (!target) {
    return {
      id: page.id,
      anchor,
      heading: "",
      level: 0,
      content: "",
      notFound: true,
    };
  }

  // Section ends at the next heading of same-or-higher level (lower number).
  const next = headings.find(
    (h) => h.line > target.line && h.level <= target.level
  );
  const startIdx = target.line - 1; // include the heading line
  const endIdx = next ? next.line - 1 : lines.length;
  const content = lines.slice(startIdx, endIdx).join("\n").trim();

  return {
    id: page.id,
    anchor: target.anchor,
    heading: target.title,
    level: target.level,
    content,
  };
};
