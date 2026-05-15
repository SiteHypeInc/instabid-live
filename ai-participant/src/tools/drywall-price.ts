import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const ProjectType = z.enum(["new_construction", "repair"]);
export type ProjectType = z.infer<typeof ProjectType>;

export const FinishLevel = z.enum(["level_3_standard", "level_4_smooth", "level_5_glass"]);
export type FinishLevel = z.infer<typeof FinishLevel>;

export const TextureType = z.enum(["none", "orange_peel", "knockdown", "popcorn"]);
export type TextureType = z.infer<typeof TextureType>;

export const DamageExtent = z.enum(["minor", "moderate", "extensive"]);
export type DamageExtent = z.infer<typeof DamageExtent>;

export const Args = z.object({
  projectType: ProjectType.default("new_construction"),
  squareFeet: z.number().positive().max(50000),
  rooms: z.number().int().min(1).max(50).default(1),
  ceilingHeight: z.number().int().min(8).max(20).default(8),
  finishLevel: FinishLevel.default("level_4_smooth"),
  textureType: TextureType.default("none"),
  damageExtent: DamageExtent.optional(),
  zip: z.string().regex(/^\d{5}$/),
});
export type Args = z.infer<typeof Args>;

const FINISH_MULT: Record<FinishLevel, number> = {
  level_3_standard: 1.0,
  level_4_smooth: 1.25,
  level_5_glass: 1.5,
};
const TEXTURE_PER_SQFT: Record<TextureType, number> = {
  none: 0,
  orange_peel: 0.8,
  knockdown: 1.0,
  popcorn: 0.65,
};
const REPAIR_BASE_USD: Record<DamageExtent, number> = {
  minor: 175,
  moderate: 425,
  extensive: 950,
};

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  let material_total_usd = 0;
  let labor_total_usd = 0;

  if (args.projectType === "new_construction") {
    const sheets = Math.ceil((args.squareFeet * 1.12) / 32);
    material_total_usd = Math.round((sheets * 12 + Math.ceil(sheets / 4) * 18 + Math.ceil(sheets / 8) * 8 + Math.ceil(sheets / 5) * 12 + args.rooms * 4 * 5 + 75) * mult);
    let labor = args.squareFeet * (0.75 + 0.65 + 0.35);
    labor *= FINISH_MULT[args.finishLevel];
    if (args.ceilingHeight >= 12) labor *= 1.3;
    else if (args.ceilingHeight >= 10) labor *= 1.15;
    const texture = args.squareFeet * TEXTURE_PER_SQFT[args.textureType];
    labor_total_usd = Math.round((labor + texture) * mult);
    material_total_usd += Math.round(texture * 0.3 * mult);
  } else {
    const base = REPAIR_BASE_USD[args.damageExtent ?? "minor"];
    material_total_usd = Math.round(base * 0.3 * mult);
    labor_total_usd = Math.round(base * 0.7 * mult);
  }

  return {
    trade: "drywall",
    projectType: args.projectType,
    squareFeet: args.squareFeet,
    rooms: args.rooms,
    ceilingHeight: args.ceilingHeight,
    finishLevel: args.finishLevel,
    textureType: args.textureType,
    zip: args.zip,
    region,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupDrywallPrice(raw: unknown, backend: { url?: string; key?: string }) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "drywall",
      projectType: args.projectType,
      squareFeet: args.squareFeet,
      rooms: args.rooms,
      ceilingHeight: args.ceilingHeight,
      finishLevel: args.finishLevel,
      textureType: args.textureType,
      zipCode: args.zip,
      ...(args.damageExtent ? { damageExtent: args.damageExtent } : {}),
    },
    mock,
    "Mocked drywall quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_drywall_price",
  description:
    "Get installed drywall pricing for new construction (hang/tape/finish) or repair work. Finish level, ceiling height, and texture all materially affect cost — pass them when known. For repairs, pass damageExtent.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      projectType: { type: "STRING", description: "new_construction (hang+finish) or repair (patches).", enum: ProjectType.options },
      squareFeet: { type: "NUMBER", description: "Wall+ceiling drywall area in square feet (not room sqft)." },
      rooms: { type: "NUMBER", description: "Distinct rooms — drives corner-bead count." },
      ceilingHeight: { type: "NUMBER", description: "Ceiling height in feet (8/9/10/12). >9ft adds labor." },
      finishLevel: { type: "STRING", description: "Finish quality.", enum: FinishLevel.options },
      textureType: { type: "STRING", description: "Surface texture finish.", enum: TextureType.options },
      damageExtent: { type: "STRING", description: "For repair only: severity of damage.", enum: DamageExtent.options },
      zip: { type: "STRING", description: "5-digit US ZIP code." },
    },
    required: ["squareFeet", "zip"],
  },
};

export const DrywallPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupDrywallPrice(raw, backend),
};
