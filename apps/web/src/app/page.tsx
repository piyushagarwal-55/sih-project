"use client";

import { useCallback, useMemo, useState } from "react";

import type { PairingSession } from "@divya/contracts";

import { CameraTile } from "@/components/CameraTile";
import { ConnectMobileDialog } from "@/components/ConnectMobileDialog";
import { Logo } from "@/components/Logo";
import { api } from "@/lib/api";
import { useIngest } from "@/lib/useIngest";

export default function Dashboard() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastSession, setLastSession] = useState<PairingSession | null>(null);
  const { cameras, status, subscribeFrames } = useIngest(setLastSession);

  const list = useMemo(() => Object.values(cameras).sort((a, b) => a.camera_id.localeCompare(b.camera_id)), [cameras]);
  const live = list.filter((c) => c.status === "live").length;
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const remove = useCallback(async (cameraId: string) => {
    try {
      await api.removeCamera(cameraId);
    } catch (err) {
      console.error(err);
    }
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo />
          <div className="flex items-center gap-3">
            <SocketBadge status={status} />
            <div className="hidden text-right sm:block">
              <div className="font-mono text-sm font-semibold">
                {live}
                <span className="text-ink-400"> / {list.length}</span>
              </div>
              <div className="text-[10px] uppercase tracking-wider text-ink-400">cameras live</div>
            </div>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              disabled={status !== "open"}
              className="inline-flex items-center gap-2 rounded-lg bg-saffron-500 px-3.5 py-2 text-sm font-semibold text-white shadow-lg shadow-saffron-500/20 transition hover:bg-saffron-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden>
                <path d="M6 2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H6Zm4 13.25a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
              </svg>
              Connect Mobile
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 sm:px-6">
        {status === "closed" && (
          <div className="mb-4 rounded-lg bg-live/10 px-4 py-3 text-sm text-red-200 ring-1 ring-live/30">
            Lost the connection to the ingest service. Retrying... Make sure <code className="font-mono">pnpm dev</code> is running.
          </div>
        )}

        {list.length === 0 ? (
          <EmptyState onConnect={() => setDialogOpen(true)} disabled={status !== "open"} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {list.map((camera) => (
              <CameraTile key={camera.camera_id} camera={camera} subscribe={subscribeFrames} onRemove={remove} />
            ))}
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              disabled={status !== "open"}
              className="grid aspect-video place-items-center rounded-xl border-2 border-dashed border-ink-700 text-ink-400 transition hover:border-saffron-500/60 hover:text-ink-100 disabled:opacity-40"
            >
              <span className="text-center">
                <span className="mx-auto mb-2 grid size-10 place-items-center rounded-full bg-ink-800 text-2xl leading-none">+</span>
                <span className="text-sm font-medium">Add another camera</span>
              </span>
            </button>
          </div>
        )}
      </main>

      <footer className="border-t border-ink-800 px-6 py-3 text-center text-[11px] text-ink-400">
        Phone &rarr; WebRTC &rarr; decode &rarr; timestamp &rarr; quality score &rarr; dashboard. Stats per tile: received / processed / on-screen FPS.
      </footer>

      <ConnectMobileDialog open={dialogOpen} onClose={closeDialog} lastSessionUpdate={lastSession} />
    </div>
  );
}

function SocketBadge({ status }: { status: "connecting" | "open" | "closed" }) {
  const cfg = {
    open: { label: "Backend online", dot: "bg-ok" },
    connecting: { label: "Connecting", dot: "bg-warn pulse-dot" },
    closed: { label: "Backend offline", dot: "bg-live pulse-dot" },
  }[status];
  return (
    <span className="hidden items-center gap-2 rounded-full bg-ink-850 px-2.5 py-1 text-xs text-ink-300 ring-1 ring-ink-700 md:inline-flex">
      <span className={`size-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function EmptyState({ onConnect, disabled }: { onConnect: () => void; disabled: boolean }) {
  const steps = [
    ["Connect Mobile", "Click the button to generate a one-time QR code."],
    ["Scan on the phone", "The camera page opens in the phone browser."],
    ["Allow the camera", "The live feed appears here within seconds."],
  ];
  return (
    <div className="mx-auto mt-10 max-w-2xl text-center">
      <div className="scanline relative mx-auto grid aspect-video max-w-lg place-items-center overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-ink-700">
        <div>
          <div className="mx-auto grid size-14 place-items-center rounded-full bg-ink-800 ring-1 ring-ink-600">
            <svg viewBox="0 0 24 24" className="size-7 text-saffron-400" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M15 10.5 20 7v10l-5-3.5M4 7h11v10H4z" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="mt-4 text-lg font-semibold">No cameras connected yet</p>
          <p className="mt-1 text-sm text-ink-400">Turn any phone into a live camera node.</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onConnect}
        disabled={disabled}
        className="mt-6 rounded-lg bg-saffron-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-saffron-500/20 hover:bg-saffron-400 disabled:opacity-50"
      >
        Connect Mobile
      </button>
      <ol className="mt-8 grid gap-3 text-left sm:grid-cols-3">
        {steps.map(([title, body], i) => (
          <li key={title} className="rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700">
            <div className="font-mono text-xs text-saffron-400">0{i + 1}</div>
            <div className="mt-1 text-sm font-semibold">{title}</div>
            <div className="mt-1 text-xs leading-relaxed text-ink-400">{body}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
