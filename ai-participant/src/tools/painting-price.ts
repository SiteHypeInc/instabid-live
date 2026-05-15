import { z } from "zod";
import { postQuoteOnly, regionForZip, REGION_MULT, type Tool } from "./_shared.js";

export const Surface = z.enum(["interior_walls", "interior_ceiling", "interior_trim", "cabinets", "exterior_siding"]);
export type Surface = z.infer<typeof Surface>;

export const Args = z.object({
  surface: Surface,
  paintArea: z.number().positive().max(20000).optional(),
  rooms: z.number().int().positive().max(40).optional(),
  coats: z.number().int().min(1).max(4).default(2),
  zip: z.string().regex(/^\d{5}$/),
  colorChange: z.enum(["light_to_dark", "dark_to_light", "same"]).optional(),
  cabinetFaces: z.number().int().positive().max(60).optional(),
});
export type Args = z.infer<typeof Args>;

const PER_SQFT_USD: Record<Surface, { material: number; labor: number }> = {
  interior_walls: { material: 0.45, labor: 1.6 },
  interior_ceiling: { material: 0.5, labor: 1.9 },
  interior_trim: { material: 0.6, labor: 2.4 },
  cabinets: { material: 1.4, labor: 4.5 },
  exterior_siding: { material: 0.8, labor: 2.6 },
};
// Rough sqft fallback per room when paintArea isn't given.
const SQFT_PER_ROOM = 380;

function effectiveCoats(args: Args): number {
  if (args.colorChange === "dark_to_light") return Math.max(args.coats, 2) + 1;
  return args.coats;
}

function mockQuote(args: Args) {
  const region = regionForZip(args.zip);
  const mult = REGION_MULT[region];
  const sqft = args.paintArea ?? (args.rooms ? args.rooms * SQFT_PER_ROOM : 200);
  const cabinetMultiplier = args.surface === "cabinets" && args.cabinetFaces ? args.cabinetFaces / 20 : 1;
  const coats = effectiveCoats(args);
  const rates = PER_SQFT_USD[args.surface];
  const material_total_usd = Math.round(rates.material * sqft * coats * mult * cabinetMultiplier);
  const labor_total_usd = Math.round(rates.labor * sqft * coats * mult * cabinetMultiplier);
  return {
    trade: "painting",
    surface: args.surface,
    paintArea: sqft,
    coats,
    zip: args.zip,
    region,
    colorChange: args.colorChange,
    material_total_usd,
    labor_total_usd,
    total_usd: material_total_usd + labor_total_usd,
  };
}

export async function lookupPaintingPrice(raw: unknown, backend: { url?: string; key?: string }) {
  const args = Args.parse(raw);
  const mock = mockQuote(args);
  return postQuoteOnly(
    backend,
    {
      trade: "painting",
      surface: args.surface,
      coats: effectiveCoats(args),
      zipCode: args.zip,
      ...(args.paintArea !== undefined ? { paintArea: args.paintArea, squareFeet: args.paintArea } : {}),
      ...(args.rooms !== undefined ? { rooms: args.rooms } : {}),
      ...(args.colorChange ? { colorChange: args.colorChange } : {}),
      ...(args.cabinetFaces !== undefined ? { cabinetFaces: args.cabinetFaces } : {}),
    },
    mock,
    "Mocked painting quote (no live pricing backend configured).",
  );
}

export const FunctionDeclaration = {
  name: "lookup_painting_price",
  description:
    "Get pricing for paint work: interior walls/ceiling/trim, cabinets, or exterior siding. Color change direction matters — dark_to_light typically needs an extra coat plus primer.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      surface: { type: "STRING", description: "What's being painted.", enum: Surface.options },
      paintArea: { type: "NUMBER", description: "Square feet to paint, if known. Otherwise estimate from rooms." },
      rooms: { type: "NUMBER", description: "Room count (used when paintArea isn't measured)." },
      coats: { type: "NUMBER", description: "Coats of paint planned. Defaults to 2." },
      zip: { type: "STRING", description: "5-digit US ZIP code." },
      colorChange: {
        type: "STRING",
        description: "Direction of color change — dark_to_light usually adds a coat + primer.",
        enum: ["light_to_dark", "dark_to_light", "same"],
      },
      cabinetFaces: { type: "NUMBER", description: "For cabinets surface: number of door/drawer faces." },
    },
    required: ["surface", "zip"],
  },
};

export const PaintingPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw, backend) => lookupPaintingPrice(raw, backend),
};
