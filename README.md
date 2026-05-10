# InstaBid Live

LiveKit-powered video walk for the **InstaBid 411 Sailboat POC** ([TEA-682](https://paperclip.app/TEA/issues/TEA-682)).

A contractor opens a link on their phone, the homeowner opens another on theirs, and the two of them walk a kitchen together. An AI participant joins the room, watches the camera feed, fields pricing questions in real time, and produces an itemized estimate after the call.

This repo hosts the **web app** half of that stack. The AI participant lives in [TEA-685 / TEA-688](https://paperclip.app/TEA/issues/TEA-685); the post-call estimate generator lives in [TEA-686 / TEA-689](https://paperclip.app/TEA/issues/TEA-686).

## What this app does

- `/live/<room>/contractor` — joins the LiveKit room with camera + mic publishing.
- `/live/<room>/homeowner` — joins as a viewer (no camera, no mic publish).
- `/api/livekit/token` — server-side token mint. Issues short-lived (1h) JWTs scoped to the room and role, signed with the LiveKit API key/secret. Optional `LIVEKIT_LINK_SECRET` gates issuance behind a shared key.

Anonymous-link auth: any link of the form `/live/<room>/<role>` will mint a token for that room. Production-grade auth (signed link tokens, expiry, single-use) is deferred to a later ticket.

## Stack

- Next.js 14 (App Router) on Node 20
- `@livekit/components-react` + `livekit-client` (client SDK)
- `livekit-server-sdk` (server-side token mint)
- Tailwind CSS for the branded shell
- Deploys to Vercel; target subdomain `live.instabid.pro`

## Local development

```bash
cp .env.example .env.local
# fill in LIVEKIT_API_KEY, LIVEKIT_API_SECRET, NEXT_PUBLIC_LIVEKIT_URL
npm install
npm run dev
```

Then open <http://localhost:3000/live/demo-room/contractor> on one device and <http://localhost:3000/live/demo-room/homeowner> on another. Both join the same LiveKit room.

## Required environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `LIVEKIT_API_KEY` | server | Identifies the project to LiveKit Cloud. |
| `LIVEKIT_API_SECRET` | server | Signs access tokens. **Never** expose to the client. |
| `NEXT_PUBLIC_LIVEKIT_URL` | client + server | WebSocket URL of the project, e.g. `wss://instabid.livekit.cloud`. |
| `LIVEKIT_LINK_SECRET` | server (optional) | If set, `/api/livekit/token` requires `?key=` (or Bearer header) match. Use in prod to keep random visitors from minting tokens. |

Provisioning the LiveKit Cloud project + dropping these into Vercel is owned by the credentials handler — do **not** check secrets into the repo.

## Deploying

1. Create the Vercel project pointing at this repo, framework auto-detect (Next.js).
2. Set env vars above (production + preview).
3. Add custom domain `live.instabid.pro` (CNAME → `cname.vercel-dns.com`).
4. First deploy is automatic on push to `main`.

## What's intentionally out of scope here

- **AI participant** (Gemini Live agent that joins the room) — separate service, separate ticket.
- **Walk session persistence** — Rails (Jesse) owns the schema + endpoints.
- **Recording** — LiveKit Cloud recording config, set per-room when sessions are real.
- **Estimate generation** — post-call worker, separate repo/service.

## Branch policy

- `main` is protected. Open PRs from `feat/<thing>` branches.
- Every PR runs typecheck + build in CI (added in a follow-up).
- Sandbox/feature deploys go to Vercel preview URLs automatically.

## Provenance

Built by Todd (Team Platypus AI agent) under [TEA-684](https://paperclip.app/TEA/issues/TEA-684), in service of [TEA-682](https://paperclip.app/TEA/issues/TEA-682) — the InstaBid 411 Sailboat POC.
