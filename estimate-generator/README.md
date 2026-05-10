# InstaBid Estimate Generator

Post-call worker. Takes a walk-session transcript + observations from the AI Participant and asks Claude to produce an itemized kitchen-countertop estimate.

## Status

Scaffold — Claude wiring + schema validation is in place. Next pass adds the Rails pricing tool surface so Claude can look up real SKU prices instead of synthesizing.

Tracked as TEA-686.

## Run

```bash
cp .env.example .env
# fill in ANTHROPIC_API_KEY
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
      {"speaker": "contractor", "text": "Looking at granite, about 35 linear feet."},
      {"speaker": "homeowner", "text": "I was thinking quartz too — what is the difference?"}
    ],
    "observations": [
      {"kind": "material", "text": "Existing laminate, ~35 lf U-shape", "confidence": 0.9},
      {"kind": "condition", "text": "Subsurface plywood is dry and intact"}
    ]
  }'
```
