import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const Scope = z.enum([
  "outlet_install",
  "gfci_install",
  "circuit_add",
  "panel_upgrade",
  "fixture_install",
  "switch_install",
  "general",
]);
export type Scope = z.infer<typeof Scope>;

export const Args = z.object({
  scope: Scope,
  count: z.number().int().positive().max(50).default(1),
  zip: z.string().regex(/^\d{5}$/),
  panelAmps: z.number().int().positive().optional(),
  notes: z.string().optional(),
});
export type Args = z.infer<typeof Args>;

const BASE_USD: Record<Scope, { material: number; labor: number }> = {
  outlet_install: { material: 8, labor: 75 },
  gfci_install: { material: 22, labor: 95 },
  circuit_add: { material: 60, labor: 280 },
  panel_upgrade: { material: 450, labor: 1400 },
  fixture_install: { material: 35, labor: 110 },
  switch_install: { material: 6, labor: 65 },
  general: { material: 50, labor: 150 },
};

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const base = BASE_USD[args.scope];
  const material_total_usd = Math.round(base.material * args.count * mult);
  const labor_total_usd = Math.round(base.labor * args.count * mult);
  return {
    trade: "electrical",
    scope: args.scope,
    count: args.count,
    zip: args.zip,
    region,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupElectricalPrice(raw: unknown, backend: { url?: string; key?: string }) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "electrical",
      scope: args.scope,
      count: args.count,
      zipCode: args.zip,
      ...(args.panelAmps !== undefined ? { panelAmps: args.panelAmps } : {}),
      ...(args.notes ? { notes: args.notes } : {}),
    },
    mock,
    "Mocked electrical quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_electrical_price",
  description:
    "Get pricing for an electrical item: outlet/GFCI install, new circuit, panel upgrade, fixture or switch install. Use whenever the homeowner or contractor asks 'how much for [electrical thing]'.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      scope: {
        type: "STRING",
        description: "What kind of electrical work to price.",
        enum: Scope.options,
      },
      count: {
        type: "NUMBER",
        description: "How many of the item (e.g., 2 GFCI outlets). Defaults to 1.",
      },
      zip: { type: "STRING", description: "5-digit US ZIP code of the install location." },
      panelAmps: {
        type: "NUMBER",
        description: "For panel_upgrade: target amp service (e.g., 200).",
      },
    },
    required: ["scope", "zip"],
  },
};

export const ElectricalPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupElectricalPrice(raw, backend),
};
