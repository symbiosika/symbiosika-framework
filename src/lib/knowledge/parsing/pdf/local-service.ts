import log from "../../../log";
import type {
  PdfParserContext,
  PdfParserOptions,
  PdfParserResult,
} from "./types";

const LOCAL_API_KEY = process.env.LOCAL_PDF_PARSER_API_KEY;
const LOCAL_API_BASE_URL = process.env.LOCAL_PDF_PARSER_BASE_URL ?? "";

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

interface LocalParserResult {
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
 * Parse a PDF file as markdown using the local PDF parsing service
 */
export const parsePdfFileAsMardownLocal = async (
  fileContent: File,
  context: PdfParserContext,
  options?: PdfParserOptions,
): Promise<PdfParserResult> => {
  if (!LOCAL_API_KEY) {
    throw new Error("No API key set for local PDF parser API.");
  }

  if (!LOCAL_API_BASE_URL) {
    throw new Error("No base URL set for local PDF parser API.");
  }

  // Upload file and start parsing
  const formData = new FormData();
  formData.append("file", fileContent, "document.pdf");

  log.debug("Uploading file to local PDF parser API...");
  const uploadResponse = await fetch(`${LOCAL_API_BASE_URL}/upload`, {
    method: "POST",
    body: formData,
    headers: {
      "X-API-Key": LOCAL_API_KEY,
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
    const statusResponse = await fetch(`${LOCAL_API_BASE_URL}/jobs/${jobId}`, {
      headers: { "X-API-Key": LOCAL_API_KEY },
    });

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
    `${LOCAL_API_BASE_URL}/jobs/${jobId}/result`,
    {
      headers: { "X-API-Key": LOCAL_API_KEY },
    },
  );

  if (!resultResponse.ok) {
    log.error(`Result retrieval failed: ${resultResponse.statusText}`);
    throw new Error(`Result retrieval failed: ${resultResponse.statusText}`);
  }

  log.debug("Result retrieved successfully.");
  const result = (await resultResponse.json()) as LocalParserResult;

  // Create pages array with page numbers and content
  const pages =
    result.raw_content?.content?.map((page) => ({
      page: page.page,
      text: page.text,
    })) || [];

  return {
    includesImages: false,
    model: "local",
    pages: pages, // Add pages information
  };
};
