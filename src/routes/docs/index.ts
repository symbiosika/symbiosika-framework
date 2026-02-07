import { type SymbiosikaFrameworkHonoApp } from "../../types";
import { openAPIRouteHandler } from "hono-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { authAndSetUsersInfo } from "../../lib/utils/hono-middlewares";

export default function defineDocsRoutes(app: SymbiosikaFrameworkHonoApp, basePath: string) {
  // OpenAPI Docs
  app.get(
    "/api/v1/docs/openapi",
    authAndSetUsersInfo,
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Symbiosika Backend API",
          version: "1.0.0",
          description: "API for the Symbiosika AI Backend",
        },
      },
    })
  );

  app.get(
    "/api/v1/docs/swagger-ui",
    authAndSetUsersInfo,
    swaggerUI({ url: "/api/v1/docs/openapi" })
  );
}
