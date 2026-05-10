import WebSocket from "ws";
import type { Config } from "./config.js";

const SYSTEM_PROMPT = `You are InstaBid's senior estimator riding along on a contractor's job walk.

Behavior:
- Watch the video silently. Speak only when something estimator-relevant appears in frame, when asked a direct question, or when the contractor explicitly asks you to.
- Be terse. One or two sentences. No filler.
- For countertops specifically: identify material (granite, quartz, Corian, butcher block, laminate, soapstone, etc.), estimate linear feet, flag edge profile and any visible damage. If asked for price comparisons, call the pricing tool.

You are not a constant narrator. Listen. Speak when it matters.`;

export type GeminiSession = {
  send(json: unknown): void;
  close(): void;
  onMessage(cb: (msg: unknown) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
};

export function connectGeminiLive(cfg: Config): Promise<GeminiSession> {
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${cfg.GEMINI_API_KEY}`;
  const ws = new WebSocket(url);
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const closeHandlers: Array<(code: number, reason: string) => void> = [];

  ws.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    for (const cb of messageHandlers) cb(parsed);
  });
  ws.on("close", (code, reason) => {
    for (const cb of closeHandlers) cb(code, reason.toString());
  });

  return new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${cfg.GEMINI_MODEL}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
              },
            },
            systemInstruction: {
              parts: [{ text: SYSTEM_PROMPT }],
            },
          },
        }),
      );
      resolve({
        send: (json) => ws.send(JSON.stringify(json)),
        close: () => ws.close(1000, "client closed"),
        onMessage: (cb) => messageHandlers.push(cb),
        onClose: (cb) => closeHandlers.push(cb),
      });
    });
  });
}
