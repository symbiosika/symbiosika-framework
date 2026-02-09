/**
 * Factory for the competitors resource.
 * Generates test data matching the competitors table schema.
 *
 * Usage:
 *   const competitor = await competitorsFactory(db).create({ tenantId });
 *   const highRisk = await competitorsFactory(db).traits.highRisk.create({ tenantId });
 */
import { defineFactory } from "@praha/drizzle-factory";
import { competitors } from "../../src/db/schema";

const SAMPLE_URLS = [
  "https://acme-corp.com",
  "https://globex-industries.com",
  "https://initech-solutions.com",
  "https://umbrella-tech.io",
  "https://waystar-digital.com",
  "https://hooli.xyz",
  "https://pied-piper.com",
  "https://aviato.com",
  "https://nucleus-ai.com",
  "https://endframe.io",
];

const SAMPLE_DESCRIPTIONS = [
  "Enterprise SaaS competitor with strong market presence in DACH region",
  "Emerging startup focusing on AI-driven business analytics",
  "Legacy player transitioning to cloud-based solutions",
  "Well-funded Series B startup targeting SMB segment",
  "Open-source alternative with growing community adoption",
  "Global enterprise solution with extensive partner network",
  "Niche player specializing in vertical-specific solutions",
  "Platform company building an ecosystem around business intelligence",
  "Bootstrapped competitor with loyal customer base",
  "New market entrant backed by major tech accelerator",
];

const RISK_DESCRIPTIONS: Record<string, string> = {
  critical:
    "Direct competitor with overlapping target market, superior funding, and aggressive growth strategy. Immediate threat to market share.",
  high: "Strong competitor with significant resources and growing market presence. Active customer acquisition in our segments.",
  medium:
    "Established player with different primary focus but expanding into our space. Monitor closely.",
  low: "Indirect competitor with limited overlap. Different target audience and pricing strategy.",
  minimal:
    "Peripheral market participant. Unlikely to compete directly in the near term.",
};

// Placeholder tenant ID -- must always be overridden via create({ tenantId })
const PLACEHOLDER_TENANT = "00000000-0000-0000-0000-000000000000";

export const competitorsFactory = defineFactory({
  schema: { competitors },
  table: "competitors",
  resolver: ({ sequence }) => ({
    id: crypto.randomUUID(),
    tenantId: PLACEHOLDER_TENANT,
    url: SAMPLE_URLS[(sequence - 1) % SAMPLE_URLS.length]!,
    description:
      SAMPLE_DESCRIPTIONS[(sequence - 1) % SAMPLE_DESCRIPTIONS.length]!,
    riskRating: Math.min((sequence * 3) % 11, 10),
    riskDescription:
      sequence % 5 <= 1
        ? RISK_DESCRIPTIONS.high!
        : RISK_DESCRIPTIONS.medium!,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  traits: {
    /** High-risk competitor (rating 8-10) */
    highRisk: ({ sequence }) => ({
      id: crypto.randomUUID(),
      tenantId: PLACEHOLDER_TENANT,
      url: `https://major-threat-${sequence}.com`,
      description: `Major competitive threat #${sequence} with aggressive market strategy`,
      riskRating: Math.min(8 + (sequence % 3), 10),
      riskDescription: RISK_DESCRIPTIONS.critical!,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    /** Low-risk competitor (rating 1-3) */
    lowRisk: ({ sequence }) => ({
      id: crypto.randomUUID(),
      tenantId: PLACEHOLDER_TENANT,
      url: `https://minor-player-${sequence}.com`,
      description: `Minor market participant #${sequence} with limited overlap`,
      riskRating: 1 + (sequence % 3),
      riskDescription: RISK_DESCRIPTIONS.minimal!,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    /** Competitor without URL (e.g. stealth startup) */
    stealth: ({ sequence }) => ({
      id: crypto.randomUUID(),
      tenantId: PLACEHOLDER_TENANT,
      url: null,
      description: `Stealth-mode competitor #${sequence} - limited public information available`,
      riskRating: 5,
      riskDescription:
        "Unknown threat level due to limited information. Requires further investigation.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  },
});
