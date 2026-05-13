import jpeg from "jpeg-js";
import { VideoStream, VideoBufferType, type RemoteTrack } from "@livekit/rtc-node";
import type { GeminiSession } from "./gemini.js";

const TARGET_FPS = 1;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const JPEG_QUALITY = 70;

export async function pumpContractorVideo(
  track: RemoteTrack,
  gemini: GeminiSession,
): Promise<void> {
  const stream = new VideoStream(track);
  let lastSentAt = 0;
  let encoding = false;

  for await (const event of stream) {
    const now = Date.now();
    if (now - lastSentAt < FRAME_INTERVAL_MS) continue;
    if (encoding) continue;
    lastSentAt = now;
    encoding = true;

    try {
      const rgba = event.frame.convert(VideoBufferType.RGBA);
      const jpegBytes = encodeJpeg(rgba.data, rgba.width, rgba.height);
      gemini.send({
        realtimeInput: {
          video: {
            mimeType: "image/jpeg",
            data: jpegBytes.toString("base64"),
          },
        },
      });
    } catch (err) {
      console.error("[video] frame encode/send failed", err);
    } finally {
      encoding = false;
    }
  }
}

function encodeJpeg(rgba: Uint8Array, width: number, height: number): Buffer {
  const result = jpeg.encode({ data: rgba, width, height }, JPEG_QUALITY);
  return Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data);
}
