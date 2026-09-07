import log from "../../../log";
import { resolveImageReferences } from "./images";
import {
  findServiceModality,
  fileExtension,
  isUninformativeMime,
  LONG_RUNNING_MODALITIES,
  PDF_PARSER,
  SERVICE_FEATURE,
  toServiceOptionWireName,
  type ExtractedValue,
  type PdfParser,
  type PdfParserOptions,
  type ServiceCapabilities,
  type ServiceModality,
} from "./types";

// Generic self-hosted parsing microservice. See
// `docs/framework/18_PDF_Parser_Generic_Microservice_Spec.md` for the wire
// contract and `19_..._Framework_Integration.md` for this integration.
//
// Config is read lazily (at call time, not module load) so the parser can be
// registered/imported before the environment is fully set up — and so tests
// can point it at a local server.
const getApiKey = (): string | undefined =>
  process.env.PDF_PARSER_SERVICE_API_KEY;
const getBaseUrl = (): string | undefined => process.env.PDF_PARSER_SERVICE_URL;
// "sync" (default) uses POST /v1/parse; "async" uses the job endpoints.
const getMode = (): string => process.env.PDF_PARSER_SERVICE_MODE ?? "sync";

type RawImage = {
  id: string;
  base64: string;
  /**
   * What the service recognised on the picture (spec §3 `pages[].images[]`).
   * Optional: only services with the `parse_images_in_doc` feature describe
   * their images, and only when the caller asked for it.
   */
  description?: string | null;
};
type RawPage = { page: number; text: string; images?: RawImage[] };
type RawResult = {
  model: string;
  pages: RawPage[];
  metadata?: Record<string, ExtractedValue>;
  /**
   * Non-fatal notes about this result (spec §5). The service returns a partial
   * result rather than failing — a truncated transcript, skipped scan pages, a
   * mail attachment it cannot read — and says so here.
   */
  warnings?: string[];
};

const authHeaders = (): Record<string, string> => ({
  "X-API-Key": getApiKey() as string,
});

const requireConfig = (): void => {
  if (!getApiKey()) {
    throw new Error("No API key set for generic parsing service.");
  }
  if (!getBaseUrl()) {
    throw new Error("No base URL set for generic parsing service.");
  }
};

/**
 * Build the multipart request for one file.
 *
 * `modality` is the advertised modality the file routes to, when it could be
 * resolved. Its `features` gate every optional field: the spec says the
 * framework only sends an option for a modality that advertises it, and the
 * generic service enforces that for media — `audio`/`video` reject both
 * `extract` and `extract_images=true` with `unsupported_option` instead of
 * ignoring them. With no resolvable modality (capability discovery down)
 * nothing is gated and the caller's options are sent as-is.
 *
 * Note what is *not* here: a list of known options. Whatever the caller put
 * into `serviceOptions` is forwarded under its wire name if the modality
 * advertises it — so a flag the service gains tomorrow works today.
 */
const buildForm = (
  file: File,
  options?: PdfParserOptions,
  modality?: ServiceModality,
): FormData => {
  const form = new FormData();
  form.append("file", file, file.name || "document.pdf");

  /**
   * A feature map decides strictly. Without one nothing is gated — either the
   * modality could not be resolved (discovery down) or the service does not
   * take part in feature discovery at all, and spec §3 obliges a service to
   * IGNORE an option it does not support rather than fail on it. Dropping the
   * caller's options in that case would silently disable an extra service the
   * third-party service does support.
   */
  const advertises = (feature: string): boolean =>
    modality?.features ? modality.features[feature] === true : true;

  // Always sent (the service defaults it to false anyway); only the `true`
  // value needs the modality's blessing.
  form.append(
    SERVICE_FEATURE.EXTRACT_IMAGES,
    String(
      (options?.extractImages ?? false) &&
        advertises(SERVICE_FEATURE.EXTRACT_IMAGES),
    ),
  );

  // Everything else the caller asked for (spec §3), forwarded verbatim.
  for (const [key, value] of Object.entries(options?.serviceOptions ?? {})) {
    const wire = toServiceOptionWireName(key);
    // Handled above, including its gating — never twice.
    if (wire === SERVICE_FEATURE.EXTRACT_IMAGES) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (!advertises(wire)) {
      log.debug(
        `Parser option "${wire}" is not advertised for modality "${modality?.modality}" — dropped.`,
      );
      continue;
    }
    form.append(wire, String(value));
  }

  if (options?.extract?.length && advertises(SERVICE_FEATURE.EXTRACT_FIELDS)) {
    form.append("extract", JSON.stringify(options.extract));
  }
  return form;
};

