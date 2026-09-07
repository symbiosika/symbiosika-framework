export type PdfParserContext = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
};

/**
 * One structured value a parsing service should try to extract from a document.
 * The caller names the field (`key`, `name`, `description`); the service fills
 * it. See `docs/framework/18_PDF_Parser_Generic_Microservice_Spec.md` §3.1.
 */
export type ExtractionTarget = {
  /** Stable machine key. Used verbatim as the key in the result metadata. */
  key: string;
  /** Human-readable label handed to the extractor as the field name. */
  name: string;
  /** What exactly to extract — the primary instruction to the extractor. */
  description: string;
  /** Whether the field is expected to exist. Missing != error. */
  required?: boolean;
  type?: "string" | "number" | "date" | "boolean" | "enum";
  /** Allowed values, only for `type: "enum"`. */
  options?: string[];
};

/** One extracted value in a parser result, keyed by `ExtractionTarget.key`. */
export type ExtractedValue = {
  value: string | number | boolean | null;
  found: boolean;
  confidence?: number;
  page?: number;
};

export type PdfParserOptions = {
  model?: string;
  extractImages?: boolean;
  /** Structured extraction targets passed through to the service. */
  extract?: ExtractionTarget[];
  /**
   * Extra service: analyse images embedded in the document (OCR / captioning /
   * description) and fold the recognised content into the page `text`. Only
   * forwarded when the target modality advertises `parse_images_in_doc`.
   * See `docs/framework/18_..._Microservice_Spec.md` §2.1.1 / §3.
   */
  parseImagesInDoc?: boolean;
  /** Extra service: run OCR on scanned / image-only pages. */
  ocr?: boolean;
  /** Extra service: detect tables and render them as Markdown in the text. */
  detectTables?: boolean;
  /**
   * Extra service: BCP-47 language hint for OCR / transcription (e.g. "de").
   * Only forwarded when the target modality advertises `preferred_language`.
   */
  preferredLanguage?: string;
  /**
   * Extra service: include per-block geometry in the result. Only meaningful
   * for rendered modalities (pdf / image) and only forwarded when the target
   * modality advertises `include_positions`.
   */
  includePositions?: boolean;
  /** Extra service: let the service polish the emitted Markdown. */
  polishMarkdown?: boolean;
  /**
   * Extra service: free-text hint about the document handed to the service
   * (what it is, what matters in it). Only forwarded when the target modality
   * advertises `context`.
   */
  context?: string;
  /**
   * Storage bucket for images the service extracts from the document.
   * Defaults to `PARSED_IMAGES_BUCKET` ("images"). A caller that owns the
   * images afterwards passes its own bucket — the knowledge page importer
   * uses the "knowledge" bucket so the page's file reference tracking and the
   * page-scoped image read apply to them.
   */
  imageBucket?: string;
};

/**
 * Well-known per-modality "extra service" flags a service advertises via
 * `features` (see `ServiceModality`) and a caller opts into via
 * `PdfParserOptions`. Each maps a `camelCase` framework key to the `snake_case`
 * wire name used both in the capabilities `features` map and as the request
 * form field (spec §2.1.1 / §3). This is the single source of truth that keeps
 * capability parsing, request building and any UI in sync.
 */
export const PARSER_PASSTHROUGH_FLAGS = [
  { key: "extractImages", wire: "extract_images", value: "boolean" },
  { key: "parseImagesInDoc", wire: "parse_images_in_doc", value: "boolean" },
  { key: "ocr", wire: "ocr", value: "boolean" },
  { key: "detectTables", wire: "detect_tables", value: "boolean" },
  { key: "preferredLanguage", wire: "preferred_language", value: "string" },
  { key: "includePositions", wire: "include_positions", value: "boolean" },
  { key: "polishMarkdown", wire: "polish_markdown", value: "boolean" },
  { key: "context", wire: "context", value: "string" },
] as const;

/** A `PdfParserOptions` key that corresponds to a pass-through flag. */
export type ParserPassthroughFlag =
  (typeof PARSER_PASSTHROUGH_FLAGS)[number]["key"];


export interface PageContent {
  page: number;
  text: string;
}

export interface PdfParserResult {
  includesImages: boolean;
  model: string;
  pages?: PageContent[];
  /** Extracted key/value metadata, keyed by `ExtractionTarget.key`. */
  metadata?: Record<string, ExtractedValue>;
  /**
   * Non-fatal notes the service reported about *this* result (spec §5
   * `warnings`). The service deliberately returns a partial result instead of
   * failing — a truncated transcript, skipped scan pages, an unsupported mail
   * attachment. Dropping these makes a partial result look complete, so they
   * are carried all the way out of `parseFile` / `parseDocument`.
   */
  warnings?: string[];
}

/**
 * Canonical class of document a parsing service can accept.
 *
 * `text` and `office` are legacy values from the first draft of the spec: no
 * service ever advertised them (the generic service groups every non-media
 * file under `document`). They stay accepted so an older service keeps
 * working, but nothing in the framework treats them specially.
 */
