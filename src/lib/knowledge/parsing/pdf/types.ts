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

/**
 * Extra options handed to the parsing service for one call.
 *
 * Deliberately an OPEN map instead of a field per option: the service says
 * which flags it understands per modality (`GET /v1/capabilities` →
 * `modalities[].features`), and whatever the caller puts here is forwarded
 * when the target modality advertises it and dropped when it does not. A new
 * extra service on the service side therefore needs no change in the
 * framework — there is no option list here to keep in lockstep with it.
 *
 * Keys are the service's own wire names (`snake_case`, e.g. `detect_tables`);
 * camelCase is accepted too and converted (`detectTables` → `detect_tables`).
 * Values travel as multipart form fields, so a boolean is sent as `"true"` /
 * `"false"` and a number as its decimal string. An empty string is dropped.
 */
export type ServiceOptions = Record<string, string | number | boolean>;

/**
 * Feature flags the framework itself reasons about, by their advertised wire
 * name. Everything else in `ServiceModality.features` is only ever compared
 * against a caller-supplied `ServiceOptions` key — the framework never needs
 * to know what it means.
 */
export const SERVICE_FEATURE = {
  /** Return embedded images as base64 (the framework then stores them). */
  EXTRACT_IMAGES: "extract_images",
  /** Accept `extract` targets and return `metadata`. */
  EXTRACT_FIELDS: "extract_fields",
  /** Offers the job endpoints in addition to `POST /v1/parse`. */
  ASYNC: "async",
} as const;

/**
 * The wire name of a service option: `detectTables` → `detect_tables`. A key
 * already given in wire form passes through unchanged, so a caller can use
 * either spelling.
 */
export const toServiceOptionWireName = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

/**
 * Named extra-service flags the framework accepted before service options
 * became an open map. They are folded into `ServiceOptions` under the same
 * wire names they always had, so existing callers and the import endpoint keep
 * working unchanged. Nothing new belongs in this list — a new flag is
 * advertised by the service and named by the caller in `serviceOptions`.
 *
 * @deprecated pass extra options via `serviceOptions`.
 */
export const LEGACY_SERVICE_OPTION_KEYS = [
  "parseImagesInDoc",
  "ocr",
  "detectTables",
] as const;

/** The legacy named flags, all optional. @deprecated see above. */
export type LegacyServiceOptions = Partial<
  Record<(typeof LEGACY_SERVICE_OPTION_KEYS)[number], boolean>
>;

/**
 * Fold the legacy named flags into an open service-option map. An explicit
 * `serviceOptions` entry wins over a legacy field of the same meaning.
 * Returns `undefined` when nothing was set at all.
 */
export const withLegacyServiceOptions = (
  serviceOptions?: ServiceOptions,
  legacy?: LegacyServiceOptions
): ServiceOptions | undefined => {
  const merged: ServiceOptions = {};
  for (const key of LEGACY_SERVICE_OPTION_KEYS) {
    const value = legacy?.[key];
    if (value !== undefined) merged[toServiceOptionWireName(key)] = value;
  }
  for (const [key, value] of Object.entries(serviceOptions ?? {})) {
    if (value !== undefined) merged[toServiceOptionWireName(key)] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export type PdfParserOptions = {
  model?: string;
  /**
   * Ask the service for the images embedded in the document. Typed rather than
   * left to `serviceOptions` because the framework acts on the answer: it
   * stores what comes back and rewrites the placeholders in the page text.
   */
  extractImages?: boolean;
  /** Structured extraction targets passed through to the service. */
  extract?: ExtractionTarget[];
  /**
   * Extra options forwarded to the service as-is, gated by what the target
   * modality advertises. See `ServiceOptions`.
   */
  serviceOptions?: ServiceOptions;
  /**
   * Storage bucket for images the service extracts from the document.
   * Defaults to `PARSED_IMAGES_BUCKET` ("images"). A caller that owns the
   * images afterwards passes its own bucket — the knowledge page importer
   * uses the "knowledge" bucket so the page's file reference tracking and the
   * page-scoped image read apply to them.
   */
  imageBucket?: string;
};

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
  /**
   * What this modality can do, exactly as advertised: an open map of wire
   * names (`snake_case`) to booleans (spec §2.1.1). Kept open on purpose —
   * a flag nobody in the framework has heard of still has to be honoured when
   * a caller asks for it via `ServiceOptions`. `SERVICE_FEATURE` names the
   * handful the framework itself interprets. A flag that is absent means
   * "not offered".
   */
  features?: Record<string, boolean>;
};

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
