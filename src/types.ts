import type { Hono } from "hono";
import type { BlankSchema } from "hono/types";
import type { PermissionDefinitionPerTable } from "./lib/types/permission-checker";
import type { JobHandlerRegister } from "./lib/jobs";
import type { Task } from "./lib/cron";
import type { SyncItem } from "./lib/types/sync";
import type { ProcessedWhatsAppMessage } from "./lib/communication/whatsapp";

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

  authType?: "local" | "auth0" | "hanko";
  jwtExpiresAfter?: number;

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
    // Override the default login/consent/tenant-select HTML (like emailTemplates).
    views?: Partial<import("./lib/oauth2/views").OAuthViews>;
  };

  jobHandlers?: JobHandlerRegister[];

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

  // Registration Flow
  customPreRegisterCustomVerifications?: CustomPreRegisterVerification[];
  customPostRegisterActions?: CustomPostRegisterAction[];
  customPostConnectionActions?: CustomPostConnectionAction[];

  // CRON
  customCronJobs?: Task[];

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
  /** The remote tenant id (mirrored locally with the same id). */
  remoteTenantId: string;
  remoteUrl: string;
  name: string;
  initiatedBy: "local" | "remote";
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
