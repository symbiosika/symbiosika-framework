import log from "../../../log";
import { parsePdfFileAsMarkdownGeneric } from "./generic";
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
