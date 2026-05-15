import { z } from "zod";
import type { Tool } from "./_shared.js";

// Tier 3 fallback for materials/products outside the standard pricing tools.
// Adapts instabid-411/pricing/tier3-tavily.js to the AI-participant runtime:
// Tavily search across remodel-cost aggregator domains → Haiku parses snippets
// into a converged price band. ~$0.02/lookup. In-memory LRU cache avoids
// re-burning tokens within a single container's lifetime; persistent cache
// (write-back to a material_prices table) is deferred until that table exists
// in instabid2 — instabid2 currently caches per-ZIP regional multipliers, not
// per-material prices.

const TAVILY_URL = "https://api.tavily.com/search";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const ALLOWED_DOMAINS = [
  "homeguide.com",
  "angi.com",
  "homewyse.com",
  "homeadvisor.com",
  "thisoldhouse.com",
  "bobvila.com",
  "fixr.com",
  "houzz.com",
  "improvenet.com",
];

const MIN_DISTINCT_SOURCES = 3;
const MAX_BAND_RATIO = 5;
const HIGH_CONFIDENCE_MIN_DOMAINS = 4;
const HIGH_CONFIDENCE_MAX_RATIO = 2.5;

const TAVILY_MAX_RESULTS = 5;
const TAVILY_TIMEOUT_MS = 8000;
const OPENROUTER_TIMEOUT_MS = 15000;

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

const SYSTEM_PROMPT = `You are a remodeling-cost parser for a contractor-estimate system.

You receive a product spec and a set of already-fetched web search results from remodeling-cost aggregator sites. You do NOT browse. Read the snippets and return a single JSON object representing the converged price band.

OUTPUT SCHEMA (return only valid JSON, no prose, no code fences):
{
  "low": number,
  "high": number,
  "median": number,
  "unit": string,
  "sources": string[],
  "notes": string
}

RULES:
- Prefer "installed" pricing over "material-only" when the spec implies an installed job (flooring, countertops, cabinetry, etc.). Match what a contractor would estimate end-to-end.
- If the spec includes a brandHint (e.g. "Baldwin", "Kohler", "Sub-Zero"), your "notes" field MUST explicitly mention that brand name if the band came from brand-specific data. If you could only find generic-category pricing, OMIT the brand from notes — the caller rejects generic-category substitution for brand-hinted specs.
- Drop sources that gave wildly divergent numbers; mention the outlier in "notes". Do not average wildly divergent data.
- If fewer than 3 distinct aggregator domains quote this item, still return the JSON with whatever sources you have — the downstream code rejects low-convergence bands.
- For highly variable items (designer brass knobs, custom stone), it is VALID to return fewer than 3 sources. Honesty > hallucinated convergence.
- "sources" must be bare domain names (e.g. "homeguide.com", NOT full URLs). One entry per distinct domain.

Tier hints:
- budget   — contractor-grade, big-box stock
- standard — mid-market, what most homeowners install
- premium  — high-end, designer or specialty showroom

Return ONLY the JSON object.`;

export const Args = z.object({
  searchTerm: z.string().min(2).max(120),
  unit: z.enum(["installed_sqft", "linear_ft", "each", "per_sqft"]).default("installed_sqft"),
  tier: z.enum(["budget", "standard", "premium"]).default("standard"),
  brandHint: z.string().min(1).max(60).optional(),
  quantity: z.number().positive().max(20000).optional(),
  zip: z.string().regex(/^\d{5}$/).optional(),
});
export type Args = z.infer<typeof Args>;

type Spec = Pick<Args, "searchTerm" | "unit" | "tier" | "brandHint">;

type Band = {
  low: number;
  high: number;
  median: number;
  unit: string;
  sources: string[];
  confidence: "medium" | "high";
  notes: string;
};

type CacheEntry = { band: Band | null; expires: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(spec: Spec): string {
  return JSON.stringify({
    s: spec.searchTerm.trim().toLowerCase(),
    u: spec.unit,
    t: spec.tier,
    b: (spec.brandHint || "").trim().toLowerCase(),
  });
}

function cacheGet(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return e;
}

function cacheSet(key: string, band: Band | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { band, expires: Date.now() + CACHE_TTL_MS });
}

