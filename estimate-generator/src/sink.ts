import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { Estimate, GenerateRequest, PricingCall } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCAL_SINK_DIR = join(HERE, "..", "local-sink");

export type InstabidPostResult = {
  trade: string;
  tool: string;
  status: number;
  ok: boolean;
  body: string;
  payload: Record<string, unknown>;
};

export type SinkResult =
  | { sink: "rails"; status: number; ok: boolean; body: string }
  | { sink: "instabid"; status: number; ok: boolean; body: string; payload: Record<string, unknown> }
  | { sink: "instabid_multi"; results: InstabidPostResult[] }
  | { sink: "local"; file: string };

const TOOL_TO_TRADE: Record<string, string> = {
  lookup_countertop_price: "countertops",
  lookup_electrical_price: "electrical",
  lookup_plumbing_price: "plumbing",
  lookup_painting_price: "painting",
  lookup_flooring_price: "flooring",
  lookup_hvac_price: "hvac",
  lookup_roofing_price: "roofing",
  lookup_drywall_price: "drywall",
  lookup_siding_price: "siding",
};

function pickSink(cfg: Config): "rails" | "local" | "instabid" {
  if (cfg.ESTIMATE_SINK === "local") return "local";
  if (cfg.ESTIMATE_SINK === "rails") return "rails";
  if (cfg.ESTIMATE_SINK === "instabid") return "instabid";
  if (cfg.INSTABID_API_URL) return "instabid";
  if (cfg.RAILS_API_URL) return "rails";
  return "local";
}

export async function postEstimate(
  cfg: Config,
  estimate: Estimate,
  req?: GenerateRequest,
): Promise<SinkResult> {
  const sink = pickSink(cfg);

  if (sink === "rails") {
    if (!cfg.RAILS_API_URL) throw new Error("RAILS_API_URL required when ESTIMATE_SINK=rails");
    const url = `${cfg.RAILS_API_URL.replace(/\/$/, "")}/api/v1/estimates`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.RAILS_API_KEY) headers.authorization = `Bearer ${cfg.RAILS_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ estimate }),
    });
    const body = await res.text();
    return { sink: "rails", status: res.status, ok: res.ok, body };
  }

  if (sink === "instabid") {
    if (!cfg.INSTABID_API_URL) throw new Error("INSTABID_API_URL required when ESTIMATE_SINK=instabid");
    if (!cfg.INSTABID_API_KEY) throw new Error("INSTABID_API_KEY required when ESTIMATE_SINK=instabid");

    const calls = req?.pricingCalls ?? [];
    if (calls.length > 1) {
      const results: InstabidPostResult[] = [];
      for (const call of calls) {
        const trade = TOOL_TO_TRADE[call.tool] ?? "countertops";
        const payload = buildInstabidPayloadFromCall(cfg.INSTABID_API_KEY, trade, call, estimate, req);
        const res = await fetch(cfg.INSTABID_API_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.text();
        results.push({ trade, tool: call.tool, status: res.status, ok: res.ok, body, payload });
      }
      return { sink: "instabid_multi", results };
    }

    const payload = buildInstabidPayload(cfg.INSTABID_API_KEY, estimate, req);
    const res = await fetch(cfg.INSTABID_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    return { sink: "instabid", status: res.status, ok: res.ok, body, payload };
  }

  const dir = cfg.LOCAL_SINK_DIR ?? DEFAULT_LOCAL_SINK_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${estimate.sessionId}.json`);
  writeFileSync(file, JSON.stringify(estimate, null, 2));
  return { sink: "local", file };
}

// Reshape an Estimate into instabid2 /api/estimate body. instabid2 expects
// trade-specific fields at top-level (material, squareFeet, edgeProfile, …)
// and runs its own pricing pipeline on them. We forward the contractor's
// chosen pricing-tool args as the source of truth, since those are what the
// AI actually quoted on the call. Customer details come from the spawn meta.
function buildInstabidPayload(
  apiKey: string,
  estimate: Estimate,
  req?: GenerateRequest,
): Record<string, unknown> {
  const customer = req?.customer ?? {};
  const args = req?.lastPricingCall?.args ?? {};

  const material = pickString(args.material) ?? extractMaterialFromEstimate(estimate);
  const squareFeet = pickNumber(args.sqft) ?? pickNumber(args.squareFeet);
  const zip = pickString(args.zip) ?? estimate.zip;

  const out: Record<string, unknown> = {
    api_key: apiKey,
    trade: "countertops",
    customerName: customer.name ?? "InstaBid Live Customer",
    customerEmail: customer.email,
    customerPhone: customer.phone,
    propertyAddress: customer.address,
    city: customer.city,
    state: customer.state,
    zipCode: zip,
    sessionId: estimate.sessionId,
    summary: estimate.summary,
  };

  if (material) out.material = material;
  if (squareFeet !== undefined) out.squareFeet = squareFeet;

  // Forward any additional pricing-tool args verbatim (edgeProfile,
  // sinkCutouts, cooktopCutouts, backsplashSqft, removal, linearFeet, …)
  // so future tool extensions automatically flow into the estimate body.
  for (const [k, v] of Object.entries(args)) {
    if (out[k] !== undefined) continue;
    if (k === "sqft") continue;
    out[k] = v;
  }

  return out;
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function extractMaterialFromEstimate(estimate: Estimate): string | undefined {
  const slab = estimate.lineItems.find((li) => li.sku.startsWith("COUNTER-"));
  if (!slab) return undefined;
  const parts = slab.sku.split("-");
  return parts[1]?.toLowerCase();
}

// Multi-trade variant: builds the instabid2 payload from a single pricing
// call (tool + args) instead of the aggregated Estimate. The call's args
// already carry trade-specific fields (material, scope, surface, systemType,
// etc.) — forward them verbatim alongside customer/api_key envelope.
function buildInstabidPayloadFromCall(
  apiKey: string,
  trade: string,
  call: PricingCall,
  estimate: Estimate,
  req?: GenerateRequest,
): Record<string, unknown> {
  const customer = req?.customer ?? {};
  const args = call.args;
  const zip =
    pickString(args.zip) ?? pickString(args.zipCode) ?? estimate.zip;

  const out: Record<string, unknown> = {
    api_key: apiKey,
    trade,
    customerName: customer.name ?? "InstaBid Live Customer",
    customerEmail: customer.email,
    customerPhone: customer.phone,
    propertyAddress: customer.address,
    city: customer.city,
    state: customer.state,
    zipCode: zip,
    sessionId: estimate.sessionId,
    summary: `${trade} estimate from InstaBid Live walk-session`,
  };

  for (const [k, v] of Object.entries(args)) {
    if (out[k] !== undefined) continue;
    // Normalize legacy short keys to instabid2's canonical names.
    if (k === "sqft") {
      if (out.squareFeet === undefined) out.squareFeet = v;
      continue;
    }
    if (k === "zip") continue; // already mapped to zipCode
    out[k] = v;
  }

  return out;
}
