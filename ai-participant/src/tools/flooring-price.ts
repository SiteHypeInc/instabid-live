import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const FlooringType = z.enum([
  "carpet",
  "vinyl_plank",
  "laminate",
  "engineered_wood",
  "solid_hardwood",
  "tile",
  "stone",
]);
export type FlooringType = z.infer<typeof FlooringType>;

export const Args = z.object({
  flooringType: FlooringType,
  squareFeet: z.number().positive().max(20000),
  zip: z.string().regex(/^\d{5}$/),
  removeExisting: z.boolean().default(false),
  includeStairs: z.boolean().default(false),
  stairSteps: z.number().int().min(0).max(40).optional(),
  subfloorRepair: z.boolean().default(false),
});
export type Args = z.infer<typeof Args>;

const PER_SQFT_USD: Record<FlooringType, { material: number; labor: number }> = {
  carpet: { material: 2.8, labor: 1.4 },
  vinyl_plank: { material: 3.5, labor: 2.1 },
  laminate: { material: 2.6, labor: 2.4 },
  engineered_wood: { material: 6.5, labor: 3.5 },
  solid_hardwood: { material: 9.0, labor: 4.5 },
  tile: { material: 5.0, labor: 6.0 },
  stone: { material: 12.0, labor: 9.0 },
};

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const rates = PER_SQFT_USD[args.flooringType];
  let material_total_usd = Math.round(rates.material * args.squareFeet * mult);
  let labor_total_usd = Math.round(rates.labor * args.squareFeet * mult);
  if (args.removeExisting) labor_total_usd += Math.round(args.squareFeet * 0.9 * mult);
  if (args.subfloorRepair) {
    material_total_usd += Math.round(args.squareFeet * 0.4 * mult);
    labor_total_usd += Math.round(args.squareFeet * 0.6 * mult);
  }
  if (args.includeStairs) {
    const steps = args.stairSteps ?? 12;
    labor_total_usd += Math.round(steps * 65 * mult);
    material_total_usd += Math.round(steps * 30 * mult);
  }
  return {
    trade: "flooring",
    flooringType: args.flooringType,
    squareFeet: args.squareFeet,
    zip: args.zip,
    region,
    removeExisting: args.removeExisting,
    includeStairs: args.includeStairs,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupFlooringPrice(raw: unknown, backend: { url?: string; key?: string }) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "flooring",
      flooringType: args.flooringType,
      squareFeet: args.squareFeet,
      zipCode: args.zip,
      removeExisting: args.removeExisting,
      includeStairs: args.includeStairs,
      ...(args.stairSteps !== undefined ? { stairSteps: args.stairSteps } : {}),
      subfloorCondition: args.subfloorRepair ? "needs_repair" : "good",
    },
    mock,
    "Mocked flooring quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_flooring_price",
  description:
    "Get installed flooring pricing for carpet/vinyl/laminate/engineered/hardwood/tile/stone. Tear-out, stairs, and subfloor repair add real cost — flag them when known.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      flooringType: { type: "STRING", description: "Type of flooring.", enum: FlooringType.options },
      squareFeet: { type: "NUMBER", description: "Floor area in square feet." },
      zip: { type: "STRING", description: "5-digit US ZIP code." },
      removeExisting: { type: "BOOLEAN", description: "True if tear-out of existing flooring is in scope." },
      includeStairs: { type: "BOOLEAN", description: "True if a staircase needs to be done in the same material." },
      stairSteps: { type: "NUMBER", description: "Step count (when includeStairs=true)." },
      subfloorRepair: { type: "BOOLEAN", description: "True if subfloor needs patching/repair before install." },
    },
    required: ["flooringType", "squareFeet", "zip"],
  },
};

export const FlooringPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupFlooringPrice(raw, backend),
};
