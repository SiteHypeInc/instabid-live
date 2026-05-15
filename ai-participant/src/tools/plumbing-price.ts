import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const Scope = z.enum([
  "fixture_replace",
  "sink_relocate",
  "drain_line",
  "supply_line",
  "water_heater",
  "rough_in",
  "general",
]);
export type Scope = z.infer<typeof Scope>;

export const Args = z.object({
  scope: Scope,
  fixtures: z.number().int().positive().max(20).optional(),
  linearFeet: z.number().positive().max(500).optional(),
  zip: z.string().regex(/^\d{5}$/),
  foundationType: z.enum(["slab", "crawlspace", "basement", "unknown"]).optional(),
});
export type Args = z.infer<typeof Args>;

const BASE_USD: Record<Scope, { material: number; labor: number; per: "fixture" | "linearFeet" | "flat" }> = {
  fixture_replace: { material: 110, labor: 220, per: "fixture" },
  sink_relocate: { material: 80, labor: 650, per: "flat" },
  drain_line: { material: 12, labor: 28, per: "linearFeet" },
  supply_line: { material: 6, labor: 22, per: "linearFeet" },
  water_heater: { material: 750, labor: 450, per: "flat" },
  rough_in: { material: 220, labor: 950, per: "flat" },
  general: { material: 150, labor: 250, per: "flat" },
};

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const base = BASE_USD[args.scope];
  let qty = 1;
  if (base.per === "fixture") qty = args.fixtures ?? 1;
  else if (base.per === "linearFeet") qty = args.linearFeet ?? 10;
  // Slab adds significant cost on relocate/drain work
  const slabBump = args.foundationType === "slab" && (args.scope === "sink_relocate" || args.scope === "drain_line") ? 1.4 : 1.0;
  const material_total_usd = Math.round(base.material * qty * mult * slabBump);
  const labor_total_usd = Math.round(base.labor * qty * mult * slabBump);
  return {
    trade: "plumbing",
    scope: args.scope,
    quantity: qty,
    zip: args.zip,
    region,
    foundationType: args.foundationType,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupPlumbingPrice(raw: unknown, backend: { url?: string; key?: string }) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "plumbing",
      scope: args.scope,
      zipCode: args.zip,
      ...(args.fixtures !== undefined ? { fixtures: args.fixtures } : {}),
      ...(args.linearFeet !== undefined ? { linearFeet: args.linearFeet } : {}),
      ...(args.foundationType ? { foundationType: args.foundationType } : {}),
    },
    mock,
    "Mocked plumbing quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_plumbing_price",
  description:
    "Get pricing for plumbing work: fixture replacement, sink relocate, drain or supply line runs, water heater, rough-in. Slab vs crawlspace meaningfully affects relocate cost — pass foundationType when known.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      scope: { type: "STRING", description: "Type of plumbing work.", enum: Scope.options },
      fixtures: { type: "NUMBER", description: "Number of fixtures (sinks, toilets, tubs) for fixture_replace." },
      linearFeet: { type: "NUMBER", description: "Linear feet for drain_line / supply_line." },
      zip: { type: "STRING", description: "5-digit US ZIP code." },
      foundationType: {
        type: "STRING",
        description: "Foundation type at the property — affects access cost on relocates.",
        enum: ["slab", "crawlspace", "basement", "unknown"],
      },
    },
    required: ["scope", "zip"],
  },
};

export const PlumbingPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupPlumbingPrice(raw, backend),
};
