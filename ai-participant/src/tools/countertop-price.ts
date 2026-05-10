// Mocked pricing tool. Acceptance per TEA-685 says this is a "mocked HTTP responder
// for now; swapped to real Rails endpoint once Jesse-side ticket lands". The mock
// returns a believable quote keyed by material × ZIP-region so the smoke test
// produces a stable answer.
import { z } from "zod";

export const Material = z.enum([
  "laminate",
  "butcher_block",
  "corian",
  "tile",
  "soapstone",
  "marble",
  "granite",
  "quartz",
  "quartzite",
]);
export type Material = z.infer<typeof Material>;

export const Args = z.object({
  material: Material,
  sqft: z.number().positive().max(2000),
  zip: z.string().regex(/^\d{5}$/),
});
export type Args = z.infer<typeof Args>;

export type Quote = {
  material: Material;
  sqft: number;
  zip: string;
  region: "NE" | "MW" | "S" | "W";
  material_total_usd: number;
  labor_total_usd: number;
  total_usd: number;
  notes: string;
};

const MATERIAL_PER_SQFT_USD: Record<Material, number> = {
  laminate: 25,
  butcher_block: 55,
  corian: 65,
  tile: 35,
  soapstone: 90,
  marble: 95,
  granite: 65,
  quartz: 80,
  quartzite: 105,
};

// Per-ZIP-region multipliers — labor varies more than material.
const REGION_MULT: Record<Quote["region"], { material: number; labor: number; baseLabor: number }> = {
  NE: { material: 1.15, labor: 1.35, baseLabor: 45 },
  MW: { material: 1.0, labor: 1.0, baseLabor: 35 },
  S: { material: 0.95, labor: 0.95, baseLabor: 32 },
  W: { material: 1.2, labor: 1.4, baseLabor: 50 },
};

function regionForZip(zip: string): Quote["region"] {
  const first = zip[0];
  if (first === "0" || first === "1" || first === "2") return "NE";
  if (first === "3" || first === "4") return "S";
  if (first === "5" || first === "6") return "MW";
  return "W";
}

export function lookupCountertopPrice(raw: unknown): Quote {
  const args = Args.parse(raw);
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const matRate = MATERIAL_PER_SQFT_USD[args.material] * mult.material;
  const laborRate = mult.baseLabor * mult.labor;
  const material_total_usd = Math.round(matRate * args.sqft);
  const labor_total_usd = Math.round(laborRate * args.sqft);
  const total_usd = material_total_usd + labor_total_usd;
  return {
    material: args.material,
    sqft: args.sqft,
    zip: args.zip,
    region,
    material_total_usd,
    labor_total_usd,
    total_usd,
    notes: "Mocked quote (TEA-685). Real Rails pricing API pending Jesse-side ticket.",
  };
}

// Gemini Live function declaration. Schema fields use UPPERCASE types per the
// generative-language API convention.
export const FunctionDeclaration = {
  name: "lookup_countertop_price",
  description:
    "Look up an installed countertop price quote (material + labor + total) for a given material, finished square footage, and US ZIP code. Returns a mocked but believable quote — call this whenever the homeowner or contractor asks for a price comparison or a number.",
  parameters: {
    type: "OBJECT",
    properties: {
      material: {
        type: "STRING",
        description: "Countertop material",
        enum: Material.options,
      },
      sqft: {
        type: "NUMBER",
        description: "Finished surface area in square feet (1–2000).",
      },
      zip: {
        type: "STRING",
        description: "5-digit US ZIP code of the install location.",
      },
    },
    required: ["material", "sqft", "zip"],
  },
} as const;