function buildTavilyQuery(spec: Spec): string {
  const parts: string[] = [];
  if (spec.brandHint) parts.push(spec.brandHint.trim());
  parts.push(spec.searchTerm.trim());
  parts.push(`cost per ${spec.unit.replace(/_/g, " ")}`);
  if (spec.tier === "budget") parts.push("budget");
  else if (spec.tier === "premium") parts.push("high-end");
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ");
}

type TavilyResult = { title: string | null; url: string | null; content: string };

async function callTavily(query: string, apiKey: string): Promise<TavilyResult[]> {
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: TAVILY_MAX_RESULTS,
      include_answer: false,
      include_raw_content: false,
      include_domains: ALLOWED_DOMAINS,
    }),
    signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Tavily HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; snippet?: string }> };
  return (data.results || []).map((r) => ({
    title: r.title || null,
    url: r.url || null,
    content: r.content || r.snippet || "",
  }));
}

async function callOpenRouter(spec: Spec, results: TavilyResult[], apiKey: string, model: string): Promise<string> {
  const lines = results
    .map((r, i) => {
      let domain = "(no-url)";
      if (r.url) {
        try {
          domain = new URL(r.url).hostname.replace(/^www\./, "");
        } catch {}
      }
      const snippet = (r.content || "").replace(/\s+/g, " ").trim().slice(0, 400);
      return `${i + 1}. ${r.title || "(untitled)"} — ${domain} — ${snippet}`;
    })
    .join("\n");
  const userMessage = [
    "Spec:",
    JSON.stringify({ searchTerm: spec.searchTerm, unit: spec.unit, tier: spec.tier, brandHint: spec.brandHint || null }, null, 2),
    "",
    "Tavily results (title — domain — snippet):",
    lines || "(no results)",
  ].join("\n");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://instabid.pro",
      "X-Title": "InstaBid Live",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: `${SYSTEM_PROMPT}\n\n${userMessage}` }],
    }),
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data?.choices?.[0]?.message?.content ?? "";
}

function parseLLMJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const s = raw.trim();
  const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }
  let stripped = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  if (!stripped.startsWith("{")) {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return null;
    stripped = m[0];
  }
  try { return JSON.parse(stripped); } catch { return null; }
}

function uniqueDomains(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out = new Set<string>();
  for (const d of arr) {
    if (typeof d !== "string") continue;
    const n = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (n) out.add(n);
  }
  return Array.from(out);
}

