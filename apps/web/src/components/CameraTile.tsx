"use client";

import { useEffect, useRef, useState } from "react";

import type { CameraState } from "@divya/contracts";

import { fmtKbps, fmtMs, fmtRes, fmtSigned } from "@/lib/format";
import type { LiveFrame } from "@/lib/useIngest";

import { StatusPill } from "./StatusPill";

interface Props {
  camera: CameraState;
  subscribe: (cameraId: string, fn: (f: LiveFrame) => void) => () => void;
  onRemove: (cameraId: string) => void;
}

const STALE_AFTER_MS = 2500;

export function CameraTile({ camera, subscribe, onRemove }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backdropRef = useRef<HTMLCanvasElement>(null);
  const lastPaint = useRef(0);
  const paints = useRef<number[]>([]);
  const [screenFps, setScreenFps] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    return subscribe(camera.camera_id, (frame) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { bitmap } = frame;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);

      // A tiny copy behind the frame, blurred by CSS, fills any letterbox or
      // pillarbox (a portrait phone in a 16:9 tile) instead of black bars.
      const back = backdropRef.current;
      if (back) {
        const bw = 96;
        const bh = Math.max(1, Math.round((bw * bitmap.height) / bitmap.width));
        if (back.width !== bw || back.height !== bh) {
          back.width = bw;
          back.height = bh;
        }
        back.getContext("2d")?.drawImage(bitmap, 0, 0, bw, bh);
      }
      const now = performance.now();
      lastPaint.current = now;
      paints.current.push(now);
      setHasFrame(true);
    });
  }, [camera.camera_id, subscribe]);

  // Measure what actually reaches the screen, and notice when frames stop.
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      paints.current = paints.current.filter((t) => now - t < 2000);
      setScreenFps(Math.round(paints.current.length / 2));
      setStale(lastPaint.current > 0 && now - lastPaint.current > STALE_AFTER_MS);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const q = camera.quality;
  const qPct = q ? Math.round(q.score * 100) : null;
  const qColour = qPct == null ? "bg-ink-600" : qPct >= 70 ? "bg-ok" : qPct >= 40 ? "bg-warn" : "bg-live";
  const offline = camera.status === "offline";

  return (
    <article className="group relative overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700/80 transition hover:ring-ink-600">
      <div className="relative aspect-video overflow-hidden bg-black">
        <canvas
          ref={backdropRef}
          aria-hidden
          className={`absolute inset-0 h-full w-full scale-110 object-cover blur-2xl brightness-50 transition ${offline || stale ? "opacity-20" : "opacity-100"}`}
        />
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 h-full w-full object-contain transition ${offline || stale ? "opacity-35 grayscale" : ""}`}
        />

        {!hasFrame && (
          <div className="scanline absolute inset-0 grid place-items-center overflow-hidden">
            <div className="text-center">
              <div className="mx-auto mb-3 size-7 animate-spin rounded-full border-2 border-ink-600 border-t-saffron-500" />
              <p className="text-sm text-ink-300">
                {offline ? "Camera offline" : camera.status === "connecting" ? "Establishing WebRTC link..." : "Waiting for first frame..."}
              </p>
            </div>
          </div>
        )}

        {/* top bar */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/75 to-transparent p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded bg-saffron-500 px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wide text-white">
                {camera.camera_id}
              </span>
              <span className="truncate text-sm font-medium text-white/95">{camera.device_name}</span>
            </div>
          </div>
          <StatusPill status={stale && camera.status === "live" ? "degraded" : camera.status} />
        </div>

        {q?.frozen && (
          <div className="absolute inset-x-3 top-12 rounded-md bg-warn/90 px-2.5 py-1.5 text-xs font-semibold text-black">
            Feed looks frozen: the picture has not changed for several seconds.
          </div>
        )}
        {stale && !offline && !q?.frozen && (
          <div className="absolute inset-x-3 top-12 rounded-md bg-ink-800/90 px-2.5 py-1.5 text-xs text-ink-100 ring-1 ring-ink-600">
            No frames for a few seconds. Is the phone screen still on?
          </div>
        )}

        {/* bottom stats */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-2.5 pt-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-white/85">
            <span>{fmtRes(camera.decoded_width, camera.decoded_height)}</span>
            <span className="text-white/35">|</span>
            <span title="received from phone / processed by backend / painted here">
              {camera.capture_fps.toFixed(0)}/{camera.process_fps.toFixed(0)}/{screenFps} fps
            </span>
            <span className="text-white/35">|</span>
            <span>{fmtKbps(camera.bitrate_kbps)}</span>
            {camera.codec && (
              <>
                <span className="text-white/35">|</span>
                <span>{camera.codec}</span>
              </>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/55">Quality</span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
              <div className={`h-full rounded-full ${qColour} transition-all`} style={{ width: `${qPct ?? 0}%` }} />
            </div>
            <span className="w-8 text-right font-mono text-[11px] text-white/85">{qPct ?? "--"}</span>
          </div>
        </div>
      </div>

      {/* detail strip */}
      <div className="grid grid-cols-4 divide-x divide-ink-700/80 border-t border-ink-700/80 text-center">
        <Stat label="RTT" value={fmtMs(camera.rtt_ms)} />
        <Stat label="Clock skew" value={fmtSigned(camera.clock_offset_ms)} />
        <Stat label="Blur" value={q ? String(Math.round(q.blur)) : "--"} />
        <Stat label="Light" value={q ? `${Math.round(q.brightness * 100)}%` : "--"} />
      </div>

      <div className="absolute right-2 top-11 flex gap-1.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
        <a
          href={`/api/cameras/${camera.camera_id}/snapshot.jpg`}
          target="_blank"
          rel="noreferrer"
          className="rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white ring-1 ring-white/15 hover:bg-black/90"
        >
          Snapshot
        </a>
        <button
          type="button"
          onClick={() => (confirming ? onRemove(camera.camera_id) : setConfirming(true))}
          onBlur={() => setConfirming(false)}
          className={`rounded-md px-2 py-1 text-[11px] font-medium ring-1 ${confirming ? "bg-live text-white ring-live" : "bg-black/70 text-white ring-white/15 hover:bg-black/90"}`}
        >
          {confirming ? "Click to remove" : "Remove"}
        </button>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-0.5 font-mono text-xs text-ink-100">{value}</div>
    </div>
  );
}
