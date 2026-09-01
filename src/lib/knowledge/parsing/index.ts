import type { FileSourceType } from "../../../lib/storage";
import log from "../../../lib/log";
import { getFileFromDb } from "../../../lib/storage/db";
import { getFileFromLocalDisc } from "../../../lib/storage/local";
import { parsePdfFileAsMardown } from "./pdf";
import { knowledgeText } from "../../../lib/db/db-schema";
import { getDb } from "../../../lib/db/db-connection";
import { eq } from "drizzle-orm";
import type {
  ExtractedValue,
  ExtractionTarget,
  PageContent,
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
 * Helper function to parse a file and return the text content and pages if available
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
    /** Extra service: analyse images embedded in the document. */
    parseImagesInDoc?: boolean;
    /** Extra service: OCR on scanned / image-only pages. */
    ocr?: boolean;
    /** Extra service: detect tables and render them as Markdown. */
    detectTables?: boolean;
    /**
     * Storage bucket for images extracted from the document. Defaults to
     * `PARSED_IMAGES_BUCKET` ("images"); a caller that owns the images
     * afterwards passes its own (see `PdfParserOptions.imageBucket`).
     */
    imageBucket?: string;
  }
): Promise<{
  text: string;
  pages?: PageContent[];
  includesImages: boolean;
  /** Extracted key/value metadata keyed by `ExtractionTarget.key`. */
  metadata?: Record<string, ExtractedValue>;
}> => {
  log.debug(`Parse file: ${file.name} from type ${file.type}`);

  const mime = file.type.trim().toLowerCase();
  /** Windows / some browsers send "" or octet-stream for .pdf / .PDF */
  const pdfByExtension =
    /\.pdf$/i.test(file.name) &&
    (mime === "" ||
      mime === "application/octet-stream" ||
      mime === "application/x-download" ||
      mime === "binary/octet-stream");
  const fileForPdf =
    mime === "application/pdf"
      ? file
      : pdfByExtension
        ? new File([file], file.name, { type: "application/pdf" })
        : null;

  // PDF
  if (fileForPdf) {
    const extract = await resolveExtractionTargets(
      context.tenantId,
      options?.extract
    );
    // try to parse the content
    const result = await parsePdfFileAsMardown(fileForPdf, context, {
      model: options?.model,
      extractImages: options?.extractImages,
      extract,
      parseImagesInDoc: options?.parseImagesInDoc,
      ocr: options?.ocr,
      detectTables: options?.detectTables,
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
    };
  }

  // TXT file
  if (file.type.startsWith("text/plain")) {
    return { text: await file.text(), includesImages: false };
  }

  // Image
  else if (file.type.startsWith("image")) {
    // the the image describe by ai

    // TO DE IMPLEMENTED!

    return { text: "NOT IMPLEMENTED!", includesImages: false };
  } else {
    throw new Error(`Unsupported file type for parsing: ${file.type}`);
  }
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
