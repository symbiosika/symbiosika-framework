import log from "../../../log";
import {
  parsePdfFileAsMarkdownGeneric,
  getGenericParserCapabilities,
} from "./generic";
import { parsePdfFileAsMarkdownLlama } from "./llama-api";
import { parsePdfFileAsMarkdownMistral } from "./mistral-ocr";
import { parsePdfFileAsMarkdownMistralOpenRouter } from "./mistral-openrouter";
import { parsePdfFileAsMarkdownSymbiosika } from "./symbiosika-parse";
import {
  DEFAULT_PDF_PARSER,
  PDF_PARSER,
  PDF_PARSER_ALIASES,
  type PdfParser,
  type PdfParserContext,
  type PdfParserOptions,
  type PdfParserResult,
  type ServiceCapabilities,
} from "./types";

/**
 * Registry of available PDF parser services, keyed by their canonical id.
 *
 * To add a new parser: implement it as a `PdfParser`, then add one entry here
 * (and its id to `PDF_PARSER` in `./types.ts`). Nothing else needs to change.
 */
const PDF_PARSERS: Record<string, PdfParser> = {
  [PDF_PARSER.SYMBIOSIKA_V1]: parsePdfFileAsMarkdownSymbiosika,
  [PDF_PARSER.MISTRAL]: parsePdfFileAsMarkdownMistral,
  [PDF_PARSER.MISTRAL_OPENROUTER]: parsePdfFileAsMarkdownMistralOpenRouter,
  [PDF_PARSER.LLAMA]: parsePdfFileAsMarkdownLlama,
  [PDF_PARSER.GENERIC]: parsePdfFileAsMarkdownGeneric,
};

/** Resolve a requested model id to a registered parser, applying legacy aliases. */
const resolveParser = (requested: string): PdfParser => {
  const id = PDF_PARSER_ALIASES[requested] ?? requested;
  const parser = PDF_PARSERS[id];
  if (!parser) {
    throw new Error(
      `Unknown PDF parser service "${requested}". Available: ${Object.keys(
        PDF_PARSERS
      ).join(", ")}`
    );
  }
  if (id !== requested) {
    log.debug(`PDF parser "${requested}" resolved to "${id}" (legacy alias).`);
  }
  return parser;
};

export const parsePdfFileAsMardown = async (
  fileContent: File,
  context: PdfParserContext,
  options?: PdfParserOptions
): Promise<PdfParserResult> => {
  const requested =
    options?.model ?? process.env.PDF_PARSER_SERVICE ?? DEFAULT_PDF_PARSER;
  const parser = resolveParser(requested);
  return parser(fileContent, context, options);
};

/**
 * Resolve the capabilities (advertised modalities + per-modality feature
 * flags) of the currently configured parser service. Only the `generic`
 * parser advertises capabilities via `GET /v1/capabilities`; every other
 * parser returns an empty modality list (no extra services to offer). Meant
 * for consumers that surface the available pass-through options, e.g. an
 * import UI rendering a checkbox per advertised feature.
 *
 * Never throws — a discovery failure degrades gracefully to "no advertised
 * capabilities" so a UI can still render.
 */
export const getConfiguredParserCapabilities =
  async (): Promise<ServiceCapabilities> => {
    const requested = process.env.PDF_PARSER_SERVICE ?? DEFAULT_PDF_PARSER;
    const id = PDF_PARSER_ALIASES[requested] ?? requested;
    if (id !== PDF_PARSER.GENERIC) {
      return { service: id, modalities: [] };
    }
    try {
      return await getGenericParserCapabilities();
    } catch (e) {
      log.error(`Failed to fetch generic parser capabilities: ${e}`);
      return { service: id, modalities: [] };
    }
  };
