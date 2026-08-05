import log from "../../../log";
import { saveFile } from "../../../storage";

/**
 * Persist a base64-encoded image (raw base64 or a `data:` URL) to storage and
 * return the stored file path. Returns null when the payload is empty.
 *
 * Shared by the Mistral OCR parsers, which receive extracted images as base64.
 */
export const saveBase64ImageToStorage = async (
  base64OrDataUrl: string | null | undefined,
  id: string,
  tenantId: string,
): Promise<string | null> => {
  // Defensive: providers may hand us a null/empty payload (e.g. Mistral OCR
  // returns `image_base64: null` for every image when image extraction is off).
  if (!base64OrDataUrl) {
    return null;
  }

  // Accept both raw base64 and `data:<mime>;base64,<payload>` URLs.
  const base64Data = base64OrDataUrl.includes(",")
    ? base64OrDataUrl.split(",")[1]
    : base64OrDataUrl;

  if (!base64Data) {
    return null;
  }

  const bytes = Buffer.from(base64Data, "base64");
  const blob = new Blob([bytes], { type: "image/jpeg" });
  const file = new File([blob], id, { type: "image/jpeg" });

  const savedFile = await saveFile(file, "images", tenantId, "db");
  return savedFile.path;
};

/** One image a parsing service reported for a page. */
export type ParsedPageImage = {
  /** Id used both as the markdown alt text and as the placeholder target. */
  id: string;
  /** Raw base64 or a `data:` URL. Null/absent when extraction was disabled. */
  base64?: string | null;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match `![<anything>](<id>)` for one concrete image id. The id is escaped —
 * ids like `img-0.jpeg` contain regex metacharacters, and an unescaped `.`
 * would happily match a neighbouring reference.
 */
const referencePattern = (id: string): RegExp =>
  new RegExp(`!\\[[^\\]]*\\]\\(\\s*${escapeRegExp(id)}\\s*\\)`, "g");

/**
 * Persist a page's images and point its markdown references at the stored
 * paths.
 *
 * The important half is the failure path: a reference whose image was **not**
 * persisted — extraction disabled, empty payload, service reported an image it
 * did not send — is removed instead of being left in the text. Parsing services
 * emit placeholders like `![img-0.jpeg](img-0.jpeg)` that only resolve once we
 * have rewritten them, so leaving one behind ships a permanently broken image
 * into the document.
 *
 * Whether to store an image is decided by the payload alone, never by the
 * caller's `extractImages` flag: a service that hands us base64 despite the
 * flag being off still gets its image persisted, exactly as before. With no
 * payload — extraction disabled, or the service listed an image it did not
 * send — nothing is written and the reference goes away.
 */
export const resolveImageReferences = async (
  text: string,
  images: ParsedPageImage[],
  tenantId: string,
): Promise<{ text: string; savedPaths: string[] }> => {
  let out = text;
  const savedPaths: string[] = [];
  let strippedAny = false;

  for (const image of images) {
    const savedPath = await saveBase64ImageToStorage(
      image.base64,
      image.id,
      tenantId,
    );

    if (savedPath) {
      savedPaths.push(savedPath);
      out = out.replace(
        referencePattern(image.id),
        `![${image.id}](${savedPath})`,
      );
      continue;
    }

    const stripped = stripReference(out, referencePattern(image.id));
    if (stripped !== out) {
      strippedAny = true;
      log.debug(`Dropped unresolved image reference "${image.id}".`);
    }
    out = stripped;
  }

  // Only touch the surrounding whitespace when a reference actually went away.
  // Pages we merely rewrote (or left alone) must come back byte-identical —
  // reflowing every parsed page would eat trailing double-spaces, which are
  // markdown hard line breaks, and rewrite the inside of fenced code blocks.
  return { text: strippedAny ? collapseBlankLines(out) : out, savedPaths };
};

/**
 * Remove a reference. When it sits alone on its line the whole line goes with
 * it, so a dropped image does not leave an indented empty line behind.
 */
const stripReference = (text: string, pattern: RegExp): string =>
  text
    .replace(
      new RegExp(`^[^\\S\\n]*(?:${pattern.source})[^\\S\\n]*\\n?`, "gm"),
      "",
    )
    .replace(pattern, "");

/**
 * Close the hole left by stripped lines: several removed images in a row leave
 * a run of blank lines where the document had at most one.
 */
const collapseBlankLines = (text: string): string =>
  text.replace(/\n{3,}/g, "\n\n").trimEnd();

/**
 * Strip every markdown image reference that still points at a non-path target.
 *
 * Fallback for services that do not give us stable image ids to match on (the
 * OpenRouter route only yields images positionally). Anything that already
 * points at a stored path — absolute, relative or a URL — is left alone.
 */
export const stripUnresolvedImageReferences = (text: string): string => {
  const unresolved = /!\[[^\]]*\]\(\s*([^)\s]*)\s*\)/g;
  const isResolved = (target: string) =>
    /^(\/|\.{1,2}\/|[a-z][a-z0-9+.-]*:)/i.test(target);

  const out = text
    .replace(
      new RegExp(`^[^\\S\\n]*(?:${unresolved.source})[^\\S\\n]*\\n?`, "gm"),
      (match, target: string) => (isResolved(target) ? match : ""),
    )
    .replace(unresolved, (match, target: string) =>
      isResolved(target) ? match : "",
    );

  return out === text ? text : collapseBlankLines(out);
};
