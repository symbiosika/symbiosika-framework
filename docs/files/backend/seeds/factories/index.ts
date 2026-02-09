/**
 * Composed factory for all resource factories.
 * Import this single entry point to access all factories.
 *
 * Usage:
 *   import { factory, competitorsFactory } from "../factories";
 *   const competitor = await factory(db).competitors.create({ tenantId });
 */
import { composeFactory } from "@praha/drizzle-factory";
import { competitorsFactory } from "./competitors.factory";

// Composed factory: single entry point for all resource factories
export const factory = composeFactory({
  competitors: competitorsFactory,
  // Add more resource factories here as they are created:
  // financialEntries: financialEntriesFactory,
  // salaries: salariesFactory,
  // investments: investmentsFactory,
});

// Re-export individual factories for direct access
export { competitorsFactory };
