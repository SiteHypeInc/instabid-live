import WebSocket from "ws";
import type { Config } from "./config.js";
import { FunctionDeclaration as CountertopPriceFn } from "./tools/countertop-price.js";

const SYSTEM_PROMPT = `You are InstaBid's senior estimator riding along on a contractor's job walk.

Behavior:
- Watch the video silently. Speak only when something estimator-relevant appears in frame, when asked a direct question, or when the contractor explicitly asks you to.
- Be terse. One or two sentences. No filler.
- For countertops specifically: identify material (granite, quartz, Corian, butcher block, laminate, soapstone, etc.), estimate linear feet, flag edge profile and any visible damage. If asked for price comparisons, call the pricing tool.
- NEVER invent numbers. When a price comes up, call lookup_countertop_price and answer with the tool's result. If you don't yet know the ZIP, ask once for it then call the tool.

You are not a constant narrator. Listen. Speak when it matters.`;

export type FunctionCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

export type GeminiSession = {
  send(json: unknown): void;
  sendToolResponse(responses: Array<{ id?: string; name: string; response: unknown }>): void;
  close(): void;
  onMessage(cb: (msg: unknown) => void): void;
  onAudio(cb: (pcm16: Buffer, mimeType: string) => void): void;
  onFunctionCall(cb: (call: FunctionCall) => void | Promise<void>): void;
  onClose(cb: (code: number, reason: string) => void): void;
};

export function connectGeminiLive(cfg: Config): Promise<GeminiSession> {
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${cfg.GEMINI_API_KEY}`;
  const ws = new WebSocket(url);
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const audioHandlers: Array<(pcm16: Buffer, mimeType: string) => void> = [];
  const fnCallHandlers: Array<(call: FunctionCall) => void | Promise<void>> = [];
  const closeHandlers: Array<(code: number, reason: string) => void> = [];

  ws.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    for (const cb of messageHandlers) cb(parsed);
    extractAudio(parsed, audioHandlers);
    extractFunctionCalls(parsed, fnCallHandlers);
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
            tools: [
              {
                functionDeclarations: [CountertopPriceFn],
              },
            ],
          },
        }),
      );
      resolve({
        send: (json) => ws.send(JSON.stringify(json)),
        sendToolResponse: (responses) => {
          ws.send(
            JSON.stringify({
              toolResponse: {
                functionResponses: responses.map((r) => ({
                  ...(r.id ? { id: r.id } : {}),
                  name: r.name,
                  response: r.response,
                })),
              },
            }),
          );
        },
        close: () => ws.close(1000, "client closed"),
        onMessage: (cb) => messageHandlers.push(cb),
        onAudio: (cb) => audioHandlers.push(cb),
        onFunctionCall: (cb) => fnCallHandlers.push(cb),
        onClose: (cb) => closeHandlers.push(cb),
      });
    });
  });
}

type ServerMessage = {
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
      }>;
    };
  };
  toolCall?: {
    functionCalls?: Array<{
      id?: string;
      name?: string;
      args?: Record<string, unknown>;
    }>;
  };
};

function extractAudio(
  msg: unknown,
  handlers: Array<(pcm16: Buffer, mimeType: string) => void>,
): void {
  if (!msg || typeof msg !== "object") return;
  const parts = (msg as ServerMessage).serverContent?.modelTurn?.parts;
  if (!parts) return;
  for (const part of parts) {
    const data = part.inlineData?.data;
    const mimeType = part.inlineData?.mimeType;
    if (!data || !mimeType?.startsWith("audio/")) continue;
    const pcm = Buffer.from(data, "base64");
    for (const cb of handlers) cb(pcm, mimeType);
  }
}

function extractFunctionCalls(
  msg: unknown,
  handlers: Array<(call: FunctionCall) => void | Promise<void>>,
): void {
  if (!msg || typeof msg !== "object") return;
  const calls = (msg as ServerMessage).toolCall?.functionCalls;
  if (!calls?.length) return;
  for (const call of calls) {
    if (!call.name) continue;
    for (const cb of handlers) {
      void Promise.resolve(cb({ id: call.id, name: call.name, args: call.args ?? {} }));
    }
  }
}
