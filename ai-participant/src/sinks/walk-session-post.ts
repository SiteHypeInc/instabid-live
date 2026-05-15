import { readSession, type Observation } from "./walk-session.js";
import type { Config } from "../config.js";

export type RoomMetadata = {
  contractorId?: string;
  homeownerId?: string;
  jobName?: string;
  trade?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
};

type TranscriptTurn = {
  speaker: "contractor" | "ai";
  text: string;
  at?: string;
};

type ReshapedObservation = {
  kind: "material" | "dimension" | "condition" | "fixture" | "note";
  text: string;
  confidence?: number;
};

export type WalkSessionPayload = {
  sessionId: string;
  room: string;
  endedAt: string;
  trade: "kitchen-countertops";
  zip: string;
  contractorId?: string;
  homeownerId?: string;
  jobName?: string;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
  };
  transcript: TranscriptTurn[];
  observations: ReshapedObservation[];
  // The last successful pricing tool_call args + result. estimate-generator
  // can use this as the "chosen" estimate basis without re-running Claude.
  lastPricingCall?: {
    args: Record<string, unknown>;
    result: unknown;
  };
  rawObservations: Observation[];
};

const DEFAULT_ZIP = "00000";

export async function postWalkSession(
  cfg: Config,
  roomName: string,
  meta: RoomMetadata = {},
): Promise<void> {
  const url = cfg.WALK_SESSION_POST_URL;
  const observations = await readSession(roomName);

  const transcript = buildTranscript(observations);
  const reshaped = reshapeObservations(observations);
  const lastPricingCall = findLastPricingCall(observations);
  const zip =
    meta.zip ??
    (typeof lastPricingCall?.args.zip === "string" ? (lastPricingCall.args.zip as string) : undefined) ??
    DEFAULT_ZIP;

  const payload: WalkSessionPayload = {
    sessionId: roomName,
    room: roomName,
    endedAt: new Date().toISOString(),
    trade: "kitchen-countertops",
    zip,
    contractorId: meta.contractorId,
    homeownerId: meta.homeownerId,
    jobName: meta.jobName,
    customer:
      meta.customerName || meta.customerEmail || meta.customerPhone || meta.address
        ? {
            name: meta.customerName,
            email: meta.customerEmail,
            phone: meta.customerPhone,
            address: meta.address,
            city: meta.city,
            state: meta.state,
          }
        : undefined,
    transcript,
    observations: reshaped,
    lastPricingCall,
    rawObservations: observations,
  };

  if (!url) {
    console.log(
      `[walk-session-post] no WALK_SESSION_POST_URL set — skipping POST. room=${roomName} observations=${observations.length} transcript=${transcript.length}`,
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
      `[walk-session-post] POST ok status=${res.status} room=${roomName} observations=${observations.length} transcript=${transcript.length}`,
    );
  } catch (err) {
    console.error(
      `[walk-session-post] POST threw room=${roomName} err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildTranscript(observations: Observation[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const obs of observations) {
    if (obs.kind !== "transcript_user" && obs.kind !== "transcript_ai") continue;
    const text = (obs.payload as { text?: string } | null)?.text;
    if (!text || !text.trim()) continue;
    turns.push({
      speaker: obs.kind === "transcript_user" ? "contractor" : "ai",
      text: text.trim(),
      at: obs.ts,
    });
  }
  return mergeAdjacent(turns);
}

function mergeAdjacent(turns: TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const t of turns) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === t.speaker) {
      prev.text = `${prev.text} ${t.text}`.trim();
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

function reshapeObservations(observations: Observation[]): ReshapedObservation[] {
  const out: ReshapedObservation[] = [];
  for (const obs of observations) {
    if (obs.kind === "tool_call") {
      const args = (obs.payload as { args?: Record<string, unknown> })?.args ?? {};
      const material = typeof args.material === "string" ? args.material : undefined;
      const sqft = typeof args.sqft === "number" ? args.sqft : undefined;
      if (material) out.push({ kind: "material", text: `material=${material}` });
      if (sqft !== undefined) out.push({ kind: "dimension", text: `sqft=${sqft}` });
    }
  }
  return out;
}

function findLastPricingCall(
  observations: Observation[],
): { args: Record<string, unknown>; result: unknown } | undefined {
  let lastCall: Record<string, unknown> | undefined;
  let lastResult: unknown;
  for (const obs of observations) {
    if (obs.kind === "tool_call") {
      const p = obs.payload as { name?: string; args?: Record<string, unknown> };
      if (p?.name === "lookup_countertop_price") {
        lastCall = p.args ?? {};
        lastResult = undefined;
      }
    } else if (obs.kind === "tool_result") {
      const p = obs.payload as { name?: string; result?: unknown };
      if (p?.name === "lookup_countertop_price") {
        lastResult = p.result;
      }
    }
  }
  if (!lastCall) return undefined;
  return { args: lastCall, result: lastResult };
}
