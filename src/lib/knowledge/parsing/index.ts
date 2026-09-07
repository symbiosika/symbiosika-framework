import type { FileSourceType } from "../../../lib/storage";
import log from "../../../lib/log";
import { getFileFromDb } from "../../../lib/storage/db";
import { getFileFromLocalDisc } from "../../../lib/storage/local";
import { configuredParserSupports, parseFileWithService } from "./pdf";
import { knowledgeText } from "../../../lib/db/db-schema";
import { getDb } from "../../../lib/db/db-connection";
import { eq } from "drizzle-orm";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  fileExtension,
  isUninformativeMime,
  withLegacyServiceOptions,
  type ExtractedValue,
  type ExtractionTarget,
  type LegacyServiceOptions,
  type PageContent,
  type ServiceOptions,
} from "./pdf/types";
import { applyPostProcessors } from "./post-processors";
import { urlToMarkdown } from "./url";
import { computeSourceHash } from "../source-hash";
import { _GLOBAL_SERVER_CONFIG } from "../../../store";
import {
  attributeDefinitionsToExtractionTargets,
  getKnowledgeTenantConfig,
} from "../knowledge-config";

/**
 * Resolve the structured extraction targets to hand the parsing service.
 * An explicit `provided` list always wins. Otherwise, when the global
 * `enablePdfParserExtraction` flag is on, the tenant's configured catalog
 * attributes are mapped to targets. Returns undefined when nothing applies
 * (no config read happens while the flag is off).
 */
export const resolveExtractionTargets = async (
  tenantId: string,
  provided?: ExtractionTarget[]
): Promise<ExtractionTarget[] | undefined> => {
  if (provided && provided.length > 0) return provided;
  if (!_GLOBAL_SERVER_CONFIG.enablePdfParserExtraction) return undefined;
  const config = await getKnowledgeTenantConfig(tenantId);
  if (!config.attributes || config.attributes.length === 0) return undefined;
  return attributeDefinitionsToExtractionTargets(config.attributes);
};

/**
 * Formats the framework handles itself, because the in-house path is better
 * than a round-trip to the parsing service. These win over the service — see
 * `parseFile`.
 *
 * This is deliberately a list of IN-HOUSE formats, not of service formats:
 * what the service accepts is asked of the service
 * (`configuredParserSupports`), so a new format there needs no change here.
 */
const IN_HOUSE_TEXT_MIME_TYPES = ["text/plain", "text/markdown"];
const IN_HOUSE_TEXT_EXTENSIONS = [".txt", ".text", ".md", ".markdown"];
/**
 * HTML is in-house on purpose, and the parsing service rejects it on purpose:
 * it would hand back the page's own source and write raw markup into the
 * index. The URL import (`parsing/url.ts`) stays in-house for the same reason.
 */
const IN_HOUSE_HTML_MIME_TYPES = ["text/html", "application/xhtml+xml"];
const IN_HOUSE_HTML_EXTENSIONS = [".html", ".htm", ".xhtml"];
/**
 * The exception to the plain-text path: browsers hand `.csv` / `.tsv` over as
 * `text/plain` all the time, and a local read would drop the whole table layer
 * — column headers, rows, delimiter and encoding detection. The extension
 * beats a generic MIME, so these reach the service.
 */
const TABLE_EXTENSIONS = [".csv", ".tsv"];

let turndown: TurndownService | null = null;
const htmlToMarkdown = (html: string): string => {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    turndown.use(gfm);
  }
  return turndown.turndown(html).trim();
};

/**
 * Helper function to parse a file and return the text content and pages if
 * available.
 *
 * Routing, in this order:
 *   1. In-house paths — plain text and markdown are read locally, HTML is
 *      converted here. They win over the service.
 *   2. Whatever the configured parsing service advertises via
 *      `GET /v1/capabilities`: PDF, images, audio, video, office documents,
 *      mail, tables. Deliberately not a format list maintained in the
 *      framework — a new format on the service side needs no change here.
 *   3. Only then: unsupported.
 *
 * When the MIME type carries no information (`""`, `application/octet-stream`
 * — what browsers and Windows send for `.xlsx`, `.eml` and `.opus` as readily
 * as for `.pdf`), the extension decides and the service is asked with it.
 */
