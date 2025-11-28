import log from "../../../log";
import { saveFile } from "../../../storage";
import type {
  PdfParserContext,
  PdfParserOptions,
  PdfParserResult,
} from "./types";

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_API_BASE_URL = "https://api.mistral.ai/v1";

// https://docs.mistral.ai/capabilities/document/

type MistralOcrResult = {
  pages: {
    images?: {
      id: string;
      image_base64: string;
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

    // Process images from all pages
    const imageMap = new Map<string, string>(); // Maps image ID to URL
    for (const page of ocrResult.pages) {
      if (page.images) {
        for (const image of page.images) {
          // Convert base64 to blob
          const base64Data = image.image_base64.split(",")[1];
          if (!base64Data) {
            continue;
          }
          const binaryData = atob(base64Data);
          const bytes = new Uint8Array(binaryData.length);
          for (let i = 0; i < binaryData.length; i++) {
            bytes[i] = binaryData.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: "image/jpeg" });
          const file = new File([blob], image.id, { type: "image/jpeg" });

          // Save file to storage
          const savedFile = await saveFile(
            file,
            "images",
            context.tenantId,
            "db"
          );
          imageMap.set(image.id, savedFile.path);

          // replace the image reference with the new image path
          const imageRef = new RegExp(
            `!\\[${image.id}\\]\\(${image.id}\\)`,
            "g"
          );
          page.markdown = page.markdown.replace(
            imageRef,
            `![${image.id}](${savedFile.path})`
          );
        }
      }
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
      includesImages: imageMap.size > 0,
      model: "mistral",
    };
  } catch (error) {
    log.error(`OCR processing failed: ${error}`);
    throw new Error(`OCR processing failed: ${error}`);
  }
};
