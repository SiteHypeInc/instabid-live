import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { joinAsAgent, type RunningAgent } from "./agent.js";
import { readSession } from "./sinks/walk-session.js";

const cfg = loadConfig();
const agents = new Map<string, RunningAgent>();

const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, agents: [...agents.keys()] }));
    return;
  }

  if (req.method === "GET" && req.url === "/debug/lk") {
    const target = cfg.LIVEKIT_URL.replace(/^wss:/, "https:").replace(/\/$/, "") + "/settings/regions";
    try {
      const r = await fetch(target);
      const body = await r.text();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ target, status: r.status, bodyHead: body.slice(0, 200) }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ target, error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/sessions/")) {
    const room = decodeURIComponent(req.url.slice("/sessions/".length));
    if (!ROOM_RE.test(room)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_room" }));
      return;
    }
    const observations = await readSession(room);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ room, observations }));
    return;
  }

  if (req.method === "POST" && req.url === "/spawn") {
    const body = await readJson(req);
    const room = typeof body?.room === "string" ? body.room : "";
    if (!ROOM_RE.test(room)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_room" }));
      return;
    }
    if (agents.has(room)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "already_running", room }));
      return;
    }
    const metaOverride =
      body?.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : undefined;
    try {
      const agent = await joinAsAgent(cfg, room, metaOverride);
      agents.set(room, agent);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "spawned", room }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "spawn_failed";
      console.error("[spawn]", message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "spawn_failed", message }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(cfg.PORT, () => {
  console.log(`[ai-participant] listening on :${cfg.PORT}`);
});

async function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const shutdown = async (signal: string) => {
  console.log(`[ai-participant] received ${signal}, shutting down ${agents.size} agent(s)`);
  await Promise.all([...agents.values()].map((a) => a.shutdown().catch(() => undefined)));
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
