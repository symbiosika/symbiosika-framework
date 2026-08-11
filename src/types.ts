import type { Hono } from "hono";
import type { BlankSchema } from "hono/types";
import type { PermissionDefinitionPerTable } from "./lib/types/permission-checker";
import type { JobHandlerRegister } from "./lib/jobs";
import type { Task } from "./lib/cron";
import type { SyncItem } from "./lib/types/sync";
import type { ProcessedWhatsAppMessage } from "./lib/communication/whatsapp";
import type {
  PostProcessor,
  PostProcessorResolver,
} from "./lib/knowledge/parsing/post-processors";

export type { SyncItem };
export type { JobHandlerRegister };
export { HTTPException } from "hono/http-exception";
export type { ProcessedWhatsAppMessage };

export type SFContextVariables = {
  usersId: string;
  usersEmail: string;
  usersRoles: string[];
  scopes: string[];
  /** Server-side session id (sid claim) for interactive logins; undefined for service/external tokens. */
  sessionId?: string;
  /** Token `type` claim (e.g. "connection" for server-to-server tokens). */
  tokenType?: string;
  /** Token `tenantId` claim — for connection tokens, the tenant they may act for. */
  tokenTenantId?: string;
};

export interface SymbiosikaFrameworkHonoApp
  extends Hono<{ Variables: SFContextVariables }, BlankSchema, "/"> {}

type UserInfo = {
  firstname: string;
  surname: string;
  email: string;
};

export type EmailTemplateFunction = (data: {
  appName: string;
  baseUrl: string;
  logoUrl?: string;
  link?: string;
  /** One-time login code (OTP), e.g. for the OAuth email-login flow. */
  code?: string;
  user?: UserInfo;
  tenant?: {
    id: string;
    name: string;
  };
}) => Promise<{ html: string; subject: string }>;

export type WhatsAppIncomingWebhookHandler = (
  messages: ProcessedWhatsAppMessage[]
) => Promise<void>;

export interface ServerSpecificConfig {
  port?: number;
  appName?: string;
  basePath?: string;
  baseUrl?: string;
  logoUrl?: string;

  loginUrl?: string;
  magicLoginVerifyUrl?: string;
  verifyEmailUrl?: string;
  resetPasswordUrl?: string;
  oauthCallbackUrl?: string;
  // Page a brand-new social-login user is sent to when the instance requires an
  // invitation code. Defaults to "/oauth-invitation-code.html".
  oauthInvitationCodeUrl?: string;
  // Where an existing user is redirected after accepting a tenant invitation
  // via the emailed link (relative to baseUrl). Defaults to "/".
  invitationAcceptRedirectUrl?: string;

  authType?: "local" | "auth0" | "hanko";
  jwtExpiresAfter?: number;
  // TTL for magic-link tokens (login, email verification, password reset),
  // in seconds. Default 900 (15m).
  magicLinkTtl?: number;

  // OAuth2 / OIDC Authorization Server (opt-in).
  // When enabled, the app acts as an OAuth2/OIDC provider so third-party
  // clients can authenticate users and call the API on their behalf.
  // See docs/framework/16_OAuth2_OIDC_Provider.md
  oauth2?: {
    enabled?: boolean; // default false
    issuer?: string; // default = baseUrl (used for metadata + JWT `iss`)
    accessTokenTtl?: number; // seconds, default 900 (15m)
    refreshTokenTtl?: number; // seconds, default 2592000 (30d)
    authCodeTtl?: number; // seconds, default 60
    requireConsentScreen?: boolean; // default true
    emailLoginCodeTtl?: number; // seconds, default 600 (10m)
    emailLoginCodeMaxAttempts?: number; // default 5
    // Shared secret for RFC 7662 token introspection (resource servers send this as Bearer).
    introspectionSecret?: string;
    // Scopes assigned to dynamically registered clients (RFC 7591) that omit
    // `scope` in their registration request. Empty/unset = all supported
    // scopes. MCP clients like claude.ai register without `scope` and then
    // request the scopes advertised by the resource server, so an empty
    // client allow-list would fail every authorize request with invalid_scope.
    dcrDefaultScopes?: string[];
    // Override the default login/consent/tenant-select HTML (like emailTemplates).
    views?: Partial<import("./lib/oauth2/views").OAuthViews>;
  };

