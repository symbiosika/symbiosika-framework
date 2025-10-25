// Hono
import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { authOrRedirectToLogin } from "./lib/utils/hono-middlewares";
import { ipRestriction } from "hono/ip-restriction";
// DB
import {
  createDatabaseClient,
  waitForDbConnection,
} from "./lib/db/db-connection";
import { initializeFullDbSchema } from "./lib/db/db-schema";
import { initializeCollectionPermissions } from "./lib/db/db-collections";
// Types
import type {
  ServerSpecificConfig,
  FastAppHonoContextVariables,
} from "./types";
import { getConnInfo } from "hono/bun";
// Utils
import log from "./lib/log";
import { validateAllEnvVariables } from "./lib/utils/env-validate";
// Registration actions
import {
  registerPostRegisterAction,
  registerPreRegisterCustomVerification,
} from "./lib/auth/actions";
// Routes
import { definePublicUserRoutes } from "./routes/user/public";
import { defineSecuredUserRoutes } from "./routes/user/protected";
import { defineFilesRoutes } from "./routes/organisation/[organisationId]/files";

// import aiKnowledgeRoutes from "./routes/organisation/[organisationId]/knowledge";
// import aiKnowledgeFiltersRoutes from "./routes/organisation/[organisationId]/knowledge/knowledge-filters";
// import aiKnowledgeGroupRoutes from "./routes/organisation/[organisationId]/knowledge/knowledge-groups";
// import aiKnowledgeTextsRoutes from "./routes/organisation/[organisationId]/knowledge/knowledge-texts";
// import aiKnowledgeChunksRoutes from "./routes/organisation/[organisationId]/knowledge/knowledge-chunks";

import defineOrganisationRoutes from "./routes/organisation";
import defineTeamRoutes from "./routes/organisation/[organisationId]/teams";
import defineConnectionsRoutes from "./routes/organisation/[organisationId]/connections";
import definePermissionGroupRoutes from "./routes/organisation/[organisationId]/permission-groups";
import defineInvitationRoutes from "./routes/organisation/[organisationId]/invitations";
// import { defineCollectionRoutes } from "./routes/collections";
import defineManageSecretsRoutes from "./routes/organisation/[organisationId]/secrets";

import definePingRoute from "./routes/ping";
import defineWebhookRoutes from "./routes/organisation/[organisationId]/webhooks";
import defineAdminRoutes from "./routes/admin";
import defineSearchInOrganisationRoutes from "./routes/organisation/[organisationId]/search";
import defineJobRoutes from "./routes/organisation/[organisationId]/jobs";
import defineDocsRoutes from "./routes/docs";
import defineWhatsAppRoutes from "./routes/communiation/wa";
// Jobs
import { defineJob, startJobQueue } from "./lib/jobs";
// Cron
import scheduler from "./lib/cron";
// Store
import { _GLOBAL_SERVER_CONFIG, setGlobalServerConfig } from "./store";

/**
 * services
 */
import { smtpService } from "./lib/email";
import { getMetaIpAddresses } from "./lib/communication/whatsapp/whitelist";
import { defineLicenseRoutes, licenseManager } from "./license-service";

/**
 * MAIN FUNCTION
 * Define the server and start it
 *
 * Will take a configuration from the App
 * and merge the config with the default values
 * and validate the .ENV variables
 * and create the database client
 * and register the cron jobs
 * and initialize the caches
 * and start the job queue
 * start the server
 */
