"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { NetworkInfo, PairingSession } from "@divya/contracts";

import { api } from "@/lib/api";

const BASE_URL_KEY = "divya.baseUrl";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The most recent session_update from the dashboard socket. */
  lastSessionUpdate: PairingSession | null;
}

type Phase = "loading" | "waiting" | "connected" | "error";

export function ConnectMobileDialog({ open, onClose, lastSessionUpdate }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<PairingSession | null>(null);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [showNetwork, setShowNetwork] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pendingToken = useRef<string | null>(null);

  const create = useCallback(async (override?: string) => {
    setPhase("loading");
    setError(null);
    try {
      const net = await api.network();
      setNetwork(net);
      let stored = "";
      try {
        stored = localStorage.getItem(BASE_URL_KEY) ?? "";
      } catch {
        /* storage blocked */
      }
      const base = (override ?? (stored || net.suggested_base_url)).trim();
      setBaseUrl(base);
      const s = await api.createSession(base);
      pendingToken.current = s.token;
      setSession(s);
      setPhase("waiting");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, []);

  // Open -> make a fresh QR. Close -> free the reserved camera slot if unused.
  useEffect(() => {
    if (!open) return;
    void create();
    return () => {
      const token = pendingToken.current;
      pendingToken.current = null;
      if (token) void fetch(`/api/sessions/${token}`, { method: "DELETE" }).catch(() => undefined);
    };
  }, [open, create]);

  // The phone connected: show it, then close.
  useEffect(() => {
    if (!session || !lastSessionUpdate || lastSessionUpdate.token !== session.token) return;
    if (lastSessionUpdate.status === "claimed") {
      pendingToken.current = null; // claimed, so do not cancel it on close
      setPhase("connected");
      const t = setTimeout(onClose, 1600);
      return () => clearTimeout(t);
    }
    if (lastSessionUpdate.status === "expired") {
      pendingToken.current = null;
      void create();
    }
  }, [lastSessionUpdate, session, onClose, create]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const secondsLeft = session ? Math.max(0, Math.round((Date.parse(session.expires_at) - now) / 1000)) : 0;
  const isLocalhost = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl);
  const isHttp = baseUrl.startsWith("http://") && !isLocalhost;

  const applyBase = (value: string) => {
    const v = value.trim().replace(/\/+$/, "");
    try {
      if (v && v !== network?.suggested_base_url) localStorage.setItem(BASE_URL_KEY, v);
      else localStorage.removeItem(BASE_URL_KEY);
    } catch {
      /* storage blocked */
    }
    const old = pendingToken.current;
    if (old) void fetch(`/api/sessions/${old}`, { method: "DELETE" }).catch(() => undefined);
    pendingToken.current = null;
    void create(v || network?.suggested_base_url);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        className="w-full max-w-md overflow-hidden rounded-2xl bg-ink-900 shadow-2xl ring-1 ring-ink-700"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
          <div>
            <h2 id="connect-title" className="text-base font-semibold">
              Connect a phone{session ? ` as ${session.camera_id}` : ""}
            </h2>
            <p className="mt-0.5 text-sm text-ink-400">Scan with the phone camera. It becomes a live camera node.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label="Close">
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor">
              <path d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 0 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4Z" />
            </svg>
          </button>
        </header>

        <div className="px-5 py-5">
          {phase === "loading" && (
            <div className="grid h-72 place-items-center">
              <div className="size-8 animate-spin rounded-full border-2 border-ink-600 border-t-saffron-500" />
            </div>
          )}

          {phase === "error" && (
            <div className="rounded-lg bg-live/10 p-4 text-sm text-red-200 ring-1 ring-live/30">
              <p className="font-semibold">Could not create a pairing code</p>
              <p className="mt-1 text-red-200/80">{error}</p>
              <button type="button" onClick={() => void create()} className="mt-3 rounded-md bg-ink-800 px-3 py-1.5 text-ink-100 ring-1 ring-ink-600 hover:bg-ink-700">
                Try again
              </button>
            </div>
          )}

          {phase === "connected" && session && (
            <div className="grid h-72 place-items-center text-center">
              <div>
                <div className="mx-auto grid size-16 place-items-center rounded-full bg-ok/15 ring-1 ring-ok/40">
                  <svg viewBox="0 0 24 24" className="size-8 text-ok" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="mt-4 text-lg font-semibold">{session.camera_id} connected</p>
                <p className="mt-1 text-sm text-ink-400">The feed will appear on the dashboard.</p>
              </div>
            </div>
          )}

          {phase === "waiting" && session && (
            <>
              <div className="mx-auto w-fit rounded-xl bg-white p-3.5 shadow-lg">
                <QRCodeSVG value={session.join_url} size={232} level="M" marginSize={0} />
              </div>

              <div className="mt-4 flex items-center justify-center gap-2 text-sm text-ink-300">
                <span className="size-2 rounded-full bg-warn pulse-dot" />
                Waiting for the phone to scan
                <span className="font-mono text-ink-400">
                  · {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
                </span>
              </div>

              <div className="mt-4 flex items-center gap-2 rounded-lg bg-ink-950 px-3 py-2 ring-1 ring-ink-700">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-300">{session.join_url}</code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(session.join_url).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                  className="shrink-0 rounded-md bg-ink-800 px-2 py-1 text-xs font-medium ring-1 ring-ink-600 hover:bg-ink-700"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              {(isLocalhost || isHttp) && (
                <p className="mt-3 rounded-md bg-warn/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-warn/30">
                  {isLocalhost
                    ? "This link points at localhost, which a phone cannot open. Set the address below."
                    : "Phones only allow the camera on https:// links. Use `pnpm dev:lan` or an ngrok URL."}
                </p>
              )}

              <button
                type="button"
                onClick={() => setShowNetwork((v) => !v)}
                className="mt-4 flex w-full items-center justify-between text-left text-xs font-medium text-ink-400 hover:text-ink-100"
              >
                <span>Phone cannot open the link?</span>
                <span>{showNetwork ? "Hide" : "Change address"}</span>
              </button>

              {showNetwork && (
                <form
                  className="mt-3 space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    applyBase(baseUrl);
                  }}
                >
                  <label className="block">
                    <span className="text-xs text-ink-400">Address the phone should open</span>
                    <input
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      spellCheck={false}
                      className="mt-1 w-full rounded-md bg-ink-950 px-3 py-2 font-mono text-xs text-ink-100 ring-1 ring-ink-600 outline-none focus:ring-saffron-500"
                      placeholder="https://xxxx.ngrok-free.app"
                    />
                  </label>
                  {network && network.lan_ips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {network.lan_ips.map((ip) => (
                        <button
                          type="button"
                          key={ip}
                          onClick={() => applyBase(`https://${ip}:3000`)}
                          className="rounded-md bg-ink-800 px-2 py-1 font-mono text-[11px] ring-1 ring-ink-600 hover:bg-ink-700"
                        >
                          https://{ip}:3000
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button type="submit" className="rounded-md bg-saffron-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-saffron-400">
                      Use this address
                    </button>
                    <button
                      type="button"
                      onClick={() => applyBase(network?.suggested_base_url ?? "")}
                      className="rounded-md bg-ink-800 px-3 py-1.5 text-xs ring-1 ring-ink-600 hover:bg-ink-700"
                    >
                      Reset
                    </button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-400">
                    Same Wi-Fi: run <code className="text-ink-300">pnpm dev:lan</code> and use a LAN address. Different
                    networks: run <code className="text-ink-300">ngrok http 3000</code> and paste its https URL.
                  </p>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
