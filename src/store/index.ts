import type {
  ServerSpecificConfig,
  WhatsAppIncomingWebhookHandler,
} from "../types";
import {
  stdTemplateInviteToOrganization,
  stdTemplateInviteToOrganizationWhenUserExists,
  stdTemplateMagicLink,
  stdTemplatePasswordReset,
  stdTemplatePasswordResetWelcome,
  stdTemplateVerifyEmail,
} from "./email-templates";

/**
 * The global server config object
 * REMINDER: Never store user data inside a global variable
 */
export const _GLOBAL_SERVER_CONFIG = {
  appName: "App",
  port: 3000,
  basePath: "/api/v1/",
  baseUrl: "http://localhost:3000",
  logoUrl: undefined as string | undefined,
  allowedOrigins: <string[]>[],
  authType: <"local" | "auth0" | "hanko">"local",
  loginUrl: "/manage/#/login",
  magicLoginVerifyUrl: "/manage/#/magic-login",
  verifyEmailUrl: "/manage/#/verify-email",
  resetPasswordUrl: "/manage/#/reset-password",
  oauthCallbackUrl: "/manage/#/oauth-callback",
  jwtExpiresAfter: 60 * 60 * 24 * 30, // 30 days
  useConsoleLogger: true,
  useLicenseSystem: false,
  publicKey: "",
  emailTemplates: {
    verifyEmail: stdTemplateVerifyEmail,
    magicLink: stdTemplateMagicLink,
    resetPassword: stdTemplatePasswordReset,
    resetPasswordWelcome: stdTemplatePasswordResetWelcome,
    inviteToOrganization: stdTemplateInviteToOrganization,
    inviteToOrganizationWhenUserExists:
      stdTemplateInviteToOrganizationWhenUserExists,
  },
  useWhatsApp: false,
  whatsAppIncomingWebhookHandler: undefined as
    | WhatsAppIncomingWebhookHandler
    | undefined,
};

/**
 * Helper function to set the global server config
 * and replace the default values with the ones from the config
 */
export const setGlobalServerConfig = (config: ServerSpecificConfig) => {
  _GLOBAL_SERVER_CONFIG.port = config.port ?? 3000;
  _GLOBAL_SERVER_CONFIG.appName = config.appName ?? "App";
  _GLOBAL_SERVER_CONFIG.basePath = config.basePath ?? "/api/v1";
  _GLOBAL_SERVER_CONFIG.baseUrl =
    config.baseUrl ?? process.env.BASE_URL ?? "http://localhost:3000";
  _GLOBAL_SERVER_CONFIG.logoUrl = config.logoUrl ?? undefined;

  if (_GLOBAL_SERVER_CONFIG.basePath.endsWith("/")) {
    _GLOBAL_SERVER_CONFIG.basePath = _GLOBAL_SERVER_CONFIG.basePath.slice(
      0,
      -1
    );
  }

  const _ORIGINS_FROM_ENV = process.env.ALLOWED_ORIGINS;
  _GLOBAL_SERVER_CONFIG.allowedOrigins = _ORIGINS_FROM_ENV
    ? _ORIGINS_FROM_ENV.split(",")
    : [];

  _GLOBAL_SERVER_CONFIG.authType = config.authType ?? "local";

  if (config.jwtExpiresAfter) {
    _GLOBAL_SERVER_CONFIG.jwtExpiresAfter = config.jwtExpiresAfter;
  }

  _GLOBAL_SERVER_CONFIG.useLicenseSystem = config.useLicenseSystem ?? false;
  _GLOBAL_SERVER_CONFIG.publicKey = config.publicKey ?? "";

  // Email Templates
  if (config.emailTemplates?.verifyEmail) {
    _GLOBAL_SERVER_CONFIG.emailTemplates.verifyEmail =
      config.emailTemplates.verifyEmail;
  }
  if (config.emailTemplates?.magicLink) {
    _GLOBAL_SERVER_CONFIG.emailTemplates.magicLink =
      config.emailTemplates.magicLink;
  }
  if (config.emailTemplates?.resetPassword) {
    _GLOBAL_SERVER_CONFIG.emailTemplates.resetPassword =
      config.emailTemplates.resetPassword;
  }
  if (config.emailTemplates?.inviteToOrganization) {
    _GLOBAL_SERVER_CONFIG.emailTemplates.inviteToOrganization =
      config.emailTemplates.inviteToOrganization;
  }
  if (config.emailTemplates?.inviteToOrganizationWhenUserExists) {
    _GLOBAL_SERVER_CONFIG.emailTemplates.inviteToOrganizationWhenUserExists =
      config.emailTemplates.inviteToOrganizationWhenUserExists;
  }
  if (config.emailTemplates?.resetPasswordWelcome) {
    _GLOBAL_SERVER_CONFIG.emailTemplates.resetPasswordWelcome =
      config.emailTemplates.resetPasswordWelcome;
  }

  // URLS
  if (config.loginUrl) {
    _GLOBAL_SERVER_CONFIG.loginUrl = config.loginUrl;
  }
  if (config.magicLoginVerifyUrl) {
    _GLOBAL_SERVER_CONFIG.magicLoginVerifyUrl = config.magicLoginVerifyUrl;
  }
  if (config.verifyEmailUrl) {
    _GLOBAL_SERVER_CONFIG.verifyEmailUrl = config.verifyEmailUrl;
  }
  if (config.resetPasswordUrl) {
    _GLOBAL_SERVER_CONFIG.resetPasswordUrl = config.resetPasswordUrl;
  }
  if (config.oauthCallbackUrl) {
    _GLOBAL_SERVER_CONFIG.oauthCallbackUrl = config.oauthCallbackUrl;
  }

  // WhatsApp
  _GLOBAL_SERVER_CONFIG.useWhatsApp = config.useWhatsApp ?? false;
  if (config.whatsAppIncomingWebhookHandler) {
    _GLOBAL_SERVER_CONFIG.whatsAppIncomingWebhookHandler =
      config.whatsAppIncomingWebhookHandler;
  }
};
