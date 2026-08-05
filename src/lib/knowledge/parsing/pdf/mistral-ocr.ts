import log from "../../../log";
import { resolveImageReferences } from "./images";
import {
  PDF_PARSER,
  type PdfParserContext,
  type PdfParserOptions,
  type PdfParserResult,
} from "./types";

/**
 * Read the key on every call instead of once at module load. The module is
 * pulled in transitively by ./index, so a load-time snapshot would capture
 * whatever the environment looked like at the very first import — which is
 * before a test file (or any late .env loading) gets a chance to set the key.
 */
const getMistralApiKey = () => process.env.MISTRAL_API_KEY;
const MISTRAL_API_BASE_URL = "https://api.mistral.ai/v1";

// https://docs.mistral.ai/capabilities/document/

type MistralOcrResult = {
  pages: {
    images?: {
      id: string;
      /** null when the OCR request did not ask for base64 image payloads */
      image_base64: string | null;
    }[];
    markdown: string;
  }[];
};

/**
 * Parse a PDF file as markdown using the Mistral OCR service
 */
export const parsePdfFileAsMarkdownMistral = async (
  fileContent: File,
  context: PdfParserContext,
  options?: PdfParserOptions
): Promise<PdfParserResult> => {
  const MISTRAL_API_KEY = getMistralApiKey();
  if (!MISTRAL_API_KEY) {
    throw new Error("No API key set for Mistral API.");
  }

  try {
    log.debug("Uploading file to Mistral API...");
    // Create FormData and append file
    const formData = new FormData();
    formData.append("purpose", "ocr");
    formData.append("file", fileContent);

    // Upload file
    const uploadResponse = await fetch(`${MISTRAL_API_BASE_URL}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
      body: formData,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(
        `Upload failed: ${uploadResponse.statusText} - ${errorText}`
      );
    }

    const uploadResult: any = await uploadResponse.json();
    log.debug("File uploaded successfully");

    // Get signed URL for the uploaded file
    const signedUrlResponse = await fetch(
      `${MISTRAL_API_BASE_URL}/files/${uploadResult.id}/url?expiry=24`,
      {
        headers: {
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
        },
      }
    );

    if (!signedUrlResponse.ok) {
      throw new Error(
        `Failed to get signed URL: ${signedUrlResponse.statusText}`
      );
    }

    const { url: signedUrl } = (await signedUrlResponse.json()) as {
      url: string;
    };

    log.debug("Got signed URL for file");

    // Process OCR
    log.debug("Processing OCR...");
    const ocrResponse = await fetch(`${MISTRAL_API_BASE_URL}/ocr`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: "mistral-ocr-latest",
        document: {
          type: "document_url",
          document_url: signedUrl,
        },
        include_image_base64: options?.extractImages ?? true,
      }),
    });

    if (!ocrResponse.ok) {
      const errorText = await ocrResponse.text();
      throw new Error(
        `OCR processing failed: ${ocrResponse.statusText} - ${errorText}`
      );
    }

    const ocrResult: MistralOcrResult =
      (await ocrResponse.json()) as MistralOcrResult;
    log.debug("OCR result retrieved successfully.");

    // Process images from all pages. Mistral still lists the detected images
    // when `include_image_base64` is false, but with `image_base64: null`. The
    // pages are walked either way: the markdown carries `![id](id)`
    // placeholders for every listed image, and one we cannot persist has to be
    // removed rather than shipped as a dead link.
    const extractImages = options?.extractImages ?? true;
    let savedCount = 0;
    for (const page of ocrResult.pages) {
      const { text, savedPaths } = await resolveImageReferences(
        page.markdown,
        (page.images ?? []).map((i) => ({ id: i.id, base64: i.image_base64 })),
        context.tenantId,
        extractImages
      );
      page.markdown = text;
      savedCount += savedPaths.length;
    }

    // Delete the uploaded file from Mistral's servers
    await fetch(`${MISTRAL_API_BASE_URL}/files/${uploadResult.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
    });

    return {
      pages: ocrResult.pages.map((page, index) => ({
        page: index + 1,
        text: page.markdown,
      })),
      includesImages: savedCount > 0,
      model: PDF_PARSER.MISTRAL,
    };
  } catch (error) {
    log.error(`OCR processing failed: ${error}`);
    throw new Error(`OCR processing failed: ${error}`);
  }
};
