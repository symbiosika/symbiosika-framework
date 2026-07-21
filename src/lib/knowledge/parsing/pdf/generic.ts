import log from "../../../log";
import { saveBase64ImageToStorage } from "./images";
import {
  PDF_PARSER,
  type ExtractedValue,
  type PdfParser,
  type PdfParserOptions,
  type ServiceCapabilities,
  type ServiceModality,
} from "./types";

// Generic self-hosted parsing microservice. See
// `docs/framework/18_PDF_Parser_Generic_Microservice_Spec.md` for the wire
// contract and `19_..._Framework_Integration.md` for this integration.
const API_KEY = process.env.PDF_PARSER_SERVICE_API_KEY;
const BASE_URL = process.env.PDF_PARSER_SERVICE_URL;
// "sync" (default) uses POST /v1/parse; "async" uses the job endpoints.
const MODE = process.env.PDF_PARSER_SERVICE_MODE ?? "sync";

type RawImage = { id: string; base64: string };
type RawPage = { page: number; text: string; images?: RawImage[] };
type RawResult = {
  model: string;
  pages: RawPage[];
  metadata?: Record<string, ExtractedValue>;
};

const authHeaders = (): Record<string, string> => ({
  "X-API-Key": API_KEY as string,
});

const requireConfig = (): void => {
  if (!API_KEY) {
    throw new Error("No API key set for generic parsing service.");
  }
  if (!BASE_URL) {
    throw new Error("No base URL set for generic parsing service.");
  }
};

const buildForm = (file: File, options?: PdfParserOptions): FormData => {
  const form = new FormData();
  form.append("file", file, file.name || "document.pdf");
  form.append("extract_images", String(options?.extractImages ?? false));
  if (options?.extract?.length) {
    form.append("extract", JSON.stringify(options.extract));
  }
  return form;
};

/** Synchronous flow: a single POST /v1/parse. */
const runSync = async (form: FormData): Promise<RawResult> => {
  const res = await fetch(`${BASE_URL}/v1/parse`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Parsing failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RawResult;
};

/** Asynchronous flow: create job -> poll -> fetch result. */
const runAsync = async (form: FormData): Promise<RawResult> => {
  const createRes = await fetch(`${BASE_URL}/v1/jobs`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!createRes.ok) {
    throw new Error(
      `Job creation failed: ${createRes.status} ${createRes.statusText}`
    );
  }
  const { job_id: jobId } = (await createRes.json()) as { job_id: string };
  log.debug(`Generic parser job created: ${jobId}`);

  // Poll until completed/failed.
  let isComplete = false;
  while (!isComplete) {
    const statusRes = await fetch(`${BASE_URL}/v1/jobs/${jobId}`, {
      headers: authHeaders(),
    });
    if (!statusRes.ok) {
      throw new Error(
        `Status check failed: ${statusRes.status} ${statusRes.statusText}`
      );
    }
    const status = (await statusRes.json()) as {
      status: string;
      error?: string;
    };
    log.debug(`Generic parser job ${jobId}: ${status.status}`);
    if (status.status === "completed") {
      isComplete = true;
    } else if (status.status === "failed") {
      throw new Error(`PDF parsing failed: ${status.error ?? "unknown error"}`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const resultRes = await fetch(`${BASE_URL}/v1/jobs/${jobId}/result`, {
    headers: authHeaders(),
  });
  if (!resultRes.ok) {
    throw new Error(
      `Result retrieval failed: ${resultRes.status} ${resultRes.statusText}`
    );
  }
  return (await resultRes.json()) as RawResult;
};

/**
 * Parse a file as markdown using the generic parsing microservice
 * (parser id: "generic").
 */
export const parsePdfFileAsMarkdownGeneric: PdfParser = async (
  fileContent,
  context,
  options
) => {
  requireConfig();

  const form = buildForm(fileContent, options);
  const data = MODE === "async" ? await runAsync(form) : await runSync(form);

  // Save images and rewrite `![id](id)` placeholders to storage paths, exactly
  // as the Mistral OCR parser does.
  let includesImages = false;
  for (const page of data.pages) {
    for (const img of page.images ?? []) {
      const savedPath = await saveBase64ImageToStorage(
        img.base64,
        img.id,
        context.tenantId
      );
      if (!savedPath) {
        continue;
      }
      includesImages = true;
      const ref = new RegExp(`!\\[${img.id}\\]\\(${img.id}\\)`, "g");
      page.text = page.text.replace(ref, `![${img.id}](${savedPath})`);
    }
  }

  return {
    model: data.model ?? PDF_PARSER.GENERIC,
    pages: data.pages.map((p) => ({ page: p.page, text: p.text })),
    includesImages,
    metadata: data.metadata,
  };
};

// --- Capability discovery ---------------------------------------------------

let cachedCapabilities: ServiceCapabilities | null = null;

/**
 * Fetch (and cache in-process) the modalities the generic parsing service
 * advertises via `GET /v1/capabilities`. The service guarantees a cheap, stable
 * response, so caching for the lifetime of the process is safe.
 */
export const getGenericParserCapabilities =
  async (): Promise<ServiceCapabilities> => {
    if (cachedCapabilities) {
      return cachedCapabilities;
    }
    requireConfig();

    const res = await fetch(`${BASE_URL}/v1/capabilities`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `Capabilities fetch failed: ${res.status} ${res.statusText}`
      );
    }
    const raw = (await res.json()) as {
      service: string;
      modalities: {
        modality: ServiceModality["modality"];
        mime_types: string[];
        extensions: string[];
        features?: Record<string, boolean>;
      }[];
    };

    cachedCapabilities = {
      service: raw.service,
      modalities: raw.modalities.map((m) => ({
        modality: m.modality,
        mimeTypes: m.mime_types,
        extensions: m.extensions,
        features: {
          extractImages: m.features?.extract_images ?? false,
          extractFields: m.features?.extract_fields ?? false,
          async: m.features?.async ?? false,
        },
      })),
    };
    return cachedCapabilities;
  };

/** Reset the in-process capabilities cache (mainly for tests). */
export const resetGenericParserCapabilitiesCache = (): void => {
  cachedCapabilities = null;
};

/**
 * Whether the generic parsing service accepts a file of the given MIME type
 * and/or extension, based on its advertised capabilities.
 */
export const genericParserSupports = async (
  mimeType?: string,
  extension?: string
): Promise<boolean> => {
  const caps = await getGenericParserCapabilities();
  const ext = extension?.toLowerCase();
  return caps.modalities.some(
    (m) =>
      (mimeType !== undefined && m.mimeTypes.includes(mimeType)) ||
      (ext !== undefined && m.extensions.includes(ext))
  );
};