export const parseFile = async (
  file: File,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
  },
  options?: {
    model?: string;
    extractImages?: boolean;
    /**
     * Structured extraction targets passed through to the parser. When
     * omitted and `enablePdfParserExtraction` is on, the tenant's configured
     * catalog attributes are used automatically.
     */
    extract?: ExtractionTarget[];
    /**
     * Extra options for the parsing service (`ocr`, `detect_tables`,
     * `preferred_language`, …), forwarded to it as-is and dropped where the
     * target modality does not advertise them. An open map on purpose — see
     * `ServiceOptions`; the framework does not enumerate what the service can
     * do.
     */
    serviceOptions?: ServiceOptions;
    /**
     * Storage bucket for images extracted from the document. Defaults to
     * `PARSED_IMAGES_BUCKET` ("images"); a caller that owns the images
     * afterwards passes its own (see `PdfParserOptions.imageBucket`).
     */
    imageBucket?: string;
  } & LegacyServiceOptions
): Promise<{
  text: string;
  pages?: PageContent[];
  includesImages: boolean;
  /** Extracted key/value metadata keyed by `ExtractionTarget.key`. */
  metadata?: Record<string, ExtractedValue>;
  /**
   * Non-fatal notes the service reported about this result: a truncated
   * transcript, skipped scan pages, an unreadable mail attachment. The service
   * returns a partial result instead of failing, so a caller that drops these
   * presents a partial result as a complete one.
   */
  warnings?: string[];
}> => {
  log.debug(`Parse file: ${file.name} from type ${file.type}`);

  // Strip any `; charset=…` parameter — only the type itself routes.
  const mime = (file.type ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = fileExtension(file.name);
  /**
   * The MIME to route on, or `undefined` when it carries no information — then
   * the extension is the only key left, for the service question as well.
   */
  const routingMime = isUninformativeMime(mime) ? undefined : mime;

  // --- 1. In-house paths win ------------------------------------------------

  if (
    (routingMime !== undefined &&
      IN_HOUSE_HTML_MIME_TYPES.includes(routingMime)) ||
    IN_HOUSE_HTML_EXTENSIONS.includes(extension)
  ) {
    return { text: htmlToMarkdown(await file.text()), includesImages: false };
  }

  const looksLikeText =
    (routingMime !== undefined &&
      IN_HOUSE_TEXT_MIME_TYPES.includes(routingMime)) ||
    IN_HOUSE_TEXT_EXTENSIONS.includes(extension);
  if (looksLikeText && !TABLE_EXTENSIONS.includes(extension)) {
    return { text: await file.text(), includesImages: false };
  }

  // --- 2. Whatever the service advertises -----------------------------------

  if (await configuredParserSupports(routingMime, extension, options?.model)) {
    const extract = await resolveExtractionTargets(
      context.tenantId,
      options?.extract
    );
    // Windows and some browsers send "" / octet-stream for a `.pdf`. The
    // service falls back to the extension itself, but the hosted PDF parsers
    // (`mistral`, `llama`, `symbiosika-parse-v1`) look at the MIME — so
    // restore the one type that can be inferred without guessing.
    const fileToParse =
      routingMime === undefined && extension === ".pdf"
        ? new File([file], file.name, { type: "application/pdf" })
        : file;

    const result = await parseFileWithService(fileToParse, context, {
      model: options?.model,
      extractImages: options?.extractImages,
      extract,
      serviceOptions: withLegacyServiceOptions(options?.serviceOptions, {
        parseImagesInDoc: options?.parseImagesInDoc,
        ocr: options?.ocr,
        detectTables: options?.detectTables,
      }),
      imageBucket: options?.imageBucket,
    });

    // Create a combined text from all pages if available
    let fullText = "";
    if (result.pages && result.pages.length > 0) {
      fullText = result.pages.map((page) => page.text).join("\n\n");
    }

    return {
      text: fullText,
      pages: result.pages,
      includesImages: result.includesImages,
      metadata: result.metadata,
      warnings: result.warnings,
    };
  }

  // --- 3. Nothing here can read this ----------------------------------------

  throw new Error(
    `Unsupported file type for parsing: ${file.type || extension || "unknown"}`
  );
};

/**
 * Parse a variety of file types
 */
export const parseDocument = async (data: {
  sourceType: FileSourceType;
  tenantId: string;
  sourceId?: string;
  sourceFileBucket?: string;
  sourceUrl?: string;
  userOwned?: boolean;
  teamId?: string;
  workspaceId?: string;
  model?: string;
  extractImages?: boolean;
  /**
   * Structured extraction targets passed through to the parser. When omitted
   * and `enablePdfParserExtraction` is on, the tenant's configured catalog
   * attributes are used automatically.
   */
  extract?: ExtractionTarget[];
  usePostProcessors?: string[];
  /**
   * Compute a sha256 over the raw source (file bytes for db/local, fetched
   * content for url/text) and return it as `sourceHash`. When undefined the
   * global `enableSourceHashing` config decides. Feed the returned hash into
   * `upsertKnowledgeFromText({ sourceHash })` to enable unchanged-source skip.
   */
  computeSourceHash?: boolean;
}) => {
  // Get the file (from DB or local disc) or content from URL
  let content: string = "";
  let pages: PageContent[] | undefined;
  let title: string;
  let docIncludesImages = false;
  let sourceHash: string | undefined;
  let parserMetadata: Record<string, ExtractedValue> | undefined;
  /** Non-fatal notes the parsing service reported (see `parseFile`). */
  let parserWarnings: string[] | undefined;

  const hashingEnabled =
    data.computeSourceHash ?? _GLOBAL_SERVER_CONFIG.enableSourceHashing;

  if (data.sourceType === "db" && data.sourceId && data.sourceFileBucket) {
    log.debug(
      `Get file from DB: ${data.sourceId} ${data.sourceFileBucket} for tenant ${data.tenantId}`
    );
    const file = await getFileFromDb(
      data.sourceId,
      data.sourceFileBucket,
      data.tenantId
    );
    if (hashingEnabled) sourceHash = computeSourceHash(await file.arrayBuffer());
    const {
      text,
      pages: filePages,
      includesImages,
      metadata,
      warnings,
    } = await parseFile(
      file,
      {
        tenantId: data.tenantId,
        teamId: data.teamId,
        workspaceId: data.workspaceId,
      },
      {
        model: data.model,
        extractImages: data.extractImages,
        extract: data.extract,
      }
    );
    content = text;
    pages = filePages;
    title = file.name;
    docIncludesImages = includesImages;
    parserMetadata = metadata;
    parserWarnings = warnings;
  } else if (
    data.sourceType === "local" &&
    data.sourceId &&
    data.sourceFileBucket
  ) {
    log.debug(
      `Get file from local disc: ${data.sourceId} ${data.sourceFileBucket} for tenant ${data.tenantId}`
    );
    const file = await getFileFromLocalDisc(
      data.sourceId,
      data.sourceFileBucket,
      data.tenantId
    );
    if (hashingEnabled) sourceHash = computeSourceHash(await file.arrayBuffer());
    const {
      text,
      pages: filePages,
      includesImages,
      metadata,
      warnings,
    } = await parseFile(
      file,
      {
        tenantId: data.tenantId,
        teamId: data.teamId,
        workspaceId: data.workspaceId,
      },
      {
        model: data.model,
        extractImages: data.extractImages,
        extract: data.extract,
      }
    );
    content = text;
    pages = filePages;
    title = file.name;
    docIncludesImages = includesImages;
    parserMetadata = metadata;
    parserWarnings = warnings;
  } else if (data.sourceType === "url" && data.sourceUrl) {
    log.debug(`Fetch and parse content from URL: ${data.sourceUrl}`);
    const result = await urlToMarkdown(data.sourceUrl, {
      parseContext: {
        tenantId: data.tenantId,
        teamId: data.teamId,
        workspaceId: data.workspaceId,
      },
      pdfModel: data.model,
    });
    content = result.markdown;
    title = result.title || data.sourceUrl;
    parserWarnings = result.warnings;
    if (hashingEnabled) sourceHash = computeSourceHash(content);
    log.debug(
      `URL parsed. title="${title}" markdown length=${content.length}`
    );
  } else if (data.sourceType === "text") {
    log.debug(`Get file from TEXT`);
    const dbResults = await getDb()
      .select()
      .from(knowledgeText)
      .where(eq(knowledgeText.id, data.sourceId!));
    if (!dbResults[0]) {
      throw new Error(`Knowledge text not found: ${data.sourceId}`);
    }
    content = dbResults[0].text;
    title = dbResults[0].title;
    if (hashingEnabled) sourceHash = computeSourceHash(content);
  } else {
    log.error(
      `Can´t get file. Unsupported file source type '${data.sourceType}' or missing parameters.`
    );
    throw new Error(
      `Can´t get file. Unsupported file source type '${data.sourceType}' or missing parameters.`
    );
  }
  log.debug(`File parsed. Content length: ${content.length}`);

  // Apply post processors if requested
  let meta: Record<string, unknown> = {};
  if (data.usePostProcessors && data.usePostProcessors.length > 0) {
    const processed = await applyPostProcessors(
      {
        text: content,
        pages,
        title,
        source: {
          type: data.sourceType,
          url: data.sourceUrl,
          includesImages: docIncludesImages,
        },
        context: {
          tenantId: data.tenantId,
          teamId: data.teamId,
          workspaceId: data.workspaceId,
        },
        model: data.model,
      },
      data.usePostProcessors
    );
    content = processed.text;
    // The page mapping only survives if a processor returned an updated one;
    // otherwise it is dropped (page-level chunk metadata is no longer valid).
    pages = processed.pages;
    if (processed.title) {
      title = processed.title;
    }
    meta = processed.meta;
  }

  return {
    content,
    pages,
    title,
    includesImages: docIncludesImages,
    meta,
    sourceHash,
    /** Structured values the parser extracted for the requested targets. */
    parserMetadata,
    /**
     * Non-fatal notes the parsing service reported for this document. Present
     * whenever the result is partial on purpose (truncated transcript, skipped
     * scan pages, an unreadable mail attachment) — surface them, otherwise the
     * result claims to be complete.
     */
    parserWarnings,
  };
};

/**
 * Reduce a parser's extraction result to a flat `{ key: value }` map suitable
 * for `knowledgeText.attributes`: only entries that were `found`, carry a
 * non-empty string value, and match a known target key survive. Numbers /
 * booleans are stringified (the attributes store is `Record<string,string>`).
 * Callers still pass the result through `validateFacetsForWrite`, which drops
 * nothing but rejects values outside a closed list — so pre-filter with
 * `allowedKeys`/`allowedValues` when a hard failure must be avoided.
 */
export const extractedMetadataToAttributes = (
  metadata: Record<string, ExtractedValue> | undefined
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!metadata) return out;
  for (const [key, entry] of Object.entries(metadata)) {
    if (!entry || entry.found !== true) continue;
    const { value } = entry;
    // Accept only real scalars. Anything else (null/undefined, objects,
    // arrays, NaN/Infinity) is dropped instead of being coerced into a junk
    // string like "[object Object]" — the parser may return values that
    // violate its own type contract.
    let asString: string;
    if (typeof value === "string") {
      asString = value;
    } else if (typeof value === "boolean") {
      asString = String(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      asString = String(value);
    } else {
      continue;
    }
    if (asString.length === 0) continue;
    out[key] = asString;
  }
  return out;
};
