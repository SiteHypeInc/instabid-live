import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const Material = z.enum([
  "asphalt_3tab",
  "asphalt_architectural",
  "metal_standing_seam",
  "metal_screw_down",
  "tile_clay",
  "tile_concrete",
  "slate",
  "wood_shake",
]);
export type Material = z.infer<typeof Material>;

export const Pitch = z.enum(["low", "standard", "steep"]);
export type Pitch = z.infer<typeof Pitch>;

export const Args = z.object({
  material: Material,
  squareFeet: z.number().positive().max(20000),
  pitch: Pitch.default("standard"),
  layers: z.number().int().min(1).max(4).default(1),
  zip: z.string().regex(/^\d{5}$/),
  needsPlywood: z.boolean().default(false),
  plywoodSqft: z.number().nonnegative().max(20000).optional(),
  chimneys: z.number().int().min(0).max(10).default(0),
  skylights: z.number().int().min(0).max(20).default(0),
});
export type Args = z.infer<typeof Args>;

const PER_SQFT_USD: Record<Material, { material: number; labor: number }> = {
  asphalt_3tab: { material: 1.4, labor: 1.6 },
  asphalt_architectural: { material: 2.0, labor: 1.8 },
  metal_screw_down: { material: 4.5, labor: 3.0 },
  metal_standing_seam: { material: 7.5, labor: 4.5 },
  tile_clay: { material: 9.0, labor: 5.5 },
  tile_concrete: { material: 6.5, labor: 4.5 },
  slate: { material: 14.0, labor: 8.0 },
  wood_shake: { material: 6.0, labor: 4.5 },
};

const PITCH_MULT: Record<Pitch, number> = { low: 1.0, standard: 1.15, steep: 1.4 };

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const rates = PER_SQFT_USD[args.material];
  const pitchMult = PITCH_MULT[args.pitch];
  let material_total_usd = Math.round(rates.material * args.squareFeet * mult);
  let labor_total_usd = Math.round(rates.labor * args.squareFeet * mult * pitchMult);
  // Tear-off: each existing layer adds labor.
  if (args.layers > 1) labor_total_usd += Math.round((args.layers - 1) * args.squareFeet * 0.7 * mult);
  if (args.needsPlywood) {
    const sqft = args.plywoodSqft ?? args.squareFeet;
    material_total_usd += Math.round(sqft * 1.4 * mult);
    labor_total_usd += Math.round(sqft * 0.9 * mult);
  }
  if (args.chimneys > 0) labor_total_usd += args.chimneys * Math.round(280 * mult);
  if (args.skylights > 0) labor_total_usd += args.skylights * Math.round(220 * mult);
  return {
    trade: "roofing",
    material: args.material,
    squareFeet: args.squareFeet,
    pitch: args.pitch,
    layers: args.layers,
    zip: args.zip,
    region,
    needsPlywood: args.needsPlywood,
    chimneys: args.chimneys,
    skylights: args.skylights,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupRoofingPrice(raw: unknown, backend: { url?: string; key?: string }) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "roofing",
      material: args.material,
      squareFeet: args.squareFeet,
      pitch: args.pitch,
      layers: args.layers,
      zipCode: args.zip,
      needsPlywood: args.needsPlywood,
      chimneys: args.chimneys,
      skylights: args.skylights,
      ...(args.plywoodSqft !== undefined ? { plywoodSqft: args.plywoodSqft } : {}),
    },
    mock,
    "Mocked roofing quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_roofing_price",
  description:
    "Get installed roofing pricing for shingle/metal/tile/slate/wood. Pitch, tear-off layers, plywood replacement, chimneys, and skylights all materially affect cost — pass them when known.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      material: { type: "STRING", description: "Roof covering material.", enum: Material.options },
      squareFeet: { type: "NUMBER", description: "Roof area in square feet (not 'squares' — multiply by 100)." },
      pitch: { type: "STRING", description: "Roof pitch class.", enum: Pitch.options },
      layers: { type: "NUMBER", description: "Existing layers to tear off. 1 = bare deck or fresh build." },
      zip: { type: "STRING", description: "5-digit US ZIP code." },
      needsPlywood: { type: "BOOLEAN", description: "True if any deck plywood needs replacing." },
      plywoodSqft: { type: "NUMBER", description: "Plywood replacement area in sqft." },
      chimneys: { type: "NUMBER", description: "Chimneys to flash around." },
      skylights: { type: "NUMBER", description: "Skylights to flash around." },
    },
    required: ["material", "squareFeet", "zip"],
  },
};

export const RoofingPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupRoofingPrice(raw, backend),
};
