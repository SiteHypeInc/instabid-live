// Shared types + helpers for the in-call pricing tool family.
// Every tool fronts an instabid2 /api/estimate call with quote_only=true
// (so nothing is persisted). On backend error or missing config, each tool
// falls back to a deterministic mock so the AI never goes silent on a price
// question mid-call.

export type PricingBackendConfig = {
  url?: string;
  key?: string;
};

export type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: "OBJECT";
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
};

export type Tool = {
  declaration: GeminiFunctionDeclaration;
  handle: (raw: unknown, backend: PricingBackendConfig) => Promise<unknown>;
};

export type QuoteOnlyResult =
  | ({ ok: true; source: "backend" } & Record<string, unknown>)
  | { ok: true; source: "mock"; mock: Record<string, unknown>; notes: string }
  | { ok: true; source: "mock_fallback"; backend_error: string; mock: Record<string, unknown>; notes: string };

export async function postQuoteOnly(
  backend: PricingBackendConfig,
  payload: Record<string, unknown>,
  mock: Record<string, unknown>,
  mockNote: string,
): Promise<QuoteOnlyResult> {
  if (!backend.url) {
    return { ok: true, source: "mock", mock, notes: mockNote };
  }
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (backend.key) headers.authorization = `Bearer ${backend.key}`;
    const body = { api_key: backend.key, ...payload, quote_only: true };
    const res = await fetch(backend.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: true,
        source: "mock_fallback",
        backend_error: `status=${res.status} body=${text.slice(0, 200)}`,
        mock,
        notes: mockNote,
      };
    }
    const json = (await res.json()) as Record<string, unknown>;
    return { ok: true, source: "backend", ...json };
  } catch (err) {
    return {
      ok: true,
      source: "mock_fallback",
      backend_error: err instanceof Error ? err.message : String(err),
      mock,
      notes: mockNote,
    };
  }
}

// ZIP-region multipliers shared across mocks so pricing scales by geography.
export type Region = "NE" | "MW" | "S" | "W";
export function regionForZip(zip: string): Region {
  const first = zip[0];
  if (first === "0" || first === "1" || first === "2") return "NE";
  if (first === "3" || first === "4") return "S";
  if (first === "5" || first === "6") return "MW";
  return "W";
}
export const REGION_MULT: Record<Region, number> = { NE: 1.2, MW: 1.0, S: 0.95, W: 1.25 };
