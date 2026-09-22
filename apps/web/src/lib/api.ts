import type {
  AnswerResponse,
  CameraState,
  JoinInfo,
  NetworkInfo,
  OfferRequest,
  PairingSession,
} from "@divya/contracts";

// ngrok's free tier interposes a "you are about to visit" page on browser
// requests. This header skips it for our API calls.
const HEADERS = { "content-type": "application/json", "ngrok-skip-browser-warning": "1" };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { ...HEADERS, ...(init?.headers ?? {}) }, cache: "no-store" });
  } catch {
    throw new ApiError("Cannot reach the server. Check that the laptop is running and on the same network.", 0);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  network: () => request<NetworkInfo>("/api/network"),
  createSession: (baseUrl?: string) =>
    request<PairingSession>("/api/sessions", { method: "POST", body: JSON.stringify({ base_url: baseUrl || null }) }),
  joinInfo: (token: string) => request<JoinInfo>(`/api/sessions/${encodeURIComponent(token)}`),
  offer: (body: OfferRequest) => request<AnswerResponse>("/api/rtc/offer", { method: "POST", body: JSON.stringify(body) }),
  cameras: () => request<CameraState[]>("/api/cameras"),
  removeCamera: (cameraId: string) =>
    request<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(cameraId)}`, { method: "DELETE" }),
};

/** Same-origin websocket URL; server.mjs proxies /ws to the ingest service. */
export function dashboardSocketUrl(): string {
  const override = process.env.NEXT_PUBLIC_INGEST_WS_URL;
  if (override) return override;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws/dashboard`;
}