  jobHandlers?: JobHandlerRegister[];
  /**
   * Disable the background job queue on this instance. The framework normally
   * starts the queue unconditionally because built-in handlers (e.g. async
   * document ingestion for the knowledge routes) depend on it. Set this to
   * `true` only when a separate, dedicated worker process drains the queue —
   * otherwise ingestion jobs created via the knowledge routes stay `pending`.
   */
  disableJobQueue?: boolean;

  customEnvVariablesToCheckOnStartup?: string[];
  customHonoApps?: {
    baseRoute: string;
    app: (app: Hono<{ Variables: SFContextVariables }>) => void;
  }[];
  customHonoAppsWithAuth?: {
    baseRoute: string;
    app: (app: Hono<{ Variables: SFContextVariables }>) => void;
  }[];
  customDbSchema?: any; // Drizzle Schema
  customCollectionPermissions?: PermissionDefinitionPerTable;
  staticPrivateDataPath?: string;
  staticPublicDataPath?: string;
  /**
   * Path prefixes inside the public static folder that must NOT be served.
   *
   * For bundles that ship in the image but are switched off on this instance
   * — the files stay on disk, the routes answer 404. The rest of the folder,
   * including the login pages, remains reachable, so this is not a way to turn
   * the public mount off as a whole.
   *
   * Matched on whole path segments: `["reports"]` hides `/reports` and
   * everything below it, but not `/reports-archive`. Entries that normalise to
   * nothing are ignored rather than matching everything.
   */
  staticPublicExclude?: string[];
  /**
   * Path prefixes inside the **private** static folder that are served without
   * the login redirect.
   *
   * For bundles that authenticate themselves rather than relying on the session
   * cookie — an SPA embedded in a host application (Microsoft Teams, an iframe
   * on another site) cannot receive a cross-site cookie on the document load,
   * so it would be redirected to the login page before its own code ever runs.
   * Listing its folder here hands out the bundle; every API route it calls stays
   * authenticated as before.
   *
   * Only for content that carries no secrets. Matched on whole path segments,
   * relative to the mount: `["app"]` opens `/static/app` and everything below
   * it, but not `/static/app-internal`. Entries that normalise to nothing are
   * ignored rather than matching everything.
   */
  staticPrivateExclude?: string[];

  // Registration Flow
  customPreRegisterCustomVerifications?: CustomPreRegisterVerification[];
  customPostRegisterActions?: CustomPostRegisterAction[];
  customPostConnectionActions?: CustomPostConnectionAction[];

  // Knowledge post processors
  /**
   * Post processors registered at server start. They run after a document is
   * parsed to markdown (PDF/OCR, URL, uploaded file, plain text) and before it
   * is stored, and are selected per-import by `name` via `usePostProcessors`.
   */
  customPostProcessors?: PostProcessor[];

  /**
   * Dynamic resolvers for post-processor names missing from the static
   * registry (e.g. tenant-scoped `agent:<uuid>` processors resolved from the
   * DB at import time). Consulted in order; first non-undefined wins.
   */
  customPostProcessorResolvers?: PostProcessorResolver[];

  /**
   * Chunking strategy used when a parsed document is split into knowledge
   * chunks before embedding.
   *   - "simple": word/character splitter (default).
   *   - "smart":  markdown/table-aware splitter that keeps tables atomic,
   *               repeats the header on oversized tables and chunks free text
   *               at paragraph/heading boundaries.
   * Default: "simple".
   */
  chunkingStrategy?: "simple" | "smart";

  /**
   * Opt-in source hashing for the knowledge sync (`upsertKnowledgeFromText`).
   * When true, the sync stores a sha256 of the source in the indexed
   * `knowledge_entry.source_hash` column and, on the next run, skips
   * re-parsing/re-chunking/re-embedding a source whose hash is unchanged.
   * Can be overridden per call via `computeSourceHash`.
   * Default: false (computing the hash costs a little performance).
   */
  enableSourceHashing?: boolean;

  /**
   * Opt-in: pass the tenant's configured catalog attributes (see
   * knowledge-config `attributes`) to the PDF/document parsing service as
   * structured extraction targets. When true, `parseFile`/`parseDocument`
   * load the tenant attribute definitions and set `PdfParserOptions.extract`
   * so a capable parser tries to fill those fields from the document; the
   * extracted values are written back onto the resulting page's `attributes`
   * (only into keys that are still empty and pass facet validation).
   * Can be overridden per call via `extractAttributes`.
   * Default: false.
   */
  enablePdfParserExtraction?: boolean;

