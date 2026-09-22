import type { CameraStatus } from "@divya/contracts";

const STYLES: Record<CameraStatus, { label: string; dot: string; ring: string; pulse?: boolean }> = {
  live: { label: "Live", dot: "bg-live", ring: "bg-live/15 text-red-200 ring-live/40", pulse: true },
  connecting: { label: "Connecting", dot: "bg-warn", ring: "bg-warn/10 text-amber-200 ring-warn/35", pulse: true },
  pending: { label: "Pending", dot: "bg-ink-400", ring: "bg-ink-700/60 text-ink-300 ring-ink-600" },
  degraded: { label: "Degraded", dot: "bg-warn", ring: "bg-warn/10 text-amber-200 ring-warn/35" },
  offline: { label: "Offline", dot: "bg-ink-400", ring: "bg-ink-800/80 text-ink-300 ring-ink-600" },
};

export function StatusPill({ status }: { status: CameraStatus }) {
  const s = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1 backdrop-blur ${s.ring}`}>
      <span className={`size-1.5 rounded-full ${s.dot} ${s.pulse ? "pulse-dot" : ""}`} />
      {s.label}
    </span>
  );
}
