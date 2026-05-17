// Cabinet pricing tool. Mirrors countertop-price.ts: HTTP mode posts to
// instabid2 /api/estimate (quote_only=true); falls back to a deterministic
// mock so the AI never goes silent on a price question mid-call.
//
// Seed rates from John (TEA-682 thread, 2026-05-17): per-LF tier rates with
// material × doorStyle multipliers, separate labor LF rate by tier, crown as
// a flat per-LF add-on. Regional table inherited from countertops.
import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const Tier = z.enum(["stock", "semi_custom", "custom"]);
export type Tier = z.infer<typeof Tier>;

export const Material = z.enum([
  "mdf",
  "birch",
  "oak",
  "maple",
  "cherry",
  "walnut",
]);
export type Material = z.infer<typeof Material>;

export const DoorStyle = z.enum(["flat", "shaker", "raised"]);
export type DoorStyle = z.infer<typeof DoorStyle>;

export const Args = z.object({
  linearFeet: z.number().positive().max(200),
  tier: Tier,
  material: Material,
  doorStyle: DoorStyle,
  crown: z.boolean().default(false),
  zip: z.string().regex(/^\d{5}$/),
  state: z.string().regex(/^[A-Z]{2}$/).optional(),
});
export type Args = z.infer<typeof Args>;

// Per-LF base rate for a typical kitchen run (base + wall combined),
// oak shaker baseline. Multipliers below adjust for material and door style.
const TIER_RATE_PER_LF: Record<Tier, { material: number; laborHoursPerLf: number }> = {
  stock: { material: 250, laborHoursPerLf: 1.5 },
  semi_custom: { material: 450, laborHoursPerLf: 2.0 },
  custom: { material: 700, laborHoursPerLf: 2.5 },
};

const MATERIAL_MULT: Record<Material, number> = {
  mdf: 0.85,
  birch: 0.95,
  oak: 1.0,
  maple: 1.05,
  cherry: 1.15,
  walnut: 1.3,
};

const DOOR_STYLE_MULT: Record<DoorStyle, number> = {
  flat: 0.95,
  shaker: 1.0,
  raised: 1.1,
};

const CROWN_MATERIAL_PER_LF = 6.5;
const CROWN_LABOR_HOURS_PER_LF = 0.1;
const WASTE_FACTOR = 1.1;
const MOCK_HOURLY_RATE = 65;

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const tier = TIER_RATE_PER_LF[args.tier];
  const matMult = MATERIAL_MULT[args.material];
  const styleMult = DOOR_STYLE_MULT[args.doorStyle];

  let material_total_usd =
    args.linearFeet * tier.material * matMult * styleMult * WASTE_FACTOR;
  let labor_hours = args.linearFeet * tier.laborHoursPerLf;

  if (args.crown) {
    material_total_usd += args.linearFeet * CROWN_MATERIAL_PER_LF;
    labor_hours += args.linearFeet * CROWN_LABOR_HOURS_PER_LF;
  }

  material_total_usd = Math.round(material_total_usd * mult);
  const labor_total_usd = Math.round(labor_hours * MOCK_HOURLY_RATE * mult);

  return {
    trade: "cabinets",
    tier: args.tier,
    material: args.material,
    doorStyle: args.doorStyle,
    crown: args.crown,
    linearFeet: args.linearFeet,
    zip: args.zip,
    region,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupCabinetPrice(
  raw: unknown,
  backend: { url?: string; key?: string },
) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "cabinets",
      linearFeet: args.linearFeet,
      tier: args.tier,
      material: args.material,
      doorStyle: args.doorStyle,
      crown: args.crown,
      zipCode: args.zip,
      ...(args.state ? { state: args.state } : {}),
    },
    mock,
    "Mocked cabinet quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_cabinet_price",
  description:
    "Get installed kitchen-cabinet pricing for a run measured in linear feet. " +
    "Tier captures stock vs. semi-custom vs. fully custom shop work. Material " +
    "and door style are independent levers (e.g. semi-custom cherry shaker). " +
    "Set crown=true if a crown molding band runs the top of the cabinets.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      linearFeet: {
        type: "NUMBER",
        description: "Run of cabinetry in linear feet (base+wall combined run, 1–200).",
      },
      tier: {
        type: "STRING",
        description: "Cabinet build tier.",
        enum: Tier.options,
      },
      material: {
        type: "STRING",
        description: "Cabinet box/door material.",
        enum: Material.options,
      },
      doorStyle: {
        type: "STRING",
        description: "Door front style.",
        enum: DoorStyle.options,
      },
      crown: {
        type: "BOOLEAN",
        description: "True if crown molding runs the top of the cabinets.",
      },
      zip: { type: "STRING", description: "5-digit US ZIP code of the install location." },
      state: {
        type: "STRING",
        description:
          "Optional 2-letter US state code. Improves regional labor-rate accuracy.",
      },
    },
    required: ["linearFeet", "tier", "material", "doorStyle", "zip"],
  },
};

export const CabinetPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupCabinetPrice(raw, backend),
};