  // CRON
  customCronJobs?: Task[];
  /**
   * Schedule (standard Linux cron syntax) for the expired-files cleanup
   * job that removes orphaned wiki images and other expired files.
   * Default: "0 3 * * 0" (weekly, Sunday 03:00).
   */
  fileCleanupCron?: string;
  /**
   * Schedule (standard Linux cron syntax) for the debounced knowledge page-summary
   * sweeper. Only active when a global LLM is configured (AI_PROVIDER).
   * Default: "* * * * *" (every minute).
   */
  knowledgeSummarySweepCron?: string;

  // stripe
  useStripe?: boolean;

  // logging in console (hono logger)
  useConsoleLogger?: boolean;

  // Licencing
  useLicenseSystem?: boolean;
  publicKey?: string;

  // WhatsApp
  useWhatsApp?: boolean;
  whatsAppIncomingWebhookHandler?: WhatsAppIncomingWebhookHandler;

  // Email Templates
  emailTemplates?: {
    verifyEmail?: EmailTemplateFunction;
    magicLink?: EmailTemplateFunction;
    resetPassword?: EmailTemplateFunction;
    resetPasswordWelcome?: EmailTemplateFunction;
    inviteToOrganization?: EmailTemplateFunction;
    inviteToOrganizationWhenUserExists?: EmailTemplateFunction;
    emailLoginCode?: EmailTemplateFunction;
    custom?: Record<string, EmailTemplateFunction>;
  };
}

export interface DBStandardData {
  name?: string;
  description?: string;
  schemaName: string;
  entries: any[];
}

export type CustomPreRegisterVerification = (
  email: string,
  meta: any
) => Promise<{ success: boolean; message?: string }>;

/**
 * Custom post-register action.
 *
 * The `meta` argument contains the same object passed to the register flow
 * (for the local register endpoint this is the `meta` field of the request
 * body, for the magic-link flow it is assembled from query parameters).
 * A register flow may carry custom per-user data in `meta.customRegisterData`
 * which will be persisted on the user row (`users.meta.customRegisterData`)
 * and is available to post-register actions.
 */
export type CustomPostRegisterAction = (
  userId: string,
  email: string,
  meta?: {
    invitationCode?: string;
    customRegisterData?: Record<string, any>;
    [key: string]: any;
  }
) => Promise<void>;

/**
 * Context handed to post-connection actions after a server-to-server
 * connection has been established (cert exchange complete).
 */
export type ConnectionEstablishedContext = {
  connectionId: string;
  /** The local tenant the connection was stored under. */
  localTenantId: string;
  /**
   * The remote tenant id. Mirrored locally with the same id only on a
   * *following* side; on a leading side it refers to a tenant that does not
   * exist locally.
   */
  remoteTenantId: string;
  remoteUrl: string;
  name: string;
  initiatedBy: "local" | "remote";
  /**
   * This side's role for the connection: "leading" owns the data, "following"
   * mirrors the remote leader tenant.
   */
  role: "leading" | "following";
};

/**
 * Custom post-connection action. Fired once a connection is fully established
 * (both `initializeConnection`/`initializeConnectionWithToken` on the initiating
 * side and `acceptConnection` on the accepting side). Lets an app react to
 * onboarding — e.g. a robot reducing itself to the connected tenant — without
 * wrapping the framework's connection routes.
 */
export type CustomPostConnectionAction = (
  ctx: ConnectionEstablishedContext
) => Promise<void> | void;

export type RenderTypeText = {
  type: "text";
};

export type RenderTypeImage = {
  type: "image";
  url: string;
};

export type RenderTypeBox = {
  type: "box";
  severity: "info" | "warning" | "error";
};

export type RenderTypeMarkdown = {
  type: "markdown";
};

// export type RenderTypeForm = {
//   type: "form";
//   definition: GenericFormEntry[];
//   data: { [key: string]: any };
// };

export type RenderType =
  | RenderTypeText
  | RenderTypeImage
  | RenderTypeBox
  | RenderTypeMarkdown;
// | RenderTypeForm;

export type ChatWithTemplateReturn = {
  chatId: string;
  message: {
    role: "user" | "assistant";
    content: string;
  };
  meta: any;
  finished?: boolean;
  render?: RenderType;
};
