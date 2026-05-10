"use client";

import { useEffect, useState } from "react";
import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";

type Role = "contractor" | "homeowner";

type TokenResponse = {
  token: string;
  url: string;
  identity: string;
  role: Role;
  room: string;
};

type LiveRoomProps = {
  room: string;
  role: Role;
};

export function LiveRoom({ room, role }: LiveRoomProps) {
  const [data, setData] = useState<TokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ room, role });
    fetch(`/api/livekit/token?${params.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `token_${res.status}`);
        }
        return res.json() as Promise<TokenResponse>;
      })
      .then((tok) => {
        if (!cancelled) setData(tok);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [room, role]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-lg font-medium text-white">Couldn&apos;t join the room.</p>
        <p className="text-sm text-white/60">{describeError(error)}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <p className="text-sm text-white/60">Connecting…</p>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={data.token}
      serverUrl={data.url}
      connect
      video={role === "contractor"}
      audio={role === "contractor"}
      data-lk-theme="default"
      style={{ height: "100dvh" }}
    >
      <RoomLayout role={role} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function RoomLayout({ role }: { role: Role }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line bg-slab/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-bid shadow-[0_0_8px_2px_rgba(255,106,26,0.7)]" />
          <span className="text-sm font-semibold tracking-wide">InstaBid Live</span>
        </div>
        <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-widest text-white/60">
          {role}
        </span>
      </header>

      <main className="relative flex-1 overflow-hidden">
        <GridLayout tracks={tracks}>
          <ParticipantTile />
        </GridLayout>
      </main>

      {role === "contractor" ? (
        <ControlBar
          variation="minimal"
          controls={{ microphone: true, camera: true, screenShare: false, leave: true }}
        />
      ) : (
        <div className="border-t border-line bg-slab/60 px-4 py-3 text-center text-xs text-white/60">
          Watching live. Talk to the contractor — the AI is listening.
        </div>
      )}
    </div>
  );
}

function describeError(code: string) {
  switch (code) {
    case "livekit_not_configured":
      return "The server is missing LiveKit credentials. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, NEXT_PUBLIC_LIVEKIT_URL.";
    case "invalid_room":
      return "That room id isn't valid.";
    case "invalid_role":
      return "That role isn't valid.";
    case "unauthorized":
      return "This link has expired or is missing its key.";
    default:
      return `Something went wrong (${code}). Try refreshing.`;
  }
}
