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
  findServiceModality,
  fileExtension,
  isUninformativeMime,
  PDF_PARSER,
  PDF_PARSER_ALIASES,
  SERVICE_FEATURE,
  type PdfParser,
  type PdfParserContext,
  type PdfParserOptions,
  type PdfParserResult,
  type ServiceCapabilities,
  type ServiceModality,
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
        // image extraction is the only knob the caller actually controls.
        features: { [SERVICE_FEATURE.EXTRACT_IMAGES]: true },
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

/**
 * Hand one file to the configured parsing service. Not PDF-only any more — the
 * service decides what it accepts (see `configuredParserSupports`), so this
 * takes documents, images, audio and video just the same.
 */
export const parseFileWithService = async (
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
 * Former name of `parseFileWithService`, kept for existing callers.
 * @deprecated use `parseFileWithService` — the service parses more than PDFs.
 */
export const parsePdfFileAsMardown = parseFileWithService;

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
export const getConfiguredParserCapabilities = async (
  /**
   * Parser to ask about, for a call site that selects one explicitly
   * (`PdfParserOptions.model`). Defaults to `PDF_PARSER_SERVICE`, i.e. the
   * service a parse would actually go to.
   */
  requestedParser?: string
): Promise<ServiceCapabilities> => {
  const requested =
    requestedParser ?? process.env.PDF_PARSER_SERVICE ?? DEFAULT_PDF_PARSER;
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

/**
 * The one format every parser service handles, used when the configured
 * service advertises nothing: either it has no discovery endpoint (`llama`,
 * `symbiosika-parse-v1`) or `/v1/capabilities` was unreachable. Without this,
 * a discovery hiccup would stop PDF imports — which is why it exists and why
 * it holds nothing but PDF. Everything else must be advertised.
 */
const PDF_ONLY_FALLBACK: ServiceModality = {
  modality: "pdf",
  mimeTypes: ["application/pdf"],
  extensions: [".pdf"],
};

/**
 * Whether the configured parsing service accepts this file — asked of the
 * service (`GET /v1/capabilities`) rather than answered from a format list
 * the framework would have to maintain in lockstep with it.
 *
 * `mimeType` should be left `undefined` for an uninformative MIME (see
 * `isUninformativeMime`), so the extension decides: browsers and Windows send
 * `""` or `application/octet-stream` for `.xlsx`, `.eml` and `.opus` just as
 * they do for `.pdf`.
 *
 * Never throws (`getConfiguredParserCapabilities` degrades to "advertises
 * nothing"), and always accepts PDF — see `PDF_ONLY_FALLBACK`.
 */
export const configuredParserSupports = async (
  mimeType?: string,
  extension?: string,
  /** Parser to ask about; defaults to the configured one. */
  requestedParser?: string
): Promise<boolean> => {
  const caps = await getConfiguredParserCapabilities(requestedParser);
  return (
    findServiceModality(caps.modalities, mimeType, extension) !== undefined ||
    findServiceModality([PDF_ONLY_FALLBACK], mimeType, extension) !== undefined
  );
};

/**
 * `configuredParserSupports` for a `File`: derives the routing keys (MIME,
 * falling back to the extension when the MIME is uninformative).
 */
export const configuredParserSupportsFile = async (
  file: File,
  requestedParser?: string
): Promise<boolean> => {
  const mime = (file.type ?? "").split(";")[0]!.trim().toLowerCase();
  return configuredParserSupports(
    isUninformativeMime(mime) ? undefined : mime,
    fileExtension(file.name),
    requestedParser
  );
};
