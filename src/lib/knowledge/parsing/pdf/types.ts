export type PdfParserContext = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
};

export type PdfParserOptions = {
  model?: string;
  extractImages?: boolean;
};

export interface PageContent {
  page: number;
  text: string;
}

export interface PdfParserResult {
  includesImages: boolean;
  model: string;
  pages?: PageContent[];
}

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
