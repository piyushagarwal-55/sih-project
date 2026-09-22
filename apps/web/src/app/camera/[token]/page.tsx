"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { JoinInfo } from "@divya/contracts";

import { api } from "@/lib/api";
import { fmtKbps, guessDeviceName } from "@/lib/format";
import {
  canLockOrientation,
  currentOrientation,
  lockOrientation,
  releaseOrientation,
  type Orientation,
} from "@/lib/orientation";
import { CameraPublisher, type PublisherPhase, type PublisherStats } from "@/lib/publisher";

const NAME_KEY = "divya.deviceName";

interface Options {
  source: "camera" | "test";
  autostart: boolean;
  codec: "h264" | "vp8";
}

function readOptions(): Options {
  const q = new URLSearchParams(window.location.search);
  return {
    source: q.get("source") === "test" ? "test" : "camera",
    autostart: q.get("autostart") === "1",
    codec: q.get("codec") === "vp8" ? "vp8" : "h264",
  };
}

export default function CameraPage() {
  const { token } = useParams<{ token: string }>();
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PublisherPhase>("idle");
  const [detail, setDetail] = useState<string | undefined>();
  const [stats, setStats] = useState<PublisherStats | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [mirrored, setMirrored] = useState(false);
  const [orient, setOrient] = useState<Orientation>("landscape");
  const [canLock, setCanLock] = useState(false);
  const [portraitNow, setPortraitNow] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const publisherRef = useRef<CameraPublisher | null>(null);
  const autostarted = useRef(false);

  // Follow screen rotation: re-ask the camera for 720p in the new orientation.
  useEffect(() => {
    setCanLock(canLockOrientation());
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = () => {
      setPortraitNow(currentOrientation() === "portrait");
      void publisherRef.current?.onOrientationChange();
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const opts = readOptions();
    setOptions(opts);
    let stored = "";
    try {
      stored = localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      /* storage blocked */
    }
    setDeviceName(stored || (opts.source === "test" ? "Test pattern" : guessDeviceName()));
    api.joinInfo(token).then(setJoin, (err: Error) => setLoadError(err.message));
  }, [token]);

  const start = useCallback(async () => {
    if (!join || !options) return;
    // First, while we still hold the tap's user gesture: fullscreen + landscape,
    // so the camera opens in landscape (1280x720) rather than portrait.
    if (options.source === "camera") await lockOrientation(orient);
    const name = deviceName.trim() || "Phone";
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* storage blocked */
    }
    await publisherRef.current?.stop();
    const pub = new CameraPublisher({
      token,
      deviceName: name,
      iceServers: join.ice_servers,
      source: options.source,
      preferCodec: options.codec,
      onPhase: (p, d) => {
        setPhase(p);
        setDetail(d);
      },
      onStats: setStats,
      onStream: (stream) => {
        const v = videoRef.current;
        if (v && v.srcObject !== stream) {
          v.srcObject = stream;
          void v.play().catch(() => undefined);
        }
        const facing = stream.getVideoTracks()[0]?.getSettings().facingMode;
        setMirrored(facing === "user");
      },
    });
    publisherRef.current = pub;
    try {
      await pub.start("environment");
    } catch {
      /* onPhase already reported it */
    }
  }, [join, options, deviceName, token, orient]);

  const stop = useCallback(async () => {
    await publisherRef.current?.stop();
    await releaseOrientation();
  }, []);

  const toggleOrientation = useCallback(async () => {
    const next: Orientation = orient === "landscape" ? "portrait" : "landscape";
    if (await lockOrientation(next)) setOrient(next);
  }, [orient]);

  useEffect(() => {
    if (join && options?.autostart && !autostarted.current) {
      autostarted.current = true;
      void start();
    }
  }, [join, options, start]);

  useEffect(
    () => () => {
      void publisherRef.current?.stop();
      void releaseOrientation();
    },
    [],
  );

  const streaming = phase === "live" || phase === "connecting" || phase === "reconnecting" || phase === "starting";

  if (loadError) {
    return (
      <Shell>
        <Card tone="error" title="This link is no longer valid">
          <p>{loadError}</p>
          <p className="mt-3 text-ink-400">On the laptop, click Connect Mobile to get a new QR code.</p>
        </Card>
      </Shell>
    );
  }

  if (!join || !options) {
    return (
      <Shell>
        <div className="grid flex-1 place-items-center">
          <div className="size-9 animate-spin rounded-full border-2 border-ink-600 border-t-saffron-500" />
        </div>
      </Shell>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-ink-100">
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${streaming ? "opacity-100" : "opacity-0"} ${mirrored ? "-scale-x-100" : ""}`}
      />

      {/* top bar */}
      <div className="relative z-10 flex items-center justify-between gap-3 bg-gradient-to-b from-black/80 to-transparent px-4 pb-8 pt-[max(env(safe-area-inset-top),14px)]">
        <div className="flex items-center gap-2">
          <span className="rounded bg-saffron-500 px-2 py-0.5 font-mono text-sm font-bold text-white">{join.camera_id}</span>
          <span className="text-sm font-medium text-white/90">Divya Drishti</span>
        </div>
        <PhaseBadge phase={phase} />
      </div>

      <div className="relative z-10 flex-1" />

      {!streaming && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-5">
          <div className="w-full max-w-sm rounded-2xl bg-ink-900/95 p-6 shadow-2xl ring-1 ring-ink-700 backdrop-blur">
            {phase === "error" ? (
              <>
                <h1 className="text-lg font-semibold text-red-200">Could not start</h1>
                <p className="mt-2 text-sm leading-relaxed text-ink-300">{detail}</p>
              </>
            ) : phase === "stopped" ? (
              <>
                <h1 className="text-lg font-semibold">Camera stopped</h1>
                <p className="mt-2 text-sm text-ink-400">The laptop shows {join.camera_id} as offline.</p>
              </>
            ) : (
              <>
                <p className="font-mono text-xs uppercase tracking-widest text-saffron-400">Camera node</p>
                <h1 className="mt-1 text-2xl font-bold">You are {join.camera_id}</h1>
                <p className="mt-2 text-sm leading-relaxed text-ink-400">
                  This phone will stream its {options.source === "test" ? "test pattern" : "rear camera"} live to the
                  command centre in {canLock ? "landscape" : "the orientation you hold it"}. Keep the screen on and the
                  phone charging.
                </p>
              </>
            )}

            <label className="mt-5 block">
              <span className="text-xs font-medium text-ink-400">Name shown on the dashboard</span>
              <input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value.slice(0, 40))}
                className="mt-1 w-full rounded-lg bg-ink-950 px-3 py-2.5 text-sm ring-1 ring-ink-600 outline-none focus:ring-saffron-500"
              />
            </label>

            <button
              type="button"
              onClick={() => void start()}
              className="mt-4 w-full rounded-xl bg-saffron-500 py-3.5 text-base font-semibold text-white shadow-lg shadow-saffron-500/25 active:scale-[0.99]"
            >
              {phase === "error" || phase === "stopped" ? "Start again" : "Start camera"}
            </button>
            <p className="mt-3 text-center text-[11px] text-ink-400">Your browser will ask for camera permission.</p>
          </div>
        </div>
      )}

      {streaming && (
        <div className="relative z-10 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-4 pb-[max(env(safe-area-inset-bottom),16px)] pt-10">
          {!canLock && portraitNow && options.source === "camera" && phase === "live" && (
            <p className="mb-3 rounded-lg bg-saffron-500/90 px-3 py-2 text-center text-sm font-medium text-white">
              Turn the phone sideways for a landscape feed. If the picture stays upright, switch off rotation lock.
            </p>
          )}
          {(phase === "reconnecting" || phase === "connecting" || phase === "starting") && (
            <p className="mb-3 rounded-lg bg-ink-900/80 px-3 py-2 text-center text-sm text-ink-100 ring-1 ring-ink-600">
              {phase === "starting"
                ? "Opening the camera..."
                : phase === "connecting"
                  ? "Connecting to the laptop..."
                  : (detail ?? "Reconnecting...")}
            </p>
          )}
          <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono text-xs text-white/80">
            <span>{stats?.width && stats.height ? `${stats.width}×${stats.height}` : "--"}</span>
            <span className="text-white/35">|</span>
            <span>{stats?.fps ?? 0} fps</span>
            <span className="text-white/35">|</span>
            <span>{fmtKbps(stats?.bitrateKbps ?? 0)}</span>
            {stats?.codec && (
              <>
                <span className="text-white/35">|</span>
                <span>{stats.codec}</span>
              </>
            )}
          </div>
          <div className="flex gap-3">
            {options.source === "camera" && (
              <button
                type="button"
                onClick={() => void publisherRef.current?.switchCamera().catch(() => undefined)}
                className="flex-1 rounded-xl bg-white/12 py-3 text-sm font-semibold text-white ring-1 ring-white/20 backdrop-blur active:bg-white/20"
              >
                Flip camera
              </button>
            )}
            {options.source === "camera" && canLock && (
              <button
                type="button"
                onClick={() => void toggleOrientation()}
                className="flex-1 rounded-xl bg-white/12 py-3 text-sm font-semibold text-white ring-1 ring-white/20 backdrop-blur active:bg-white/20"
              >
                {orient === "landscape" ? "Portrait" : "Landscape"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void stop()}
              className="flex-1 rounded-xl bg-live/85 py-3 text-sm font-semibold text-white active:bg-live"
            >
              Stop
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: PublisherPhase }) {
  const cfg: Record<PublisherPhase, { label: string; cls: string }> = {
    idle: { label: "Ready", cls: "bg-ink-800 text-ink-300" },
    starting: { label: "Starting", cls: "bg-warn/20 text-amber-200" },
    connecting: { label: "Connecting", cls: "bg-warn/20 text-amber-200" },
    live: { label: "Live", cls: "bg-live text-white" },
    reconnecting: { label: "Reconnecting", cls: "bg-warn/25 text-amber-100" },
    stopped: { label: "Stopped", cls: "bg-ink-800 text-ink-300" },
    error: { label: "Error", cls: "bg-live/20 text-red-200" },
  };
  const c = cfg[phase];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${c.cls}`}>
      {phase === "live" && <span className="size-1.5 rounded-full bg-white pulse-dot" />}
      {c.label}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center p-5">{children}</div>;
}

function Card({ title, tone, children }: { title: string; tone: "error"; children: React.ReactNode }) {
  return (
    <div className={`w-full max-w-sm rounded-2xl bg-ink-900 p-6 text-sm leading-relaxed ring-1 ${tone === "error" ? "ring-live/40" : "ring-ink-700"}`}>
      <h1 className="text-lg font-semibold text-red-200">{title}</h1>
      <div className="mt-2 text-ink-300">{children}</div>
    </div>
  );
}
