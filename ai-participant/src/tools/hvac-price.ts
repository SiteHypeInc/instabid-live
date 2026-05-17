import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const SystemType = z.enum([
  "central_ac",
  "heat_pump",
  "furnace",
  "mini_split",
  "register_add",
  "duct_repair",
]);
export type SystemType = z.infer<typeof SystemType>;

export const Args = z.object({
  systemType: SystemType,
  squareFeet: z.number().positive().max(20000).optional(),
  tonnage: z.number().positive().max(10).optional(),
  units: z.number().int().positive().max(8).default(1),
  zip: z.string().regex(/^\d{5}$/),
  efficiency: z.enum(["standard", "high", "premium"]).default("standard"),
});
export type Args = z.infer<typeof Args>;

const BASE_USD: Record<SystemType, { material: number; labor: number; per: "ton" | "unit" | "system" }> = {
  central_ac: { material: 1800, labor: 1100, per: "ton" },
  heat_pump: { material: 2200, labor: 1300, per: "ton" },
  furnace: { material: 1900, labor: 900, per: "system" },
  mini_split: { material: 1400, labor: 800, per: "unit" },
  register_add: { material: 60, labor: 180, per: "unit" },
  duct_repair: { material: 35, labor: 120, per: "unit" },
};

const EFFICIENCY_MULT: Record<Args["efficiency"], number> = {
  standard: 1.0,
  high: 1.25,
  premium: 1.55,
};

function impliedTonnage(args: Args): number {
  if (args.tonnage) return args.tonnage;
  if (args.squareFeet) return Math.max(1.5, Math.min(5, Math.ceil((args.squareFeet / 600) * 2) / 2));
  return 3;
}

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const eff = EFFICIENCY_MULT[args.efficiency];
  const base = BASE_USD[args.systemType];
  let qty = 1;
  if (base.per === "ton") qty = impliedTonnage(args);
  else if (base.per === "unit") qty = args.units;
  const material_total_usd = Math.round(base.material * qty * mult * eff);
  const labor_total_usd = Math.round(base.labor * qty * mult);
  return {
    trade: "hvac",
    systemType: args.systemType,
    tonnage: base.per === "ton" ? qty : undefined,
    units: base.per === "unit" ? qty : undefined,
    zip: args.zip,
    region,
    efficiency: args.efficiency,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupHvacPrice(raw: unknown, backend: { url?: string; key?: string }) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "hvac",
      systemType: args.systemType,
      units: args.units,
      zipCode: args.zip,
      efficiency: args.efficiency,
      ...(args.tonnage !== undefined ? { tonnage: args.tonnage } : {}),
      ...(args.squareFeet !== undefined ? { squareFeet: args.squareFeet } : {}),
    },
    mock,
    "Mocked HVAC quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_hvac_price",
  description:
    "Get pricing for HVAC: central AC, heat pump, furnace, mini-split, register adds, duct repair. " +
    "Do NOT use this for range hoods or kitchen vent fans — call lookup_range_hood_price instead.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      systemType: { type: "STRING", description: "System or scope.", enum: SystemType.options },
      squareFeet: { type: "NUMBER", description: "Conditioned area, used to size tonnage if not given." },
      tonnage: { type: "NUMBER", description: "AC/heat-pump tonnage if known (e.g., 3, 3.5, 4)." },
      units: { type: "NUMBER", description: "Mini-split heads, registers, or duct repair points. Defaults to 1." },
      zip: { type: "STRING", description: "5-digit US ZIP code." },
      efficiency: {
        type: "STRING",
        description: "Equipment efficiency tier.",
        enum: ["standard", "high", "premium"],
      },
    },
    required: ["systemType", "zip"],
  },
};

export const HvacPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupHvacPrice(raw, backend),
};
