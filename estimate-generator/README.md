# InstaBid Estimate Generator

Post-call worker. Takes a walk-session transcript + observations from the AI Participant and asks Claude to produce an itemized kitchen-countertop estimate. Persists to Rails when configured; otherwise to a local file sink.

Tracked as TEA-686.

## Pieces

- `src/types.ts` — zod schemas for the request and the `Estimate` output
- `src/claude.ts` — Anthropic call. Sonnet 4.6 by default, Opus 4.7 on `hardCase`. Tool-use loop (cap 8 iterations) with the pricing tool.
- `src/pricing-tool.ts` — Anthropic tool `pricing_lookup` that reads `pricing/<trade>-v1.json`. ZIP → region (NE/SE/MW/W) for regional lookups.
- `src/sink.ts` — POSTs to `RAILS_API_URL/api/v1/estimates` when `ESTIMATE_SINK=rails` (or `RAILS_API_URL` is set); otherwise writes to `local-sink/<sessionId>.json`.
- `src/index.ts` — HTTP server. `POST /generate`, `GET /healthz`.

## Pricing DB

`pricing/kitchen-countertops-v1.json` carries materials (quartz / granite / marble / butcher block / laminate), labor (fab + install, tear-out, cutouts, backsplash, edge upgrades), and regional labor multipliers. Claude calls the tool by dotted path, e.g. `materials.quartz_mid.material_per_sqft` or `labor.sink_cutout_undermount`.

## Run

```bash
cp .env.example .env
# fill in ANTHROPIC_API_KEY (required for /generate)
npm install
npm run dev
```

Generate an estimate:

```bash
curl -X POST http://localhost:8788/generate \
  -H 'content-type: application/json' \
  -d '{
    "sessionId": "demo-1",
    "trade": "kitchen-countertops",
    "zip": "30303",
    "transcript": [
      {"speaker": "contractor", "text": "Looking at quartz mid-grade, about 35 linear feet."},
      {"speaker": "homeowner", "text": "Tear-out is included, right?"}
    ],
    "observations": [
      {"kind": "dimension", "text": "~35 LF U-shape perimeter", "confidence": 0.9},
      {"kind": "material", "text": "Mid-grade quartz, white/grey", "confidence": 0.85}
    ]
  }'
```

Response:

```json
{ "estimate": { ... }, "sink": { "sink": "local", "file": "..." } }
```

## Smoke test

```bash
npm run smoke:offline   # exercises pricing tool + sink + schema, no Claude call
npm run smoke           # full path including the Anthropic call (needs ANTHROPIC_API_KEY)
```

## Persistence

| `ESTIMATE_SINK` | `RAILS_API_URL` | Behavior |
|---|---|---|
| (unset) | unset    | local file sink |
| (unset) | set      | POST to Rails |
| `local` | any      | local file sink |
| `rails` | required | POST to Rails (errors if URL missing) |
