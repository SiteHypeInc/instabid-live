# InstaBid AI Participant

Gemini Live agent that joins a LiveKit room as a bot participant. Subscribes to the contractor's audio (and, in the next pass, video frames), forwards to Gemini Live, and publishes responses back to the room.

## Status

Scaffold only — runnable shell that connects to LiveKit + Gemini Live, but does not yet:
- Forward video frames to Gemini (audio-only first)
- Publish synthesized audio back into the room as a track
- Call the Rails pricing API as a tool

Tracked as TEA-685.

## Run

```bash
cp .env.example .env
# fill in LIVEKIT_* + GEMINI_API_KEY
npm install
npm run dev
```

Spawn an agent into a room:

```bash
curl -X POST http://localhost:8787/spawn \
  -H 'content-type: application/json' \
  -d '{"room":"demo-room"}'
```

Health:

```bash
curl http://localhost:8787/healthz
```

## Wiring (next)

The Next.js app's `/api/livekit/token` route is the trigger surface. When a contractor token is minted, the app should `POST /spawn` to this service so the bot is in the room before the human joins.
