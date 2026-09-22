export const fmtKbps = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);

export const fmtMs = (ms: number | null | undefined) => (ms == null ? "n/a" : `${Math.round(ms)} ms`);

export const fmtSigned = (ms: number | null | undefined) =>
  ms == null ? "n/a" : `${ms > 0 ? "+" : ""}${Math.round(ms)} ms`;

export const fmtRes = (w: number, h: number) => (w && h ? `${w}×${h}` : "n/a");

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  const android = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/);
  if (android?.[1]) return android[1].trim().slice(0, 40);
  if (/Android/.test(ua)) return "Android phone";
  return "Browser camera";
}
