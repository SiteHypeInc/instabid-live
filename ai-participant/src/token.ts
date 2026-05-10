import { AccessToken } from "livekit-server-sdk";
import type { Config } from "./config.js";

export async function mintBotToken(cfg: Config, room: string): Promise<string> {
  const at = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, {
    identity: `instabid-ai-${room}`,
    name: "InstaBid AI",
    metadata: JSON.stringify({ role: "ai" }),
    ttl: 60 * 60,
  });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    hidden: false,
  });
  return at.toJwt();
}
