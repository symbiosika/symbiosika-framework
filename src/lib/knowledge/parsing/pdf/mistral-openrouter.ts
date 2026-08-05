import log from "../../../log";
import {
  saveBase64ImageToStorage,
  stripUnresolvedImageReferences,
} from "./images";
import {
  PDF_PARSER,
  type PdfParserContext,
  type PdfParserOptions,
  type PdfParserResult,
} from "./types";

// https://openrouter.ai/docs/features/multimodal/pdfs
//
// OpenRouter runs Mistral OCR behind its `file-parser` plugin. We send the PDF
// as a base64 data URL and read the parsed content back from the response's
// file annotations, so no downstream completion is actually needed.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
// Any model works — parsing happens in the plugin before inference. We use a
// small, cheap model and cap the completion, since we only care about the
// parsed annotations, not the model's reply.
const OPENROUTER_PDF_MODEL =
  process.env.OPENROUTER_PDF_MODEL ?? "mistralai/mistral-small-3.2-24b-instruct";

// Optional attribution headers recommended by OpenRouter.
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER;
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE;

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type FileAnnotation = {
  type: "file";
  file: {
    hash: string;
    name?: string;
    content: ContentPart[];
  };
};

const isFileAnnotation = (value: unknown): value is FileAnnotation => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; file?: { hash?: unknown } };
  return candidate.type === "file" && typeof candidate.file?.hash === "string";
};

/**
 * Collect file annotations from both the success path
 * (`choices[].message.annotations`) and the error path
 * (`error.metadata.file_annotations`), deduped by file hash.
 */
const extractFileAnnotations = (response: unknown): FileAnnotation[] => {
  if (typeof response !== "object" || response === null) return [];

  const root = response as {
    choices?: Array<{ message?: { annotations?: unknown[] } }>;
    error?: { metadata?: { file_annotations?: unknown[] } };
  };

  const fromMessage = root.choices?.[0]?.message?.annotations ?? [];
  const fromError = root.error?.metadata?.file_annotations ?? [];

  const seen = new Set<string>();
  const out: FileAnnotation[] = [];
  for (const a of [...fromMessage, ...fromError]) {
    if (isFileAnnotation(a) && !seen.has(a.file.hash)) {
      seen.add(a.file.hash);
      out.push(a);
    }
  }
  return out;
};

/**
 * Parse a PDF file as markdown using Mistral OCR through OpenRouter's
 * `file-parser` plugin (parser id: "mistral-openrouter").
 */
export const parsePdfFileAsMarkdownMistralOpenRouter = async (
  fileContent: File,
  context: PdfParserContext,
  options?: PdfParserOptions
): Promise<PdfParserResult> => {
  if (!OPENROUTER_API_KEY) {
    throw new Error("No API key set for OpenRouter API.");
  }

  try {
    // Encode the PDF as a base64 data URL.
    const buffer = Buffer.from(await fileContent.arrayBuffer());
    const dataUrl = `data:application/pdf;base64,${buffer.toString("base64")}`;
    const filename = fileContent.name || "document.pdf";

    log.debug("Sending PDF to OpenRouter file-parser (mistral-ocr)...");
    const response = await fetch(
      `${OPENROUTER_API_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          ...(OPENROUTER_REFERER ? { "HTTP-Referer": OPENROUTER_REFERER } : {}),
          ...(OPENROUTER_TITLE ? { "X-Title": OPENROUTER_TITLE } : {}),
        },
        body: JSON.stringify({
          model: OPENROUTER_PDF_MODEL,
          // We only need the parsed annotations, not a real completion.
          max_tokens: 1,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Parse this document." },
                {
                  type: "file",
                  file: {
                    filename,
                    file_data: dataUrl,
                  },
                },
              ],
            },
          ],
          plugins: [
            {
              id: "file-parser",
              pdf: {
                engine: "mistral-ocr",
              },
            },
          ],
          stream: false,
        }),
      }
    );

    const responseBody: any = await response.json();

    // OpenRouter can return parsed annotations even when the downstream model
    // fails, so we try to extract them regardless of HTTP status before
    // deciding the request failed.
    const annotations = extractFileAnnotations(responseBody);

    if (annotations.length === 0) {
      if (!response.ok) {
        const message =
          responseBody?.error?.message || response.statusText || "Unknown error";
        throw new Error(`OpenRouter OCR failed: ${message}`);
      }
      throw new Error("OpenRouter OCR returned no parsed file content.");
    }

    log.debug("OpenRouter OCR annotations retrieved successfully.");

    // Flatten all annotation content parts, preserving order. Mistral OCR emits
    // one text block per page, so each text part becomes a page; images are
    // persisted to storage and their markdown references rewritten in order.
    const pages: { page: number; text: string }[] = [];
    const savedImagePaths: string[] = [];

    for (const annotation of annotations) {
      for (const part of annotation.file.content) {
        if (part.type === "text") {
          pages.push({ page: pages.length + 1, text: part.text });
        } else if (
          part.type === "image_url" &&
          (options?.extractImages ?? true)
        ) {
          const path = await saveBase64ImageToStorage(
            part.image_url.url,
            `or-img-${savedImagePaths.length}.jpeg`,
            context.tenantId
          );
          if (path) savedImagePaths.push(path);
        }
      }
    }

    // Best-effort: rewrite markdown image references (in order of appearance)
    // to point at the stored image paths. References beyond the images we
    // actually stored — and all of them when extraction was off — are stripped
    // by the sweep below rather than left pointing at an unresolvable target.
    let imageIndex = 0;
    for (const page of pages) {
      page.text = page.text.replace(
        /!\[([^\]]*)\]\(([^)]*)\)/g,
        (match, alt) => {
          const path = savedImagePaths[imageIndex];
          if (path === undefined) return match;
          imageIndex += 1;
          return `![${alt}](${path})`;
        }
      );
      page.text = stripUnresolvedImageReferences(page.text);
    }

    return {
      pages: pages.length > 0 ? pages : [{ page: 1, text: "" }],
      includesImages: savedImagePaths.length > 0,
      model: PDF_PARSER.MISTRAL_OPENROUTER,
    };
  } catch (error) {
    log.error(`OpenRouter OCR processing failed: ${error}`);
    throw new Error(`OpenRouter OCR processing failed: ${error}`);
  }
};
