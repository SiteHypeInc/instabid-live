// Range-hood pricing tool. Split out of the HVAC tool so the bot stops
// mis-routing kitchen ventilation as a mini-split (see TEA-827).
//
// Pricing model:
//   - Unit cost by CFM tier × unit grade (builder / mid / pro)
//   - Install labor scales with vent path: recirc is a 2-hr mount-and-wire,
//     ductless_makeup adds an air-return register, exterior_vented is the
//     full job (cut framing, run duct, exterior cap, flashing) — 4x the
//     labor.
//   - Auto makeup-air upcharge when CFM >= 600 on exterior_vented (code
//     trigger in most jurisdictions: 400+ CFM exhaust needs powered makeup).
import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const VentType = z.enum([
  "exterior_vented",
  "recirculating",
  "ductless_makeup",
]);
export type VentType = z.infer<typeof VentType>;

export const CfmTier = z.enum(["300", "600", "900", "1200"]);
export type CfmTier = z.infer<typeof CfmTier>;

export const UnitGrade = z.enum(["builder", "mid", "pro"]);
export type UnitGrade = z.infer<typeof UnitGrade>;

export const Args = z.object({
  zip: z.string().regex(/^\d{5}$/),
  ventType: VentType,
  cfmTier: CfmTier,
  unitGrade: UnitGrade,
  state: z.string().regex(/^[A-Z]{2}$/).optional(),
});
export type Args = z.infer<typeof Args>;

const UNIT_COST_USD: Record<UnitGrade, Record<CfmTier, number>> = {
  builder: { "300": 180, "600": 300, "900": 500, "1200": 750 },
  mid: { "300": 380, "600": 600, "900": 950, "1200": 1400 },
  pro: { "300": 750, "600": 1200, "900": 1900, "1200": 2800 },
};

// Install labor hours by vent path. Exterior_vented is the heavy job:
// cut framing, run rigid duct, install exterior cap + flashing.
const VENT_LABOR_HOURS: Record<VentType, number> = {
  recirculating: 2,
  ductless_makeup: 4,
  exterior_vented: 8,
};

// Vent-path materials (duct, cap, filter kit) on top of the unit itself.
const VENT_MATERIAL_USD: Record<VentType, number> = {
  recirculating: 60,
  ductless_makeup: 80,
  exterior_vented: 360,
};

const MOCK_HOURLY_RATE = 65;

function makeupAirAdd(vent: VentType, cfm: CfmTier): { material: number; hours: number } {
  const cfmNum = parseInt(cfm, 10);
  if (vent === "exterior_vented" && cfmNum >= 600) {
    return { material: 450, hours: 2 };
  }
  return { material: 0, hours: 0 };
}

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];

  const unitCost = UNIT_COST_USD[args.unitGrade][args.cfmTier];
  const ventMaterial = VENT_MATERIAL_USD[args.ventType];
  const ventLabor = VENT_LABOR_HOURS[args.ventType];
  const makeup = makeupAirAdd(args.ventType, args.cfmTier);

  const material_total_usd = Math.round((unitCost + ventMaterial + makeup.material) * mult);
  const labor_hours_total = ventLabor + makeup.hours;
  const labor_total_usd = Math.round(labor_hours_total * MOCK_HOURLY_RATE * mult);

  return {
    trade: "range_hood",
    ventType: args.ventType,
    cfmTier: args.cfmTier,
    unitGrade: args.unitGrade,
    zip: args.zip,
    region,
    makeup_air_required: makeup.material > 0,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupRangeHoodPrice(
  raw: unknown,
  backend: { url?: string; key?: string },
) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "range_hood",
      ventType: args.ventType,
      cfmTier: args.cfmTier,
      unitGrade: args.unitGrade,
      zipCode: args.zip,
      ...(args.state ? { state: args.state } : {}),
    },
    mock,
    "Mocked range-hood quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_range_hood_price",
  description:
    "Get installed pricing for a kitchen range hood. Use this whenever the " +
    "conversation is about a hood / kitchen vent / over-the-range exhaust — " +
    "NOT lookup_hvac_price (which is for furnace / AC / heat pump / mini-split). " +
    "ventType is the big cost driver: exterior_vented (ducted through wall or " +
    "roof) is the most expensive because of the framing/duct work; " +
    "recirculating filters and dumps back into the kitchen; ductless_makeup adds " +
    "a passive air-return register. cfmTier picks the airflow class. unitGrade " +
    "is builder / mid / pro.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      zip: { type: "STRING", description: "5-digit US ZIP code of the install location." },
      ventType: {
        type: "STRING",
        description:
          "Vent path: exterior_vented (ducted outside), recirculating (filter + " +
          "back into kitchen), ductless_makeup (recirc + makeup-air register).",
        enum: VentType.options,
      },
      cfmTier: {
        type: "STRING",
        description: "Hood airflow class in CFM (300, 600, 900, 1200).",
        enum: CfmTier.options,
      },
      unitGrade: {
        type: "STRING",
        description: "Unit grade: builder, mid, or pro.",
        enum: UnitGrade.options,
      },
      state: {
        type: "STRING",
        description: "Optional 2-letter US state code. Improves regional labor-rate accuracy.",
      },
    },
    required: ["zip", "ventType", "cfmTier", "unitGrade"],
  },
};

export const RangeHoodPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupRangeHoodPrice(raw, backend),
};