export type ParserModality =
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "document"
  /** @deprecated never advertised by any service — use `document`. */
  | "text"
  /** @deprecated never advertised by any service — use `document`. */
  | "office";

/**
 * Modalities whose parse duration is unbounded in practice (a one-hour
 * recording is transcribed, not read), so they must never block a single HTTP
 * request. These always take the job path when the service advertises `async`
 * for them, regardless of `PDF_PARSER_SERVICE_MODE`.
 */
export const LONG_RUNNING_MODALITIES: ParserModality[] = ["audio", "video"];

/** One modality a service advertises via `GET /v1/capabilities`. */
export type ServiceModality = {
  modality: ParserModality;
  mimeTypes: string[];
  extensions: string[];
  features?: {
    extractImages?: boolean;
    extractFields?: boolean;
    async?: boolean;
    /** Extra service: analyse images embedded in the document. */
    parseImagesInDoc?: boolean;
    /** Extra service: OCR on scanned / image-only pages. */
    ocr?: boolean;
    /** Extra service: detect tables and render them as Markdown. */
    detectTables?: boolean;
    /** Extra service: language hint for OCR / transcription. */
    preferredLanguage?: boolean;
    /** Extra service: per-block geometry (rendered modalities only). */
    includePositions?: boolean;
    /** Extra service: service-side Markdown polishing. */
    polishMarkdown?: boolean;
    /** Extra service: free-text document context handed to the service. */
    context?: boolean;
  };
};

/** The set of modalities a parsing service can process. */
export type ServiceCapabilities = {
  service: string;
  modalities: ServiceModality[];
};

/**
 * MIME types that carry no information: browsers and Windows send these for
 * plenty of files they simply don't know — `.xlsx`, `.eml`, `.opus`, and PDFs
 * as well. Whenever one of them shows up, the file extension is the only
 * routing key left.
 */
export const UNINFORMATIVE_MIME_TYPES = [
  "",
  "application/octet-stream",
  "application/x-download",
  "binary/octet-stream",
] as const;

/** Whether `mimeType` tells us nothing about the file (see above). */
export const isUninformativeMime = (mimeType: string): boolean =>
  (UNINFORMATIVE_MIME_TYPES as readonly string[]).includes(
    mimeType.trim().toLowerCase()
  );

/** The lower-cased extension of a filename, including the dot ("" if none). */
export const fileExtension = (fileName?: string): string => {
  const match = /\.[^./\\]+$/.exec(fileName ?? "");
  return match ? match[0]!.toLowerCase() : "";
};

/**
 * The advertised modality that accepts a file of this MIME type / extension,
 * or `undefined` when none does. Pass `mimeType: undefined` for an
 * uninformative MIME (see `isUninformativeMime`) so the extension decides —
 * matching either key is enough, exactly as `genericParserSupports` does.
 */
export const findServiceModality = (
  modalities: ServiceModality[],
  mimeType?: string,
  extension?: string
): ServiceModality | undefined => {
  const mime = mimeType?.trim().toLowerCase();
  const ext = extension?.toLowerCase();
  return modalities.find(
    (m) =>
      (mime !== undefined && mime !== "" && m.mimeTypes.includes(mime)) ||
      (ext !== undefined && ext !== "" && m.extensions.includes(ext))
  );
};

/**
 * Canonical identifiers for the available PDF parser services.
 *
 * These are the values accepted for `options.model` / `PDF_PARSER_SERVICE`.
 * To add a new parser, add its id here and register the handler in
 * `./index.ts` — nothing else needs to change.
 */
export const PDF_PARSER = {
  /** Symbiosika's own hosted parsing service (formerly called "local"). */
  SYMBIOSIKA_V1: "symbiosika-parse-v1",
  /** Mistral OCR, called directly against the Mistral API. */
  MISTRAL: "mistral",
  /** Mistral OCR, routed through OpenRouter's file-parser plugin. */
  MISTRAL_OPENROUTER: "mistral-openrouter",
  /** LlamaParse (LlamaIndex Cloud). */
  LLAMA: "llama",
  /** Generic self-hosted parsing microservice (X-API-Key + URL from env). */
  GENERIC: "generic",
} as const;

export type PdfParserId = (typeof PDF_PARSER)[keyof typeof PDF_PARSER];

/**
 * Legacy model/env values mapped onto their current parser id, so existing
 * deployments and stored configs keep working after a rename.
 */
export const PDF_PARSER_ALIASES: Record<string, PdfParserId> = {
  // "local" was never actually local — it always called a remote Symbiosika
  // parsing service.
  local: PDF_PARSER.SYMBIOSIKA_V1,
};

/** The parser used when neither `options.model` nor `PDF_PARSER_SERVICE` is set. */
export const DEFAULT_PDF_PARSER: PdfParserId = PDF_PARSER.SYMBIOSIKA_V1;

/**
 * A single PDF parsing implementation.
 */
export type PdfParser = (
  fileContent: File,
  context: PdfParserContext,
  options?: PdfParserOptions
) => Promise<PdfParserResult>;
