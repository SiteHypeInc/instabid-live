import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { generateEstimate } from "./claude.js";
import { GenerateRequest } from "./types.js";

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
      const estimate = await generateEstimate(cfg, parsed.data);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(estimate));
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
