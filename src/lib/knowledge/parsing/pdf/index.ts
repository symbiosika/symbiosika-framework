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

/**
 * Capabilities of the parsers that cannot be asked at runtime.
 *
 * Only `generic` advertises itself over `GET /v1/capabilities`; for the hosted
 * services we know statically what they accept. Declaring them matters because
 * the import UI renders one checkbox per advertised feature — a parser with no
 * entry offers the user no way to opt into image extraction at all. Parsers
 * absent from this map advertise nothing, which is correct for the ones that
 * take no pass-through options (`symbiosika-parse-v1`, `llama`).
 */
const STATIC_PARSER_CAPABILITIES: Record<string, ServiceCapabilities> = {
  // Mistral OCR: rasterises figures — including pages that are pure vector
  // art, such as diagram exports — and returns them as base64 JPEGs.
  [PDF_PARSER.MISTRAL]: mistralOcrCapabilities(PDF_PARSER.MISTRAL),
  // Same engine, routed through OpenRouter's file-parser plugin.
  [PDF_PARSER.MISTRAL_OPENROUTER]: mistralOcrCapabilities(
    PDF_PARSER.MISTRAL_OPENROUTER
  ),
};

function mistralOcrCapabilities(service: string): ServiceCapabilities {
  return {
    service,
    modalities: [
      {
        modality: "pdf",
        mimeTypes: ["application/pdf"],
        extensions: [".pdf"],
        // OCR is inherent to the engine rather than an opt-in flag, so
        // `extractImages` is the only knob the caller actually controls.
        features: { extractImages: true },
      },
    ],
  };
}

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
 * parser advertises capabilities via `GET /v1/capabilities`; the others are
 * served from `STATIC_PARSER_CAPABILITIES`, and a parser listed in neither
 * returns an empty modality list (no extra services to offer). Meant for
 * consumers that surface the available pass-through options, e.g. an import UI
 * rendering a checkbox per advertised feature.
 *
 * Never throws — a discovery failure degrades gracefully to "no advertised
 * capabilities" so a UI can still render.
 */
export const getConfiguredParserCapabilities =
  async (): Promise<ServiceCapabilities> => {
    const requested = process.env.PDF_PARSER_SERVICE ?? DEFAULT_PDF_PARSER;
    const id = PDF_PARSER_ALIASES[requested] ?? requested;
    if (id !== PDF_PARSER.GENERIC) {
      return STATIC_PARSER_CAPABILITIES[id] ?? { service: id, modalities: [] };
    }
    try {
      return await getGenericParserCapabilities();
    } catch (e) {
      log.error(`Failed to fetch generic parser capabilities: ${e}`);
      return { service: id, modalities: [] };
    }
  };
