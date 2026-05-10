import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { Estimate } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCAL_SINK_DIR = join(HERE, "..", "local-sink");

export type SinkResult =
  | { sink: "rails"; status: number; ok: boolean; body: string }
  | { sink: "local"; file: string };

function pickSink(cfg: Config): "rails" | "local" {
  if (cfg.ESTIMATE_SINK === "local") return "local";
  if (cfg.ESTIMATE_SINK === "rails") return "rails";
  return cfg.RAILS_API_URL ? "rails" : "local";
}

export async function postEstimate(cfg: Config, estimate: Estimate): Promise<SinkResult> {
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

  const dir = cfg.LOCAL_SINK_DIR ?? DEFAULT_LOCAL_SINK_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${estimate.sessionId}.json`);
  writeFileSync(file, JSON.stringify(estimate, null, 2));
  return { sink: "local", file };
}
