import { NextRequest, NextResponse } from "next/server";
import { AccessToken, type VideoGrant } from "livekit-server-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["contractor", "homeowner"] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string | null): value is Role {
  return value !== null && (ROLES as readonly string[]).includes(value);
}

const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

export async function GET(req: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  if (!apiKey || !apiSecret || !wsUrl) {
    return NextResponse.json(
      { error: "livekit_not_configured" },
      { status: 500 },
    );
  }

  const linkSecret = process.env.LIVEKIT_LINK_SECRET;
  if (linkSecret) {
    const provided =
      req.nextUrl.searchParams.get("key") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      "";
    if (provided !== linkSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const room = req.nextUrl.searchParams.get("room");
  const role = req.nextUrl.searchParams.get("role");
  const identityParam = req.nextUrl.searchParams.get("identity");

  if (!room || !ROOM_RE.test(room)) {
    return NextResponse.json({ error: "invalid_room" }, { status: 400 });
  }
  if (!isRole(role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const identity =
    identityParam && /^[A-Za-z0-9._-]{1,64}$/.test(identityParam)
      ? identityParam
      : `${role}-${Math.random().toString(36).slice(2, 8)}`;

  const grant: VideoGrant = {
    room,
    roomJoin: true,
    canSubscribe: true,
    canPublish: role === "contractor",
    canPublishData: true,
  };

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: role === "contractor" ? "Contractor" : "Homeowner",
    ttl: 60 * 60,
    metadata: JSON.stringify({ role }),
  });
  at.addGrant(grant);

  const token = await at.toJwt();

  return NextResponse.json(
    { token, url: wsUrl, identity, role, room },
    { headers: { "cache-control": "no-store" } },
  );
}
