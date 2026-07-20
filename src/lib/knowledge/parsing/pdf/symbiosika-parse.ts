import log from "../../../log";
import {
  PDF_PARSER,
  type PdfParserContext,
  type PdfParserOptions,
  type PdfParserResult,
} from "./types";

// The service was historically called "local" although it always ran as a
// remote HTTP service. Env vars keep a backward-compatible fallback to the old
// `LOCAL_PDF_PARSER_*` names.
const SYMBIOSIKA_API_KEY =
  process.env.SYMBIOSIKA_PARSE_API_KEY ?? process.env.LOCAL_PDF_PARSER_API_KEY;
const SYMBIOSIKA_API_BASE_URL =
  process.env.SYMBIOSIKA_PARSE_BASE_URL ??
  process.env.LOCAL_PDF_PARSER_BASE_URL ??
  "";

// Define interfaces for the API response structure
interface PdfParserPage {
  page: number;
  text: string;
}

interface PdfParserRawContent {
  num_pages: number;
  content: PdfParserPage[];
}

interface PdfParserChunkMetadata {
  source: string;
  chunk_index: number;
}

interface PdfParserChunk {
  id: string;
  text: string;
  metadata: PdfParserChunkMetadata;
}

interface SymbiosikaParserResult {
  job_id: string;
  original_filename: string;
  num_pages: number;
  num_chunks: number;
  raw_content: PdfParserRawContent;
  chunked_content: PdfParserChunk[];
  markdown?: string;
  text?: string;
}

/**
 * Parse a PDF file as markdown using the Symbiosika parsing service
 * (parser id: "symbiosika-parse-v1", formerly "local").
 */
export const parsePdfFileAsMarkdownSymbiosika = async (
  fileContent: File,
  context: PdfParserContext,
  options?: PdfParserOptions
): Promise<PdfParserResult> => {
  if (!SYMBIOSIKA_API_KEY) {
    throw new Error("No API key set for Symbiosika parsing service.");
  }

  if (!SYMBIOSIKA_API_BASE_URL) {
    throw new Error("No base URL set for Symbiosika parsing service.");
  }

  // Upload file and start parsing
  const formData = new FormData();
  formData.append("file", fileContent, "document.pdf");

  log.debug("Uploading file to Symbiosika parsing service...");
  const uploadResponse = await fetch(`${SYMBIOSIKA_API_BASE_URL}/upload`, {
    method: "POST",
    body: formData,
    headers: {
      "X-API-Key": SYMBIOSIKA_API_KEY,
    },
  }).catch((error) => {
    log.error(`Upload failed: ${error}`);
    throw new Error(`Upload failed: ${error}`);
  });

  if (!uploadResponse.ok) {
    log.error(`Upload failed: ${uploadResponse.statusText}`);
    throw new Error(`Upload failed: ${uploadResponse.statusText}`);
  }

  const uploadedJobData: any = await uploadResponse.json();
  const jobId: string = uploadedJobData.job_id;
  log.debug(`Job ID: ${jobId}`);

  // Poll for job completion
  let isComplete = false;
  while (!isComplete) {
    const statusResponse = await fetch(
      `${SYMBIOSIKA_API_BASE_URL}/jobs/${jobId}`,
      {
        headers: { "X-API-Key": SYMBIOSIKA_API_KEY },
      }
    );

    if (!statusResponse.ok) {
      log.error(`Status check failed: ${statusResponse.statusText}`);
      throw new Error(`Status check failed: ${statusResponse.statusText}`);
    }

    const statusData: any = await statusResponse.json();
    log.debug(`Status: ${statusData.status}`);
    isComplete = statusData.status === "completed";

    if (statusData.status === "failed") {
      const errorMsg = statusData.error || "Unknown error";
      log.error(`Job failed: ${errorMsg}`);
      throw new Error(`PDF parsing failed: ${errorMsg}`);
    }

    if (!isComplete) await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Get results
  const resultResponse = await fetch(
    `${SYMBIOSIKA_API_BASE_URL}/jobs/${jobId}/result`,
    {
      headers: { "X-API-Key": SYMBIOSIKA_API_KEY },
    }
  );

  if (!resultResponse.ok) {
    log.error(`Result retrieval failed: ${resultResponse.statusText}`);
    throw new Error(`Result retrieval failed: ${resultResponse.statusText}`);
  }

  log.debug("Result retrieved successfully.");
  const result = (await resultResponse.json()) as SymbiosikaParserResult;

  // Create pages array with page numbers and content
  const pages =
    result.raw_content?.content?.map((page) => ({
      page: page.page,
      text: page.text,
    })) || [];

  return {
    includesImages: false,
    model: PDF_PARSER.SYMBIOSIKA_V1,
    pages: pages, // Add pages information
  };
};
