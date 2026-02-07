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

export type CustomPostRegisterAction = (
  userId: string,
  email: string
) => Promise<void>;

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
