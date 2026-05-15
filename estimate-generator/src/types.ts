import { z } from "zod";

export const TranscriptTurn = z.object({
  speaker: z.enum(["contractor", "homeowner", "ai"]),
  text: z.string(),
  at: z.string().optional(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurn>;

export const Observation = z.object({
  kind: z.enum(["material", "dimension", "condition", "fixture", "note"]),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export type Observation = z.infer<typeof Observation>;

export const Customer = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});
export type Customer = z.infer<typeof Customer>;

export const LastPricingCall = z.object({
  args: z.record(z.unknown()),
  result: z.unknown().optional(),
});
export type LastPricingCall = z.infer<typeof LastPricingCall>;

export const PricingCall = z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
  result: z.unknown().optional(),
});
export type PricingCall = z.infer<typeof PricingCall>;

export const GenerateRequest = z.object({
  sessionId: z.string().min(1),
  trade: z.literal("kitchen-countertops"),
  zip: z.string().regex(/^\d{5}$/),
  transcript: z.array(TranscriptTurn).default([]),
  observations: z.array(Observation).default([]),
  customer: Customer.optional(),
  lastPricingCall: LastPricingCall.optional(),
  pricingCalls: z.array(PricingCall).default([]),
  hardCase: z.boolean().default(false),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;

export const LineItem = z.object({
  sku: z.string(),
  description: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
  unitPrice: z.number().nonnegative(),
  extended: z.number().nonnegative(),
});
export type LineItem = z.infer<typeof LineItem>;

export const Estimate = z.object({
  sessionId: z.string(),
  trade: z.literal("kitchen-countertops"),
  zip: z.string(),
  summary: z.string(),
  lineItems: z.array(LineItem).min(1),
  subtotal: z.number().nonnegative(),
  total: z.number().nonnegative(),
  assumptions: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
});
export type Estimate = z.infer<typeof Estimate>;
