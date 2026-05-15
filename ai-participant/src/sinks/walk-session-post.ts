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

export type PricingCall = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
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
  // Every pricing call the AI made on the call, in order. Multi-trade walks
  // produce one entry per tool invocation — estimate-generator turns each
  // into its own line/estimate downstream.
  pricingCalls: PricingCall[];
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
  const pricingCalls = collectPricingCalls(observations);
  const lastPricingCall = pricingCalls[pricingCalls.length - 1];
  const zip =
    meta.zip ??
    (typeof lastPricingCall?.args.zip === "string" ? (lastPricingCall.args.zip as string) : undefined) ??
    (typeof lastPricingCall?.args.zipCode === "string" ? (lastPricingCall.args.zipCode as string) : undefined) ??
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
    pricingCalls,
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
    if (obs.kind !== "tool_call") continue;
    const p = obs.payload as { name?: string; args?: Record<string, unknown> };
    const args = p?.args ?? {};
    const tool = p?.name ?? "";
    const tradeTag = tool.replace(/^lookup_/, "").replace(/_price$/, "");
    const tag = tradeTag ? `[${tradeTag}] ` : "";
    const pickStr = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const pickNum = (k: string): number | undefined => (typeof args[k] === "number" ? (args[k] as number) : undefined);
    const material = pickStr("material") ?? pickStr("flooringType");
    const surface = pickStr("surface");
    const scope = pickStr("scope");
    const systemType = pickStr("systemType");
    if (material) out.push({ kind: "material", text: `${tag}material=${material}` });
    if (surface) out.push({ kind: "fixture", text: `${tag}surface=${surface}` });
    if (scope) out.push({ kind: "fixture", text: `${tag}scope=${scope}` });
    if (systemType) out.push({ kind: "fixture", text: `${tag}systemType=${systemType}` });
    const sqft = pickNum("sqft") ?? pickNum("squareFeet") ?? pickNum("paintArea");
    const lf = pickNum("linearFeet");
    const count = pickNum("count") ?? pickNum("units") ?? pickNum("fixtures");
    if (sqft !== undefined) out.push({ kind: "dimension", text: `${tag}sqft=${sqft}` });
    if (lf !== undefined) out.push({ kind: "dimension", text: `${tag}linearFeet=${lf}` });
    if (count !== undefined) out.push({ kind: "dimension", text: `${tag}count=${count}` });
  }
  return out;
}

// Walk through observations in order and pair each pricing tool_call with
// its matching tool_result by tool name + position. Returns one PricingCall
// per invocation across all trades, oldest first.
function collectPricingCalls(observations: Observation[]): PricingCall[] {
  const out: PricingCall[] = [];
  for (const obs of observations) {
    if (obs.kind === "tool_call") {
      const p = obs.payload as { name?: string; args?: Record<string, unknown> };
      if (!p?.name?.startsWith("lookup_")) continue;
      out.push({ tool: p.name, args: p.args ?? {}, result: undefined });
    } else if (obs.kind === "tool_result") {
      const p = obs.payload as { name?: string; result?: unknown };
      if (!p?.name?.startsWith("lookup_")) continue;
      // Pair with the most recent unresolved call of the same tool name.
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const candidate = out[i];
        if (candidate && candidate.tool === p.name && candidate.result === undefined) {
          candidate.result = p.result;
          break;
        }
      }
    }
  }
  return out;
}
