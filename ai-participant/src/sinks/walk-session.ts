// Mocked walk-session sink. Acceptance per TEA-685 says "Posts observations to a
// mocked walk-session sink for now (logs to file or in-mem store)". Real Rails
// walk_session persistence is a separate ticket.
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type Observation = {
  ts: string;
  room: string;
  kind:
    | "tool_call"
    | "tool_result"
    | "agent_speech"
    | "note"
    | "transcript_user"
    | "transcript_ai";
  payload: unknown;
};

const SINK_DIR = resolve(process.cwd(), "tmp", "walk-sessions");
const MEM_RING_MAX = 200;
const memRing: Map<string, Observation[]> = new Map();

async function ensureDir(): Promise<void> {
  if (!existsSync(SINK_DIR)) {
    await mkdir(SINK_DIR, { recursive: true });
  }
}

export async function postObservation(obs: Omit<Observation, "ts">): Promise<void> {
  const full: Observation = { ...obs, ts: new Date().toISOString() };
  await ensureDir();
  const file = join(SINK_DIR, `${obs.room}.jsonl`);
  await appendFile(file, JSON.stringify(full) + "\n", "utf8");
  const ring = memRing.get(obs.room) ?? [];
  ring.push(full);
  if (ring.length > MEM_RING_MAX) ring.shift();
  memRing.set(obs.room, ring);
}

export async function readSession(room: string): Promise<Observation[]> {
  const file = join(SINK_DIR, `${room}.jsonl`);
  if (!existsSync(file)) return [];
  const txt = await readFile(file, "utf8");
  return txt
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Observation);
}

export function recentInMemory(room: string): Observation[] {
  return memRing.get(room) ?? [];
}
