import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const SidingType = z.enum([
  "vinyl",
  "fiber_cement",
  "hardie",
  "wood",
  "metal",
  "aluminum",
  "stucco",
]);
export type SidingType = z.infer<typeof SidingType>;

export const Args = z.object({
  sidingType: SidingType,
  squareFeet: z.number().positive().max(20000),
  stories: z.number().int().min(1).max(4).default(1),
  removal: z.boolean().default(false),
  trimFeet: z.number().nonnegative().max(2000).default(0),
  zip: z.string().regex(/^\d{5}$/),
});
export type Args = z.infer<typeof Args>;

const PER_SQFT_USD: Record<SidingType, { material: number; labor: number }> = {
  vinyl: { material: 5.5, labor: 3.0 },
  fiber_cement: { material: 7.5, labor: 4.5 },
  hardie: { material: 7.5, labor: 4.5 },
  wood: { material: 8.0, labor: 5.0 },
  metal: { material: 9.0, labor: 4.5 },
  aluminum: { material: 9.0, labor: 4.5 },
  stucco: { material: 6.0, labor: 6.5 },
};
const STORY_MULT: Record<number, number> = { 1: 1.0, 2: 1.25, 3: 1.5, 4: 1.75 };

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const rates = PER_SQFT_USD[args.sidingType];
  const sm = STORY_MULT[args.stories] ?? 1.0;
  const adjustedSqft = args.squareFeet * 1.12;
  let material_total_usd = Math.round(adjustedSqft * rates.material * mult + 175 * Math.ceil(args.squareFeet / 1350) + 200);
  let labor_total_usd = Math.round(args.squareFeet * rates.labor * mult * sm);
  if (args.removal) {
    material_total_usd += 450;
    labor_total_usd += Math.round(args.squareFeet * 0.5 * mult);
  }
  if (args.trimFeet > 0) {
    material_total_usd += Math.round(args.trimFeet * 5.5);
    labor_total_usd += Math.round(args.trimFeet * 2.0 * mult);
  }
  return {
    trade: "siding",
    sidingType: args.sidingType,
    squareFeet: args.squareFeet,
    stories: args.stories,
    removal: args.removal,
    trimFeet: args.trimFeet,
    zip: args.zip,
    region,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupSidingPrice(raw: unknown, backend: { url?: string; key?: string }) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "siding",
      sidingType: args.sidingType,
      squareFeet: args.squareFeet,
      stories: args.stories,
      removal: args.removal,
      ...(args.trimFeet > 0 ? { trimFeet: args.trimFeet } : {}),
      zipCode: args.zip,
    },
    mock,
    "Mocked siding quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_siding_price",
  description:
    "Get installed siding pricing for vinyl/fiber-cement(Hardie)/wood/metal/aluminum/stucco. Stories, tear-off, and trim all materially affect cost — pass them when known.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      sidingType: { type: "STRING", description: "Siding material type.", enum: SidingType.options },
      squareFeet: { type: "NUMBER", description: "Wall area to side, in square feet." },
      stories: { type: "NUMBER", description: "Number of stories (1-4). Drives scaffolding labor." },
      removal: { type: "BOOLEAN", description: "True if existing siding must be torn off." },
      trimFeet: { type: "NUMBER", description: "Linear feet of trim/J-channel/corner work." },
      zip: { type: "STRING", description: "5-digit US ZIP code." },
    },
    required: ["sidingType", "squareFeet", "zip"],
  },
};

export const SidingPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupSidingPrice(raw, backend),
};
