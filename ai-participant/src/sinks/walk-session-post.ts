import { readSession, type Observation } from "./walk-session.js";
import type { Config } from "../config.js";

export type RoomMetadata = {
  contractorId?: string;
  homeownerId?: string;
  jobName?: string;
  trade?: string;
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
