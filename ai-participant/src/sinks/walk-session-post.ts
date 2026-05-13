import { readSession, type Observation } from "./walk-session.js";
import type { Config } from "../config.js";

export type RoomMetadata = {
  contractorId?: string;
  contractorApiKey?: string;
  homeownerId?: string;
  jobName?: string;
  trade?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  propertyAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
};

export type WalkSessionPayload = {
  sessionId: string;
  room: string;
  endedAt: string;
  contractorId?: string;
  homeownerId?: string;
  jobName?: string;
  trade?: string;
  observationCount: number;
  observations: Observation[];
};

export async function postWalkSession(
  cfg: Config,
  roomName: string,
  meta: RoomMetadata = {},
): Promise<void> {
  const url = cfg.WALK_SESSION_POST_URL;
  const observations = await readSession(roomName);

  const payload: WalkSessionPayload = {
    sessionId: roomName,
    room: roomName,
    endedAt: new Date().toISOString(),
    contractorId: meta.contractorId,
    homeownerId: meta.homeownerId,
    jobName: meta.jobName,
    trade: meta.trade ?? "kitchen-countertops",
    observationCount: observations.length,
    observations,
  };

  if (!url) {
    console.log(
      `[walk-session-post] no WALK_SESSION_POST_URL set — skipping POST. room=${roomName} observations=${observations.length}`,
    );
    return;
  }

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.WALK_SESSION_POST_KEY) {
      headers.authorization = `Bearer ${cfg.WALK_SESSION_POST_KEY}`;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(
        `[walk-session-post] POST failed status=${res.status} room=${roomName} body=${body.slice(0, 240)}`,
      );
      return;
    }
    console.log(
      `[walk-session-post] POST ok status=${res.status} room=${roomName} observations=${observations.length}`,
    );
  } catch (err) {
    console.error(
      `[walk-session-post] POST threw room=${roomName} err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Pull the latest lookup_countertop_price tool_call's args out of the observation
// stream — that's the AI's last best understanding of what's being estimated.
function latestCountertopArgs(observations: Observation[]):
  | { material: string; sqft: number; zip: string }
  | null {
  for (let i = observations.length - 1; i >= 0; i--) {
    const obs = observations[i];
    if (!obs || obs.kind !== "tool_call") continue;
    const p = obs.payload as { name?: string; args?: Record<string, unknown> };
    if (p.name !== "lookup_countertop_price") continue;
    const a = p.args ?? {};
    const material = typeof a.material === "string" ? a.material : undefined;
    const sqft = typeof a.sqft === "number" ? a.sqft : undefined;
    const zip = typeof a.zip === "string" ? a.zip : undefined;
    if (material && sqft && zip) return { material, sqft, zip };
  }
  return null;
}

// Fire the real /api/estimate (persist + PDF + email). One call per room.
// Pulls trade-specific fields from the last lookup_countertop_price the AI made.
export async function postEstimateForWalk(
  cfg: Config,
  roomName: string,
  meta: RoomMetadata = {},
): Promise<void> {
  const url = cfg.INSTABID_PRICING_URL;
  const apiKey = meta.contractorApiKey || cfg.INSTABID_CONTRACTOR_API_KEY;
  if (!url || !apiKey) {
    console.log(
      `[estimate-post] skipped — INSTABID_PRICING_URL or contractor api_key missing. room=${roomName}`,
    );
    return;
  }

  const observations = await readSession(roomName);
  const counter = latestCountertopArgs(observations);
  if (!counter) {
    console.log(
      `[estimate-post] no countertop tool calls in walk — skipping. room=${roomName}`,
    );
    return;
  }

  const payload = {
    api_key: apiKey,
    trade: "countertops",
    countertopType: counter.material,
    squareFeet: counter.sqft,
    zipCode: meta.zipCode || counter.zip,
    customerName: meta.customerName ?? "Walkthrough Customer",
    customerEmail: meta.customerEmail,
    customerPhone: meta.customerPhone ?? "",
    propertyAddress: meta.propertyAddress ?? "",
    city: meta.city ?? "",
    state: meta.state ?? "",
  };

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(
        `[estimate-post] failed status=${res.status} room=${roomName} body=${body.slice(0, 240)}`,
      );
      return;
    }
    console.log(
      `[estimate-post] ok status=${res.status} room=${roomName} material=${counter.material} sqft=${counter.sqft} zip=${payload.zipCode}`,
    );
  } catch (err) {
    console.error(
      `[estimate-post] threw room=${roomName} err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
