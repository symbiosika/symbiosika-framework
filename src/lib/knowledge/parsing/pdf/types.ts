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
}

/** Canonical class of document a parsing service can accept. */
export type ParserModality =
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "text"
  | "office";

/** One modality a service advertises via `GET /v1/capabilities`. */
export type ServiceModality = {
  modality: ParserModality;
  mimeTypes: string[];
  extensions: string[];
  features?: {
    extractImages?: boolean;
    extractFields?: boolean;
    async?: boolean;
  };
};

/** The set of modalities a parsing service can process. */
export type ServiceCapabilities = {
  service: string;
  modalities: ServiceModality[];
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
