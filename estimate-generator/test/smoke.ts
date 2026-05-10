/**
 * Smoke test — feeds a hand-crafted walk_session payload into the generator
 * and asserts the response is structurally sensible.
 *
 *   tsx test/smoke.ts            # network — requires ANTHROPIC_API_KEY
 *   tsx test/smoke.ts --offline  # exercises pricing tool + sink without Claude
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GenerateRequest, Estimate } from "../src/types.js";
import { handlePricingLookup, regionFromZip } from "../src/pricing-tool.js";
import { postEstimate } from "../src/sink.js";
import { loadConfig } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "walk-session-kitchen-counters.json");
const OFFLINE = process.argv.includes("--offline");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("ASSERT FAILED:", msg);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Force the local sink so smoke never pings Rails.
  process.env.ESTIMATE_SINK = "local";

  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const req = GenerateRequest.parse(raw);
  console.log(`[smoke] loaded fixture sessionId=${req.sessionId} offline=${OFFLINE}`);

  // Pricing-tool sanity (offline-friendly).
  assert(regionFromZip(req.zip) === "southeast", `regionFromZip ${req.zip} -> southeast`);
  const lookup = handlePricingLookup({
    trade: "kitchen-countertops",
    zip_code: req.zip,
    query: "labor.fabrication_install_per_sqft",
  });
  assert(
    lookup.ok && typeof lookup.value === "number",
    `pricing_lookup labor.fabrication_install_per_sqft -> ${JSON.stringify(lookup)}`,
  );
  console.log(`[smoke] pricing_lookup OK: ${lookup.query}=${String(lookup.value)} region=${lookup.region}`);

  let estimate;
  if (OFFLINE) {
    estimate = Estimate.parse({
      sessionId: req.sessionId,
      trade: req.trade,
      zip: req.zip,
      summary:
        "Offline synthetic estimate for smoke test. Replace 36 LF of laminate with mid-grade quartz, including tear-out, sink + cooktop cutouts, and 22 LF backsplash.",
      lineItems: [
        {
          sku: "COUNTER-QUARTZMID-EASED",
          description: "Mid-grade quartz slab, eased edge — 75 sqft (36 LF perimeter + island)",
          quantity: 75,
          unit: "sqft",
          unitPrice: 65,
          extended: 4875,
        },
        {
          sku: "LABOR-FAB-INSTALL",
          description: "Fabrication & install labor",
          quantity: 75,
          unit: "sqft",
          unitPrice: 45,
          extended: 3375,
        },
        {
          sku: "TEAROUT-LAMINATE",
          description: "Tear-out and disposal of existing laminate",
          quantity: 75,
          unit: "sqft",
          unitPrice: 8,
          extended: 600,
        },
        {
          sku: "CUTOUT-SINK-UNDERMOUNT",
          description: "Sink cutout (undermount, existing sink reused)",
          quantity: 1,
          unit: "ea",
          unitPrice: 350,
          extended: 350,
        },
        {
          sku: "CUTOUT-COOKTOP",
          description: "Cooktop cutout (existing cooktop reused)",
          quantity: 1,
          unit: "ea",
          unitPrice: 85,
          extended: 85,
        },
        {
          sku: "COUNTER-QUARTZMID-BACKSPLASH",
          description: "4-inch quartz backsplash",
          quantity: 22,
          unit: "lf",
          unitPrice: 45,
          extended: 990,
        },
      ],
      subtotal: 10275,
      total: 10275,
      assumptions: [
        "75 sqft assumed from 36 LF run × 25 inch standard depth (≈2.08 sqft/LF)",
        "Eased edge profile (no upcharge) per homeowner preference",
      ],
      followUps: ["Confirm same-day estimate delivery via email per homeowner request"],
    });
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("[smoke] ANTHROPIC_API_KEY not set — re-run with --offline or export the key");
      process.exit(2);
    }
    const cfg = loadConfig();
    const { generateEstimate } = await import("../src/claude.js");
    estimate = await generateEstimate(cfg, req);
    console.log(`[smoke] Claude returned estimate (${estimate.lineItems.length} line items)`);
  }

  // Shape validation belt-and-suspenders (Estimate.parse already ran, but cross-check).
  const sum = estimate.lineItems.reduce((s, li) => s + li.extended, 0);
  assert(sum === estimate.subtotal, `lineItems extended sum (${sum}) === subtotal (${estimate.subtotal})`);
  assert(estimate.total === estimate.subtotal, `total === subtotal (${estimate.total} vs ${estimate.subtotal})`);
  for (const li of estimate.lineItems) {
    const recomputed = Math.round(li.quantity * li.unitPrice * 100) / 100;
    assert(
      Math.abs(recomputed - li.extended) < 0.01,
      `line ${li.sku}: quantity*unitPrice (${recomputed}) === extended (${li.extended})`,
    );
  }

  const cfg = loadConfig();
  const sinkResult = await postEstimate(cfg, estimate);
  assert(sinkResult.sink === "local", "smoke uses local sink");
  if (sinkResult.sink === "local") {
    assert(existsSync(sinkResult.file), `local sink wrote file ${sinkResult.file}`);
    console.log(`[smoke] sink wrote ${sinkResult.file}`);
  }

  console.log(`[smoke] PASS — total=$${estimate.total} lineItems=${estimate.lineItems.length}`);
}

main().catch((err) => {
  console.error("[smoke] FAIL", err);
  process.exit(1);
});