/** Synchronous flow: a single POST /v1/parse. */
const runSync = async (form: FormData): Promise<RawResult> => {
  const res = await fetch(`${getBaseUrl()}/v1/parse`, {
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
  const createRes = await fetch(`${getBaseUrl()}/v1/jobs`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!createRes.ok) {
    throw new Error(
      `Job creation failed: ${createRes.status} ${createRes.statusText}`,
    );
  }
  const { job_id: jobId } = (await createRes.json()) as { job_id: string };
  log.debug(`Generic parser job created: ${jobId}`);

  // Poll until completed/failed.
  let isComplete = false;
  while (!isComplete) {
    const statusRes = await fetch(`${getBaseUrl()}/v1/jobs/${jobId}`, {
      headers: authHeaders(),
    });
    if (!statusRes.ok) {
      throw new Error(
        `Status check failed: ${statusRes.status} ${statusRes.statusText}`,
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

  const resultRes = await fetch(`${getBaseUrl()}/v1/jobs/${jobId}/result`, {
    headers: authHeaders(),
  });
  if (!resultRes.ok) {
    throw new Error(
      `Result retrieval failed: ${resultRes.status} ${resultRes.statusText}`,
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
  options,
) => {
  requireConfig();

  const modality = await resolveModalityForFile(fileContent);
  const form = buildForm(fileContent, options, modality);
  const data = useJobPath(modality)
    ? await runAsync(form)
    : await runSync(form);

  // Save images and rewrite `![id](id)` placeholders to storage paths, exactly
  // as the Mistral OCR parser does — dropping the placeholders we cannot
  // resolve so no dead reference reaches the document.
  let includesImages = false;
  for (const page of data.pages) {
    const { text, savedPaths } = await resolveImageReferences(
      page.text,
      page.images ?? [],
      context.tenantId,
      options?.imageBucket,
    );
    page.text = text;
    if (savedPaths.length > 0) {
      includesImages = true;
    }
  }

  if (data.warnings?.length) {
    log.info(
      `Generic parser reported warnings for ${fileContent.name}: ${data.warnings.join(", ")}`,
    );
  }

  return {
    model: data.model ?? PDF_PARSER.GENERIC,
    pages: data.pages.map((p) => ({ page: p.page, text: p.text })),
    includesImages,
    metadata: data.metadata,
    warnings: data.warnings,
  };
};

/**
 * Which advertised modality a file routes to, or `undefined` when the service
 * advertises none for it or discovery is unavailable. Never throws: a file the
 * service would reject is still sent (and answered with `415`), which beats
 * failing the import because `/v1/capabilities` blinked.
 */
const resolveModalityForFile = async (
  file: File,
): Promise<ServiceModality | undefined> => {
  try {
    const caps = await getGenericParserCapabilities();
    const mime = (file.type ?? "").trim().toLowerCase();
    return findServiceModality(
      caps.modalities,
      isUninformativeMime(mime) ? undefined : mime,
      fileExtension(file.name),
    );
  } catch (e) {
    log.debug(`Could not resolve parser modality for ${file.name}: ${e}`);
    return undefined;
  }
};

/**
 * Whether to use the job endpoints instead of a single `POST /v1/parse`.
 *
 * `PDF_PARSER_SERVICE_MODE` decides for documents, but audio and video parse
 * for as long as the recording is long — up to the service's 30 min budget —
 * and a sync request would hold the whole time and time out. Those take the
 * job path whenever the modality advertises `async`.
 *
 * The job path requires ADVERTISED async, not merely the absence of a denial:
 * posting to `/v1/jobs` on a service that has no job endpoints fails the parse
 * outright, where the sync request would have worked. So a service that does
 * not advertise it falls back to `PDF_PARSER_SERVICE_MODE` like any other.
 */
const useJobPath = (modality?: ServiceModality): boolean => {
  if (
    modality &&
    LONG_RUNNING_MODALITIES.includes(modality.modality) &&
    modality.features?.[SERVICE_FEATURE.ASYNC] === true
  ) {
    return true;
  }
  return getMode() === "async";
};

// --- Capability discovery ---------------------------------------------------

/**
 * The advertised feature map, kept as the service sent it: wire names,
 * boolean values, nothing renamed and nothing dropped. Deliberately not
 * translated into a fixed set of framework keys — a flag the framework has
 * never heard of still has to reach `buildForm`, which is the whole point of
 * an open map. Only the shape is enforced (a non-`true` value is `false`).
 */
const normalizeFeatures = (
  features?: Record<string, unknown>,
): Record<string, boolean> | undefined => {
  if (!features) return undefined;
  const normalized: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(features)) {
    normalized[toServiceOptionWireName(key)] = value === true;
  }
  return normalized;
};

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

    const res = await fetch(`${getBaseUrl()}/v1/capabilities`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `Capabilities fetch failed: ${res.status} ${res.statusText}`,
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
        features: normalizeFeatures(m.features),
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
  extension?: string,
): Promise<boolean> => {
  const caps = await getGenericParserCapabilities();
  return (
    findServiceModality(caps.modalities, mimeType, extension) !== undefined
  );
};
