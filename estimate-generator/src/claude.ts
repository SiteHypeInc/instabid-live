import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { Estimate, type GenerateRequest } from "./types.js";

const SYSTEM_PROMPT = `You are InstaBid's senior kitchen-countertop estimator. You just rode along on a video walk of a kitchen with the contractor and homeowner. You have:

- The transcript of the conversation
- A list of observations the on-call AI captured during the walk (material guesses, dimensions, conditions)
- The homeowner's ZIP code (for regional pricing)

Produce an itemized estimate.

Hard rules:
1. Output a single JSON object matching the schema you'll be given. No prose outside the JSON.
2. Every line item must be defensible from the transcript or observations. If a quantity is a guess, state the assumption in 'assumptions'.
3. Never invent SKUs. Use the format 'COUNTER-<MATERIAL>-<EDGE>' for stone slabs and 'LABOR-<TASK>' for labor lines until you have real catalog data.
4. If the homeowner asked a question that wasn't fully answered on-call, surface it in 'followUps'.
5. Round prices to whole dollars.`;

export async function generateEstimate(cfg: Config, req: GenerateRequest): Promise<Estimate> {
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const model = req.hardCase ? cfg.ANTHROPIC_MODEL_HARD : cfg.ANTHROPIC_MODEL_DEFAULT;

  const userPayload = {
    sessionId: req.sessionId,
    trade: req.trade,
    zip: req.zip,
    transcript: req.transcript,
    observations: req.observations,
  };

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Walk-session payload follows. Return a single JSON object matching the InstaBid Estimate schema.\n\n" +
              "```json\n" +
              JSON.stringify(userPayload, null, 2) +
              "\n```",
          },
        ],
      },
    ],
  });

  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();

  const json = extractJson(text);
  return Estimate.parse(json);
}

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence?.[1]?.trim() ?? text;
  return JSON.parse(raw);
}
