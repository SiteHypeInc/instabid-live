import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { generateEstimate } from "./claude.js";
import { Estimate, GenerateRequest, type LineItem } from "./types.js";
import { postEstimate } from "./sink.js";

const cfg = loadConfig();

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/generate") {
    const body = await readJson(req);
    const parsed = GenerateRequest.safeParse(body);
    if (!parsed.success) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request", issues: parsed.error.issues }));
      return;
    }

    try {
      const estimate = await produceEstimate(parsed.data);
      const sinkResult = await postEstimate(cfg, estimate, parsed.data);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ estimate, sink: sinkResult }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "generate_failed";
      console.error("[generate]", message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "generate_failed", message }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// Two paths: Claude (rich estimate from transcript + observations) and a
// pricing-tool fast path that skips Claude when ANTHROPIC_API_KEY isn't set
// or the transcript is empty. Fast path uses the last in-call pricing
// lookup as the estimate basis — that's what the contractor actually quoted.
async function produceEstimate(req: GenerateRequest): Promise<Estimate> {
  const haveTranscript = req.transcript.length > 0;
  if (cfg.ANTHROPIC_API_KEY && haveTranscript) {
    try {
      return await generateEstimate(cfg, req);
    } catch (err) {
      console.warn(
        `[generate] claude path failed, falling back to pricing fast-path: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const fast = synthesizeFromLastPricing(req);
  if (fast) return fast;
  throw new Error(
    haveTranscript
      ? "ANTHROPIC_API_KEY not set and no lastPricingCall in request"
      : "transcript empty and no lastPricingCall in request",
  );
}

function synthesizeFromLastPricing(req: GenerateRequest): Estimate | undefined {
  const lpc = req.lastPricingCall;
  if (!lpc) return undefined;

  const args = lpc.args;
  const result = (lpc.result ?? {}) as Record<string, unknown>;
  const material = typeof args.material === "string" ? args.material : "unknown";
  const sqft = typeof args.sqft === "number" ? args.sqft : 0;

  const materialTotal = num(result.material_total_usd) ?? 0;
  const laborTotal = num(result.labor_total_usd) ?? 0;
  const total = num(result.total_usd) ?? materialTotal + laborTotal;

  const lineItems: LineItem[] = [];
  if (materialTotal > 0 && sqft > 0) {
    const unitPrice = Math.round(materialTotal / sqft);
    lineItems.push({
      sku: `COUNTER-${material.toUpperCase()}-STD`,
      description: `${material} countertop slab + fabrication`,
      quantity: sqft,
      unit: "sqft",
      unitPrice,
      extended: materialTotal,
    });
  }
  if (laborTotal > 0 && sqft > 0) {
    const unitPrice = Math.round(laborTotal / sqft);
    lineItems.push({
      sku: "LABOR-INSTALL",
      description: "Installation labor",
      quantity: sqft,
      unit: "sqft",
      unitPrice,
      extended: laborTotal,
    });
  }
  if (lineItems.length === 0) {
    lineItems.push({
      sku: "ESTIMATE-PLACEHOLDER",
      description: "Estimate from in-call pricing tool",
      quantity: 1,
      unit: "ea",
      unitPrice: total,
      extended: total,
    });
  }

  return {
    sessionId: req.sessionId,
    trade: "kitchen-countertops",
    zip: req.zip,
    summary: `Synthesized from last in-call pricing lookup: ${material} ${sqft} sqft`,
    lineItems,
    subtotal: total,
    total,
    assumptions: ["Fast path: Claude was not invoked. Pricing taken directly from in-call tool result."],
    followUps: [],
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

server.listen(cfg.PORT, () => {
  console.log(`[estimate-generator] listening on :${cfg.PORT}`);
});

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const shutdown = (signal: string) => {
  console.log(`[estimate-generator] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
