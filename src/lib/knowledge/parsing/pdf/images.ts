import { saveFile } from "../../../storage";

/**
 * Persist a base64-encoded image (raw base64 or a `data:` URL) to storage and
 * return the stored file path. Returns null when the payload is empty.
 *
 * Shared by the Mistral OCR parsers, which receive extracted images as base64.
 */
export const saveBase64ImageToStorage = async (
  base64OrDataUrl: string,
  id: string,
  tenantId: string
): Promise<string | null> => {
  // Accept both raw base64 and `data:<mime>;base64,<payload>` URLs.
  const base64Data = base64OrDataUrl.includes(",")
    ? base64OrDataUrl.split(",")[1]
    : base64OrDataUrl;

  if (!base64Data) {
    return null;
  }

  const bytes = Buffer.from(base64Data, "base64");
  const blob = new Blob([bytes], { type: "image/jpeg" });
  const file = new File([blob], id, { type: "image/jpeg" });

  const savedFile = await saveFile(file, "images", tenantId, "db");
  return savedFile.path;
};
