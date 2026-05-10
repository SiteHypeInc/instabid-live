import {
  Room,
  RoomEvent,
  RemoteTrack,
  RemoteParticipant,
  TrackKind,
  AudioStream,
} from "@livekit/rtc-node";
import type { Config } from "./config.js";
import { mintBotToken } from "./token.js";
import { connectGeminiLive, type GeminiSession } from "./gemini.js";

export type RunningAgent = {
  room: string;
  shutdown(): Promise<void>;
};

export async function joinAsAgent(cfg: Config, roomName: string): Promise<RunningAgent> {
  const token = await mintBotToken(cfg, roomName);
  const room = new Room();
  await room.connect(cfg.LIVEKIT_URL, token, { autoSubscribe: true, dynacast: true });

  console.log(`[agent] joined room=${roomName} as ${room.localParticipant?.identity}`);

  const gemini: GeminiSession = await connectGeminiLive(cfg);
  console.log("[agent] gemini live session open");

  gemini.onMessage((msg) => {
    // TODO(TEA-685.next): unpack server audio chunks and publish to LiveKit
    // as a synthesized audio track. For now we log the response shape.
    if (process.env.LOG_GEMINI === "1") {
      console.log("[gemini]", JSON.stringify(msg).slice(0, 200));
    }
  });
  gemini.onClose((code, reason) => {
    console.warn(`[gemini] closed code=${code} reason=${reason}`);
  });

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
    const role = parseRole(participant.metadata);
    if (role !== "contractor") {
      console.log(`[agent] ignoring non-contractor track from ${participant.identity} (role=${role})`);
      return;
    }
    if (track.kind === TrackKind.KIND_AUDIO) {
      console.log(`[agent] subscribed audio from contractor ${participant.identity}`);
      pumpContractorAudio(track, gemini);
    } else if (track.kind === TrackKind.KIND_VIDEO) {
      console.log(`[agent] subscribed video from contractor ${participant.identity}`);
      // TODO(TEA-685.next): downsample to 1fps JPEGs and forward as inlineData.
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log(`[agent] room disconnected; closing gemini session`);
    gemini.close();
  });

  return {
    room: roomName,
    async shutdown() {
      gemini.close();
      await room.disconnect();
    },
  };
}

function parseRole(metadata: string | undefined): string | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata) as { role?: unknown };
    return typeof parsed.role === "string" ? parsed.role : undefined;
  } catch {
    return undefined;
  }
}

async function pumpContractorAudio(track: RemoteTrack, gemini: GeminiSession): Promise<void> {
  const stream = new AudioStream(track);
  for await (const frame of stream) {
    const pcm16 = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    gemini.send({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: `audio/pcm;rate=${frame.sampleRate}`,
            data: pcm16.toString("base64"),
          },
        ],
      },
    });
  }
}
