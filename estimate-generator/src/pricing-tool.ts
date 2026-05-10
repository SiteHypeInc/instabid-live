import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRICING_DIR = join(HERE, "..", "pricing");

export type Region = "northeast" | "southeast" | "midwest" | "west";

export function regionFromZip(zip: string): Region {
  const first = String(zip ?? "").trim()[0];
  if (first === "3") return "southeast";
  if (first === "0" || first === "1" || first === "2") return "northeast";
  if (first === "4" || first === "5" || first === "6") return "midwest";
  if (first === "7" || first === "8" || first === "9") return "west";
  return "midwest";
}

type PricingDB = Record<string, unknown> & {
  regions?: Record<string, Record<string, unknown>>;
};

const cache = new Map<string, PricingDB | null>();

export function loadTradePricing(trade: string): PricingDB | null {
  if (cache.has(trade)) return cache.get(trade) ?? null;
  const file = join(PRICING_DIR, `${trade}-v1.json`);
  if (!existsSync(file)) {
    cache.set(trade, null);
    return null;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as PricingDB;
  cache.set(trade, parsed);
  return parsed;
}

function resolvePath(obj: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export interface PricingLookupInput {
  trade: string;
  zip_code: string;
  query: string;
}

export interface PricingLookupResult {
  ok: boolean;
  trade: string;
  region: Region;
  query: string;
  value: unknown;
  available_keys?: string[];
  error?: string;
}

export const pricingToolDefinition: Anthropic.Tool = {
  name: "pricing_lookup",
  description: [
    "Look up unit pricing from the InstaBid pricing DB. Returns USD values for",
    "materials and labor by trade + region. Use this for any line item where a",
    "static catalog price is appropriate; freeform reasoned pricing is fine for",
    "items not in the DB (note them in the estimate's `assumptions`).",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      trade: {
        type: "string",
        description:
          "Trade key. For this service, use 'kitchen-countertops'. The DB also carries other trades for cross-reference.",
      },
      zip_code: {
        type: "string",
        description: "Job ZIP for region resolution (5-digit US).",
      },
      query: {
        type: "string",
        description:
          "Dotted path into the pricing DB. Examples: 'materials.quartz_mid.material_per_sqft', 'labor.fabrication_install_per_sqft', 'labor.sink_cutout_undermount', 'regions.<region>.labor_multiplier'.",
      },
    },
    required: ["trade", "zip_code", "query"],
  },
};

export function handlePricingLookup(input: PricingLookupInput): PricingLookupResult {
  const { trade, zip_code, query } = input;
  const region = regionFromZip(zip_code);
  const pricing = loadTradePricing(trade);
  if (!pricing) {
    return {
      ok: false,
      trade,
      region,
      query,
      value: null,
      error: `no pricing DB for trade '${trade}'`,
    };
  }

  const direct = resolvePath(pricing, query);
  const regional = pricing.regions
    ? resolvePath(pricing.regions[region], query)
    : undefined;
  const value = regional !== undefined ? regional : direct;

  const topKeys = Object.keys(pricing).filter((k) => !k.startsWith("_"));
  return {
    ok: value !== undefined,
    trade,
    region,
    query,
    value: value === undefined ? null : value,
    available_keys: topKeys,
  };
}
