import {
  Room,
  RoomEvent,
  RemoteTrack,
  RemoteParticipant,
  TrackKind,
  AudioStream,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import type { Config } from "./config.js";
import { mintBotToken } from "./token.js";
import { connectGeminiLive, type GeminiSession, type FunctionCall } from "./gemini.js";
import { lookupCountertopPrice } from "./tools/countertop-price.js";
import { postObservation } from "./sinks/walk-session.js";

export type RunningAgent = {
  room: string;
  shutdown(): Promise<void>;
};

// Gemini Live emits 24kHz mono PCM16 by default. AudioSource queue keeps a
// short buffer so we don't underrun while bytes are still in flight.
const AGENT_SAMPLE_RATE = 24_000;
const AGENT_CHANNELS = 1;
const AGENT_AUDIO_QUEUE_MS = 200;

export async function joinAsAgent(cfg: Config, roomName: string): Promise<RunningAgent> {
  const token = await mintBotToken(cfg, roomName);
  const room = new Room();
  await room.connect(cfg.LIVEKIT_URL, token, { autoSubscribe: true, dynacast: true });
  console.log(`[agent] joined room=${roomName} as ${room.localParticipant?.identity}`);

  const audioSource = new AudioSource(AGENT_SAMPLE_RATE, AGENT_CHANNELS, AGENT_AUDIO_QUEUE_MS);
  const localTrack = LocalAudioTrack.createAudioTrack("ai-voice", audioSource);
  const publishOpts = new TrackPublishOptions();
  publishOpts.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(localTrack, publishOpts);
  console.log(`[agent] published ai-voice track`);

  const gemini: GeminiSession = await connectGeminiLive(cfg);
  console.log("[agent] gemini live session open");

  gemini.onAudio((pcm16) => {
    void publishAgentAudio(audioSource, pcm16);
  });
  gemini.onFunctionCall(async (call) => {
    await handleFunctionCall(roomName, gemini, call);
  });
  gemini.onClose((code, reason) => {
    console.warn(`[gemini] closed code=${code} reason=${reason}`);
  });
  if (process.env.LOG_GEMINI === "1") {
    gemini.onMessage((msg) => console.log("[gemini]", JSON.stringify(msg).slice(0, 240)));
  }

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
    const role = parseRole(participant.metadata);
    if (role !== "contractor") {
      console.log(`[agent] ignoring non-contractor track from ${participant.identity} (role=${role})`);
      return;
    }
    if (track.kind === TrackKind.KIND_AUDIO) {
      console.log(`[agent] subscribed audio from contractor ${participant.identity}`);
      void pumpContractorAudio(track, gemini);
    } else if (track.kind === TrackKind.KIND_VIDEO) {
      console.log(`[agent] subscribed video from contractor ${participant.identity}`);
      // TODO(TEA-685.video): downsample to 1fps JPEGs and forward as inlineData mediaChunks.
      // Deferred — needs a JPEG encoder dependency (sharp ~30MB native). Tool-call path
      // (price quote) works without video.
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
      await audioSource.close().catch(() => undefined);
      await localTrack.close().catch(() => undefined);
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

async function publishAgentAudio(source: AudioSource, pcm16: Buffer): Promise<void> {
  // Gemini Live audio is little-endian PCM16. Wrap the bytes as Int16 without
  // copying — alignment is already guaranteed by Buffer.from(base64) on a fresh
  // allocation.
  const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.byteLength / 2));
  const frame = new AudioFrame(samples, AGENT_SAMPLE_RATE, AGENT_CHANNELS, samples.length);
  try {
    await source.captureFrame(frame);
  } catch (err) {
    console.error("[agent] captureFrame failed", err);
  }
}

async function handleFunctionCall(
  roomName: string,
  gemini: GeminiSession,
  call: FunctionCall,
): Promise<void> {
  console.log(`[agent] tool call ${call.name} args=${JSON.stringify(call.args)}`);
  await postObservation({ room: roomName, kind: "tool_call", payload: call });

  let result: unknown;
  try {
    if (call.name === "lookup_countertop_price") {
      result = lookupCountertopPrice(call.args);
    } else {
      result = { error: `unknown tool: ${call.name}` };
    }
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }

  await postObservation({ room: roomName, kind: "tool_result", payload: { name: call.name, result } });
  gemini.sendToolResponse([{ id: call.id, name: call.name, response: { result } }]);
}
