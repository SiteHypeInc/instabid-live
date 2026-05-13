import { z } from "zod";

const Schema = z.object({
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_URL: z.string().url(),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash-native-audio-latest"),
  RAILS_PRICING_API_URL: z.string().url().optional(),
  RAILS_PRICING_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8787),
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
