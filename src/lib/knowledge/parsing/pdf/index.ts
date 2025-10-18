import { parsePdfFileAsMardownLlama } from "./llama-api";
import { parsePdfFileAsMardownLocal } from "./local-service";
import { parsePdfFileAsMarkdownMistral } from "./mistral-ocr";
import type {
  PdfParserContext,
  PdfParserOptions,
  PdfParserResult,
} from "./types";

export const parsePdfFileAsMardown = async (
  fileContent: File,
  context: PdfParserContext,
  options?: PdfParserOptions
): Promise<PdfParserResult> => {
  const model = options?.model ?? process.env.PDF_PARSER_SERVICE ?? "local";

  if (model === "local") {
    return parsePdfFileAsMardownLocal(fileContent, context, options);
  } else if (model === "mistral") {
    return parsePdfFileAsMarkdownMistral(fileContent, context, options);
  } else if (model === "llama") {
    return parsePdfFileAsMardownLlama(fileContent, context, options);
  } else {
    throw new Error("No PDF parser service configured");
  }
};
