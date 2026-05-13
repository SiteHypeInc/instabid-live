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
import { postWalkSession, type RoomMetadata } from "./sinks/walk-session-post.js";
import { pumpContractorVideo } from "./video.js";

export type RunningAgent = {
  room: string;
  shutdown(): Promise<void>;
};

// Gemini Live emits PCM16; native-audio models advertise the rate in the
// mimeType (e.g. audio/pcm;rate=24000). AudioSource queue keeps a short
// buffer so we don't underrun while bytes are still in flight.
const AGENT_SAMPLE_RATE = 24_000;
const AGENT_CHANNELS = 1;
const AGENT_AUDIO_QUEUE_MS = 200;

export async function joinAsAgent(cfg: Config, roomName: string): Promise<RunningAgent> {
  const token = await mintBotToken(cfg, roomName);
  const room = new Room();
  await room.connect(cfg.LIVEKIT_URL, token, { autoSubscribe: true, dynacast: true });
  console.log(`[agent] joined room=${roomName} as ${room.localParticipant?.identity}`);

  const roomMeta = parseRoomMetadata(room.metadata);
  if (roomMeta.contractorId || roomMeta.jobName) {
    console.log(
      `[agent] room metadata contractorId=${roomMeta.contractorId ?? "-"} job=${roomMeta.jobName ?? "-"} trade=${roomMeta.trade ?? "-"}`,
    );
  }

  const audioSource = new AudioSource(AGENT_SAMPLE_RATE, AGENT_CHANNELS, AGENT_AUDIO_QUEUE_MS);
  const localTrack = LocalAudioTrack.createAudioTrack("ai-voice", audioSource);
  const publishOpts = new TrackPublishOptions();
  publishOpts.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(localTrack, publishOpts);
  console.log(`[agent] published ai-voice track`);

  const gemini: GeminiSession = await connectGeminiLive(cfg);
  console.log("[agent] gemini live session open");

  let audioChain: Promise<void> = Promise.resolve();
  let firstAudioLogged = false;
  gemini.onAudio((pcm16, mimeType) => {
    const rate = parseSampleRate(mimeType) ?? AGENT_SAMPLE_RATE;
    if (!firstAudioLogged) {
      console.log(`[agent] first gemini audio mimeType=${mimeType} rate=${rate} bytes=${pcm16.length}`);
      firstAudioLogged = true;
    }
    audioChain = audioChain.then(() => publishAgentAudio(audioSource, pcm16, rate));
  });
  gemini.onFunctionCall(async (call) => {
    await handleFunctionCall(cfg, roomName, gemini, call);
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
      void pumpContractorVideo(track, gemini);
    }
  });

  let walkSessionPosted = false;
  const fireWalkSessionPost = async (cause: string): Promise<void> => {
    if (walkSessionPosted) return;
    walkSessionPosted = true;
    console.log(`[agent] firing walk-session post cause=${cause} room=${roomName}`);
    await postWalkSession(cfg, roomName, roomMeta);
  };

  room.on(RoomEvent.Disconnected, () => {
    console.log(`[agent] room disconnected; firing walk-session post then closing gemini`);
    void fireWalkSessionPost("room_disconnected").finally(() => gemini.close());
  });

  return {
    room: roomName,
    async shutdown() {
      await fireWalkSessionPost("shutdown");
      gemini.close();
      await audioSource.close().catch(() => undefined);
      await localTrack.close().catch(() => undefined);
      await room.disconnect();
    },
  };
}

function parseRoomMetadata(metadata: string | undefined): RoomMetadata {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const pick = (k: string): string | undefined =>
      typeof parsed[k] === "string" ? (parsed[k] as string) : undefined;
    return {
      contractorId: pick("contractorId") ?? pick("contractor_id"),
      homeownerId: pick("homeownerId") ?? pick("homeowner_id"),
      jobName: pick("jobName") ?? pick("job_name"),
      trade: pick("trade"),
    };
  } catch {
    return {};
  }
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
  let firstFrameLogged = false;
  for await (const frame of stream) {
    const pcm16 = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    if (!firstFrameLogged) {
      console.log(
        `[agent] first contractor audio frame rate=${frame.sampleRate} channels=${frame.channels} bytes=${pcm16.length}`,
      );
      firstFrameLogged = true;
    }
    gemini.send({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${frame.sampleRate}`,
          data: pcm16.toString("base64"),
        },
      },
    });
  }
  console.log("[agent] contractor audio stream ended");
}

async function publishAgentAudio(
  source: AudioSource,
  pcm16: Buffer,
  sampleRate: number,
): Promise<void> {
  const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.byteLength / 2));
  const frame = new AudioFrame(samples, sampleRate, AGENT_CHANNELS, samples.length);
  try {
    await source.captureFrame(frame);
  } catch (err) {
    console.error("[agent] captureFrame failed", err);
  }
}

function parseSampleRate(mimeType: string | undefined): number | undefined {
  if (!mimeType) return undefined;
  const match = mimeType.match(/rate=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function handleFunctionCall(
  cfg: Config,
  roomName: string,
  gemini: GeminiSession,
  call: FunctionCall,
): Promise<void> {
  console.log(`[agent] tool call ${call.name} args=${JSON.stringify(call.args)}`);
  await postObservation({ room: roomName, kind: "tool_call", payload: call });

  let result: unknown;
  try {
    if (call.name === "lookup_countertop_price") {
      result = await lookupCountertopPrice(call.args, {
        url: cfg.INSTABID_PRICING_URL,
        key: cfg.INSTABID_PRICING_KEY,
      });
    } else {
      result = { error: `unknown tool: ${call.name}` };
    }
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }

  await postObservation({ room: roomName, kind: "tool_result", payload: { name: call.name, result } });
  gemini.sendToolResponse([{ id: call.id, name: call.name, response: { result } }]);
}
