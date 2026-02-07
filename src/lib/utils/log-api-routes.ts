import type { SymbiosikaFrameworkHonoApp } from "../../types";

export const logApiRoutes = (app: SymbiosikaFrameworkHonoApp) => {
  console.log("\n🛣️  Registered Routes:");
  app.routes.forEach((route) => {
    const method = route.method;
    console.log(`${method.toUpperCase().padEnd(6)} ${route.path}`);
  });
  console.log(); // Empty line for better readability
};
