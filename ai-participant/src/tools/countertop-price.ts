// Pricing tool. Lives in two modes:
//   - HTTP mode: if INSTABID_PRICING_URL is set, POST {material, sqft, zip} and
//     return the backend's JSON response unchanged (modulo a top-level
//     {ok, source, ...backend-fields} envelope).
//   - Mock mode (fallback): deterministic believable quote keyed by material ×
//     ZIP-region. Used when the env is unset, when the backend errors, or when
//     the response is malformed.
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
  state: z.string().regex(/^[A-Z]{2}$/).optional(),
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

export type PricingBackendConfig = {
  url?: string;
  key?: string;
};

export type PricingResult =
  | ({ ok: true; source: "backend" } & Record<string, unknown>)
  | ({ ok: true; source: "mock" } & Quote)
  | ({ ok: true; source: "mock_fallback"; backend_error: string } & Quote);

function mockQuote(args: Args): Quote {
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
    notes: "Mocked quote (no live pricing backend configured).",
  };
}

export async function lookupCountertopPrice(
  raw: unknown,
  backend: PricingBackendConfig = {},
): Promise<PricingResult> {
  const args = Args.parse(raw);

  if (!backend.url) {
    return { ok: true, source: "mock", ...mockQuote(args) };
  }

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // instabid2 /api/estimate reads api_key from the body. The Bearer header
    // is harmless but unused — kept for any future backend that wants it.
    if (backend.key) headers.authorization = `Bearer ${backend.key}`;
    const payload: Record<string, unknown> = {
      api_key: backend.key,
      trade: "countertops",
      material: args.material,
      squareFeet: args.sqft,
      zipCode: args.zip,
      quote_only: true,
    };
    if (args.state) payload.state = args.state;
    const res = await fetch(backend.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: true,
        source: "mock_fallback",
        backend_error: `status=${res.status} body=${body.slice(0, 200)}`,
        ...mockQuote(args),
      };
    }
    const json = (await res.json()) as Record<string, unknown>;
    return { ok: true, source: "backend", ...json };
  } catch (err) {
    return {
      ok: true,
      source: "mock_fallback",
      backend_error: err instanceof Error ? err.message : String(err),
      ...mockQuote(args),
    };
  }
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
      state: {
        type: "STRING",
        description:
          "Optional 2-letter US state code (e.g., 'TX', 'CA') for the install location. Improves regional labor-rate accuracy. Infer from ZIP if homeowner hasn't said it explicitly.",
      },
    },
    required: ["material", "sqft", "zip"],
  },
} as const;