function validateBand(parsed: Record<string, unknown> | null, spec: Spec): Band | null {
  if (!parsed) return null;
  const low = Number(parsed.low);
  const high = Number(parsed.high);
  const median = Number(parsed.median);
  if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(median)) return null;
  if (low <= 0 || high <= 0 || median <= 0) return null;
  if (high < low) return null;
  if (high / low > MAX_BAND_RATIO) return null;
  if (median < low || median > high) return null;

  const sources = uniqueDomains(parsed.sources);
  if (sources.length < MIN_DISTINCT_SOURCES) return null;

  if (spec.brandHint) {
    const brand = spec.brandHint.trim().toLowerCase();
    const notes = typeof parsed.notes === "string" ? parsed.notes.toLowerCase() : "";
    if (brand && !notes.includes(brand)) return null;
  }

  const ratio = high / low;
  const confidence: Band["confidence"] =
    sources.length >= HIGH_CONFIDENCE_MIN_DOMAINS && ratio <= HIGH_CONFIDENCE_MAX_RATIO ? "high" : "medium";

  return {
    low,
    high,
    median,
    unit: typeof parsed.unit === "string" && parsed.unit.trim() ? parsed.unit.trim() : spec.unit,
    sources,
    confidence,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

export async function lookupUnknownMaterialPrice(raw: unknown): Promise<unknown> {
  const args = Args.parse(raw);
  const spec: Spec = { searchTerm: args.searchTerm, unit: args.unit, tier: args.tier, brandHint: args.brandHint };

  const tavilyKey = process.env.TAVILY_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.TIER3_TAVILY_MODEL || "anthropic/claude-haiku-4.5";
  if (!tavilyKey || !orKey) {
    return {
      source: "tier3_unavailable",
      reason: "TAVILY_API_KEY or OPENROUTER_API_KEY not configured",
      searchTerm: args.searchTerm,
    };
  }

  const key = cacheKey(spec);
  const hit = cacheGet(key);
  if (hit) {
    if (!hit.band) {
      return {
        source: "tier3_no_convergence",
        reason: "previous lookup did not converge (cached)",
        searchTerm: args.searchTerm,
        cacheHit: true,
      };
    }
    return shape(args, hit.band, true);
  }

  const query = buildTavilyQuery(spec);
  let tavilyResults: TavilyResult[];
  try {
    tavilyResults = await callTavily(query, tavilyKey);
  } catch (err) {
    return { source: "tier3_error", stage: "tavily", error: err instanceof Error ? err.message : String(err), query };
  }
  if (!tavilyResults.length) {
    cacheSet(key, null);
    return { source: "tier3_no_convergence", reason: "Tavily returned 0 results", query, cacheHit: false };
  }

  let parsedText: string;
  try {
    parsedText = await callOpenRouter(spec, tavilyResults, orKey, model);
  } catch (err) {
    return { source: "tier3_error", stage: "openrouter", error: err instanceof Error ? err.message : String(err), model };
  }
  const parsed = parseLLMJson(parsedText);
  if (!parsed) {
    cacheSet(key, null);
    return { source: "tier3_no_convergence", reason: "model output was not valid JSON", modelTextPreview: parsedText.slice(0, 200), cacheHit: false };
  }

  const band = validateBand(parsed, spec);
  if (!band) {
    cacheSet(key, null);
    return {
      source: "tier3_no_convergence",
      reason: spec.brandHint
        ? "band failed convergence rules (or brand guardrail rejected generic data)"
        : "band failed convergence rules (need ≥3 distinct domains, ratio ≤5)",
      searchTerm: args.searchTerm,
      cacheHit: false,
    };
  }

  cacheSet(key, band);
  return shape(args, band, false);
}

function shape(args: Args, band: Band, cacheHit: boolean) {
  const out: Record<string, unknown> = {
    source: "tier3_tavily",
    searchTerm: args.searchTerm,
    tier: args.tier,
    brandHint: args.brandHint || null,
    priceLow: band.low,
    priceHigh: band.high,
    priceMedian: band.median,
    unit: band.unit,
    confidence: band.confidence,
    sources: band.sources,
    notes: band.notes,
    cacheHit,
  };
  if (args.quantity !== undefined) {
    out.quantity = args.quantity;
    out.totalEstimateLow = Math.round(band.low * args.quantity);
    out.totalEstimateHigh = Math.round(band.high * args.quantity);
    out.totalEstimateMedian = Math.round(band.median * args.quantity);
  }
  return out;
}

export const FunctionDeclaration = {
  name: "lookup_unknown_material_price",
  description:
    "Tier 3 fallback for materials, fixtures, or products NOT covered by the standard trade pricing tools — exotic countertop materials (Dekton, Neolith, terrazzo, soapstone), specialty tile, designer fixtures, custom millwork, etc. Searches remodeling-cost aggregator sites and returns a converged price band with confidence rating. Use when the homeowner names a material/brand you don't recognize OR when a standard pricing tool returns an obvious default rather than a real quote. Costs ~$0.02 per lookup — only call when needed.",
  parameters: {
    type: "OBJECT" as const,
    properties: {
      searchTerm: {
        type: "STRING",
        description: "Plain-English product spec, e.g. 'Dekton countertop installed', 'reclaimed barn-wood flooring', 'Kohler Memoirs toilet'. Include trade context.",
      },
      unit: {
        type: "STRING",
        description: "Pricing unit. Default 'installed_sqft'.",
        enum: ["installed_sqft", "linear_ft", "each", "per_sqft"],
      },
      tier: {
        type: "STRING",
        description: "Quality/price tier. Default 'standard'.",
        enum: ["budget", "standard", "premium"],
      },
      brandHint: {
        type: "STRING",
        description: "Brand name if the customer specified one (e.g. 'Kohler', 'Sub-Zero'). Caller rejects generic-category data when a brand is given.",
      },
      quantity: {
        type: "NUMBER",
        description: "Optional quantity in the chosen unit. If provided, response includes a total estimate range.",
      },
      zip: {
        type: "STRING",
        description: "Optional 5-digit ZIP. Currently unused by the search but recorded for future regional adjustment.",
      },
    },
    required: ["searchTerm"],
  },
};

export const UnknownMaterialPriceTool: Tool = {
  declaration: FunctionDeclaration,
  handle: (raw) => lookupUnknownMaterialPrice(raw),
};
