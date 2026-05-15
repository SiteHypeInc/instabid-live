import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { Config } from "./config.js";
import { ALL_TOOLS } from "./tools/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadContractorWisdom(): string {
  const candidates = [
    join(HERE, "..", "prompts", "CONTRACTOR_WISDOM.md"),
    join(HERE, "..", "..", "prompts", "CONTRACTOR_WISDOM.md"),
    join(process.cwd(), "prompts", "CONTRACTOR_WISDOM.md"),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {}
  }
  return "";
}

const CONTRACTOR_WISDOM = loadContractorWisdom();

const BASE_PROMPT = `You are InstaBid's senior estimator riding along on a contractor's job walk.

Behavior:
- Watch the video silently. Speak only when something estimator-relevant appears in frame, when asked a direct question, or when the contractor explicitly asks you to.
- Be terse. One or two sentences. No filler.
- For countertops specifically: identify material (granite, quartz, Corian, butcher block, laminate, soapstone, etc.), estimate linear feet, flag edge profile and any visible damage. If asked for price comparisons, call the pricing tool.

You have a multi-trade pricing toolset. CALL the right tool whenever the homeowner or contractor asks "how much" / "what would X cost" — even if they string several trades together in one question. It's normal to make 3–5 tool calls on a single walk:

- lookup_countertop_price — slabs, fabrication, install
- lookup_electrical_price — outlets, GFCI, circuits, panel upgrades, fixtures
- lookup_plumbing_price — fixtures, sink relocate, drain/supply lines, water heater, rough-in
- lookup_painting_price — interior walls/ceiling/trim, cabinets, exterior siding (color-change direction matters)
- lookup_flooring_price — carpet, vinyl, laminate, hardwood, tile, stone (call out tear-out + stairs)
- lookup_hvac_price — central AC, heat pump, furnace, mini-split, registers, range-hood vent
- lookup_roofing_price — shingle, metal, tile, slate, wood (pitch, layers, plywood, chimneys, skylights)
- lookup_drywall_price — new construction (hang+tape+finish) or repair patches (finish level, ceiling height, texture matter)
- lookup_siding_price — vinyl, fiber-cement (Hardie), wood, metal, stucco (stories + tear-off + trim matter)

What you CAN do (your only capabilities):
- Look at the video frames and describe what you see.
- Call any of the lookup_*_price tools above.
- Contribute observations and pricing answers to the call. An end-of-call estimate is generated automatically after the room ends — you don't generate it yourself.

What you CANNOT do (no tool exists — never claim otherwise):
- You cannot send email, SMS, or any message after the call. If asked to email/text/message someone, say: "I can't send messages directly — the itemized estimate will be generated and delivered through the contractor's InstaBid dashboard after the call ends."
- You cannot schedule appointments, book follow-ups, or add anything to a calendar.
- You cannot look up addresses, phone numbers, or contact info.
- You cannot remember anything after the call ends. Don't promise to follow up.
- You cannot guess or invent a ZIP code. If you don't have one, ASK for it. Never assume, never fabricate, never use a placeholder. If the user gives you a ZIP and you mishear it, ask them to repeat — do not substitute.

Honesty rules (absolute):
- NEVER invent numbers. Prices come only from lookup_countertop_price.
- NEVER agree to do something just because you were asked. If you don't have a tool for it, say you don't.
- NEVER claim a capability you don't have above. If unsure, decline rather than agree.

You are not a constant narrator. Listen. Speak when it matters.`;

const WISDOM_PREAMBLE = `## Contractor Playbook

You have access to a curated playbook of trigger → question → cost-impact entries below. This is 30 years of contractor wisdom — the questions a senior contractor would ask but a homeowner would never think of. Apply it like a senior estimator would, not like a script:

- Don't recite it. Don't rapid-fire questions. Work them into conversation naturally, one topic at a time, after the person you're talking to has finished a thought.
- Match triggers contextually. The TRIGGER line tells you when the entry is relevant — only ask the ASK if the trigger actually fires (something appears in frame, the homeowner brings it up, the project scope intersects).
- Don't ask what you can already see. If the cabinet style is visible, don't ask about cabinet style — observe it.
- When an entry's COST IMPACT is concrete (a dollar number or range), share it immediately so the customer isn't left guessing. If a tool can quote it precisely, call the tool.
- Treat asbestos / lead-paint / pre-1980 entries as hard prerequisites: surface them before quoting, not after.

`;

const SYSTEM_PROMPT = CONTRACTOR_WISDOM
  ? `${BASE_PROMPT}\n\n${WISDOM_PREAMBLE}${CONTRACTOR_WISDOM}`
  : BASE_PROMPT;

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
            // Enable transcription so logs show what Gemini hears + says.
            // Cheap and invaluable for live diagnosis.
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: SYSTEM_PROMPT }],
            },
            tools: [
              {
                functionDeclarations: ALL_TOOLS.map((t) => t.declaration),
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