export const defineServer = (config: ServerSpecificConfig) => {
  setGlobalServerConfig(config);
  console.log("Global server config:", JSON.stringify(_GLOBAL_SERVER_CONFIG));

  /**
   * validate .ENV variables
   */
  validateAllEnvVariables(config.customEnvVariablesToCheckOnStartup ?? []);

  /**
   * Create database client
   */
  initializeFullDbSchema(config.customDbSchema ?? {});
  initializeCollectionPermissions(config.customCollectionPermissions ?? {});
  createDatabaseClient(config.customDbSchema);

  /**
   * Register all custom cron jobs
   */
  if (config.customCronJobs) {
    config.customCronJobs.forEach((cronJob) => {
      scheduler.registerTask(cronJob.name, cronJob.schedule, cronJob.handler);
    });
  }

  /**
   * Init the main Hono app
   */
  const app = new Hono<{ Variables: FastAppHonoContextVariables }>();
  app.use(logger());
  if (config.useConsoleLogger) {
    console.log("Using console logger");
    app.use(logger());
  }

  /**
   * Register custom pre-register verifications
   * These are used to verify something about the user before registering
   */
  if (config.customPreRegisterCustomVerifications) {
    config.customPreRegisterCustomVerifications.forEach((verification) => {
      registerPreRegisterCustomVerification(verification);
    });
  }

  /**
   * Register custom post-register actions
   * These are used to perform actions after the user has registered
   */
  if (config.customPostRegisterActions) {
    config.customPostRegisterActions.forEach((action) => {
      registerPostRegisterAction(action);
    });
  }

  /**
   * Adds CORS Middleware
   */
  console.log("Allowed origins:", _GLOBAL_SERVER_CONFIG.allowedOrigins);
  app.use(
    "/*",
    cors({
      origin: _GLOBAL_SERVER_CONFIG.allowedOrigins,
    })
  );

  /**
   * Licencing routes
   */
  defineLicenseRoutes(app);

  /**
   * Adds a ping endpoint to have a simple health check
   * and check if the server has external internet access
   */
  definePingRoute(app, _GLOBAL_SERVER_CONFIG.basePath);

  /**
   * Initialize internal caches after DB is connected
   */
  waitForDbConnection().then(async () => {
    licenseManager.init();

    const isLicenseValid = await licenseManager.isValid();

    if (isLicenseValid) {
      console.log("License check was valid! Starting server...");

      /**
       * Adds admin routes
       */
      defineAdminRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Adds user routes for profile, register, login, logout, etc.
       */
      definePublicUserRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      defineSecuredUserRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Adds organisation routes
       */
      defineOrganisationRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      defineTeamRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      definePermissionGroupRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      defineInvitationRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      defineSearchInOrganisationRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      defineConnectionsRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Adds collection routes

      * will give simple CRUD endpoints for defined collections
      */
      // dropping this for now!
      // defineCollectionRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Adds files routes
       * will give simple CRUD endpoints to store and retrieve files from DB or S3
       */
      defineFilesRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Adds routes to manage secrets
       * Secrets are used to store sensitive information like API keys, etc.
       */
      defineManageSecretsRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Adds routes to manage webhooks
       * Webhooks are used to trigger actions from external sources
       */
      defineWebhookRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Adds all AI specific routes
       * - prompt templates
       * - fine-tuning
       * - knowledge
       * - chat
       */

      // aiKnowledgeRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      // aiKnowledgeFiltersRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      // aiKnowledgeGroupRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      // aiKnowledgeTextsRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
      // aiKnowledgeChunksRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Add communication routes
       */

      if (_GLOBAL_SERVER_CONFIG.useWhatsApp) {
        getMetaIpAddresses().then((ips) => {
          app.use(
            _GLOBAL_SERVER_CONFIG.basePath + "/communication/wa/*",
            ipRestriction(
              getConnInfo,
              {
                denyList: [],
                allowList: ["*"], // ips,
              },
              async (remote, c) => {
                log.debug(`Blocking access from ${remote.addr}`);
                return c.text(`Blocking access from ${remote.addr}`, 403);
              }
            )
          );
          // console.log("restricting whatsapp endpoints to ips:", ips);
          defineWhatsAppRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
        });
      }

      /**
       * Adds docs routes
       */
      defineDocsRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);

      /**
       * Adds custom routes from customHonoApps
       * These are used to add custom routes to the server
       * These are defined in the App config
       */
      if (config.customHonoApps) {
        config.customHonoApps.forEach(({ baseRoute, app: customApp }) => {
          const honoApp = new Hono<{
            Variables: FastAppHonoContextVariables;
          }>();
          customApp(honoApp);
          app.route(_GLOBAL_SERVER_CONFIG.basePath + baseRoute, honoApp);
        });
      }

      /**
       * Adds static private data routes
       * folder ./static/
       * will be served only to authenticated users
       */
      const staticPrivateDataPath = config.staticPrivateDataPath ?? "./static";
      log.debug(`Static private data path:", ${staticPrivateDataPath}`);
      app.use(
        "/static/*",
        authOrRedirectToLogin,
        serveStatic({
          root: staticPrivateDataPath,
          rewriteRequestPath: (path) => path.replace(/^\/static/, "/"),
        })
      );

      /**
       * Adds static public data routes
       * folder ./public/
       * will be served to all users without authentication
       */
      const staticPublicDataPath = config.staticPublicDataPath ?? "./public";
      log.debug(`Static public data path: ${staticPublicDataPath}`);
      app.use(
        "/*",
        serveStatic({
          root: staticPublicDataPath,
          rewriteRequestPath: (path) => path.replace(/^\/public/, "/"),
        })
      );

      /**
       * Start job queue if needed
       * These are used to perform background tasks
       */
      if (config.jobHandlers && config.jobHandlers.length > 0) {
        log.debug("Starting job queue...");
        config.jobHandlers.forEach((jobHandler) => {
          log.debug(`Registering job handler: ${jobHandler.type}`);
          defineJob(jobHandler.type, jobHandler.handler);
        });
        startJobQueue();
      }

      /**
       * Register job routes
       */
      defineJobRoutes(app, _GLOBAL_SERVER_CONFIG.basePath);
    } else {
      console.log("License check was invalid! Please check your license key.");
    }
  });

  // Log all registered endpoints
  // logApiRoutes(app);

  return {
    idleTimeout: 255,
    port: config.port ?? 3000,
    fetch: app.fetch,
  };
};

/**
 * Export all needed types for the customer App
 */
export * from "./types";

/**
 * Export all services for the customer App
 */
export { log };
export { smtpService };
export const GLOBAL_SERVER_CONFIG = _GLOBAL_SERVER_CONFIG;
export { connectionsService } from "./lib/connections";
