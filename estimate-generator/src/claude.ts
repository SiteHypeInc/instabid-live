import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { Estimate, type GenerateRequest } from "./types.js";
import {
  pricingToolDefinition,
  handlePricingLookup,
  type PricingLookupInput,
} from "./pricing-tool.js";

const MAX_TOOL_ITERATIONS = 8;

const SYSTEM_PROMPT = `You are InstaBid's senior kitchen-countertop estimator. You just rode along on a video walk of a kitchen with the contractor and homeowner. You have:

- The transcript of the conversation
- A list of observations the on-call AI captured during the walk (material guesses, dimensions, conditions)
- The homeowner's ZIP code (for regional pricing)

You also have a pricing_lookup tool that queries InstaBid's static pricing DB. CALL IT for any standard SKU before pricing a line item. Use freeform reasoned pricing only when the DB has no entry, and call out the assumption in 'assumptions'.

Hard rules:
1. Output a single JSON object matching the schema you'll be given. No prose outside the JSON.
2. Every line item must be defensible from the transcript or observations. If a quantity is a guess, state the assumption in 'assumptions'.
3. Never invent SKUs. Use 'COUNTER-<MATERIAL>-<EDGE>' for stone slabs, 'LABOR-<TASK>' for labor lines, 'TEAROUT-<MATERIAL>' for tear-out, 'CUTOUT-<TYPE>' for cutouts.
4. If the homeowner asked a question that wasn't fully answered on-call, surface it in 'followUps'.
5. Round prices to whole dollars. unit and unitPrice must be USD; extended must equal quantity * unitPrice.
6. Compute subtotal as the sum of extended values, and total as subtotal (no tax/discount line yet).`;

export async function generateEstimate(cfg: Config, req: GenerateRequest): Promise<Estimate> {
  if (!cfg.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  const model = req.hardCase ? cfg.ANTHROPIC_MODEL_HARD : cfg.ANTHROPIC_MODEL_DEFAULT;

  const userPayload = {
    sessionId: req.sessionId,
    trade: req.trade,
    zip: req.zip,
    transcript: req.transcript,
    observations: req.observations,
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Walk-session payload follows. Use pricing_lookup as needed, then return a single JSON object matching the InstaBid Estimate schema in a ```json code fence.\n\n" +
            "```json\n" +
            JSON.stringify(userPayload, null, 2) +
            "\n```",
        },
      ],
    },
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [pricingToolDefinition],
      messages,
    });

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      messages.push({
        role: "user",
        content: toolUses.map((tu) => ({
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: JSON.stringify(handlePricingLookup(tu.input as PricingLookupInput)),
        })),
      });
      continue;
    }

    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    return Estimate.parse(extractJson(text));
  }

  throw new Error(`estimate generation exceeded ${MAX_TOOL_ITERATIONS} tool-use iterations`);
}

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence?.[1]?.trim() ?? text;
  return JSON.parse(raw);
}
