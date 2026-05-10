import { z } from "zod";

const Schema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL_DEFAULT: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MODEL_HARD: z.string().default("claude-opus-4-7"),
  RAILS_API_URL: z.string().url().optional(),
  RAILS_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8788),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(): Config {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    const missing = Object.entries(flat)
      .map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`)
      .join("; ");
    throw new Error(`Invalid env: ${missing}`);
  }
  return parsed.data;
}
