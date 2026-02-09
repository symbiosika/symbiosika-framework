/**
 * Demo scenario: Creates a realistic set of competitors for presentations and testing.
 * Covers the full risk spectrum with meaningful descriptions.
 */
import type { SeedContext } from "../../run";
import { competitorsFactory } from "../../factories";

export async function seed(ctx: SeedContext) {
  const { db, tenantId, log } = ctx;

  log("Creating demo competitors...");

  // Create a mix of competitors across the risk spectrum
  const competitors = await competitorsFactory(db).create([
    {
      tenantId,
      url: "https://acme-analytics.com",
      description:
        "Market leader in business analytics with 40% market share in DACH region. Strong enterprise sales team and extensive partner ecosystem.",
      riskRating: 9,
      riskDescription:
        "Primary competitive threat. Direct feature overlap and aggressive pricing in our target segments. Recently raised Series D at $200M valuation.",
    },
    {
      tenantId,
      url: "https://datawise.io",
      description:
        "Fast-growing AI-first analytics platform. YC-backed with strong developer community and open-source core.",
      riskRating: 8,
      riskDescription:
        "Rapidly gaining market share through developer adoption and bottom-up sales. Product-led growth is accelerating.",
    },
    {
      tenantId,
      url: "https://bizmetrics-pro.com",
      description:
        "Established SaaS player focused on mid-market. Strong in financial planning and reporting modules.",
      riskRating: 6,
      riskDescription:
        "Solid competitor with loyal customer base. Slower product development cycle but reliable and well-known brand.",
    },
    {
      tenantId,
      url: "https://cloudplan.de",
      description:
        "German-based cloud planning tool. GDPR-first approach with strong compliance features. Growing in public sector.",
      riskRating: 5,
      riskDescription:
        "Regional competitor with strong compliance positioning. Limited international ambitions but dominant in German public sector.",
    },
    {
      tenantId,
      url: "https://smartbiz-tools.com",
      description:
        "Low-cost alternative targeting freelancers and micro-businesses. Freemium model with basic features.",
      riskRating: 2,
      riskDescription:
        "Different target market with minimal feature overlap. Unlikely to move upmarket due to technical limitations.",
    },
  ]);

  log(`Created ${competitors.length} demo competitors`);

  // Also create some via traits for variety
  const highRiskCompetitors = await competitorsFactory(db).traits.highRisk.create([
    { tenantId },
    { tenantId },
  ]);
  log(`Created ${highRiskCompetitors.length} additional high-risk competitors via trait`);

  const stealthCompetitor = await competitorsFactory(db).traits.stealth.create({
    tenantId,
  });
  log(`Created stealth competitor: ${stealthCompetitor.id}`);

  return {
    competitors: [...competitors, ...highRiskCompetitors, stealthCompetitor],
  };
}
