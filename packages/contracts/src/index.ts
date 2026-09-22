/**
 * Wire contracts shared by the web app and the Python ingest service.
 *
 * These mirror the pydantic models in services/ingest/app/models.py.
 * If you change one side, change the other.
 */

export type CameraStatus = "pending" | "connecting" | "live" | "degraded" | "offline";

/** PRD §12: confidence in the visual input. Not a threat score. */
export interface QualityReport {
  /** Variance of the Laplacian on a downscaled grey frame. Higher is sharper. */
  blur: number;
  /** Mean luminance in [0, 1]. */
  brightness: number;
  /** 1.0 for a clean decode, lower for blank, flat or corrupt frames. */
  integrity: number;
  /** Combined usability score in [0, 1]. */
  score: number;
  /** True when the feed has repeated an identical frame for several seconds. */
  frozen: boolean;
}

export interface CaptureInfo {
  width: number;
  height: number;
  fps: number;
  facing: "environment" | "user" | "unknown";
}

/** PRD §14: one entry in the camera registry. */
export interface CameraState {
  camera_id: string;
  device_name: string;
  status: CameraStatus;
  connection_state: string;
  connected_at: string | null;
  last_frame_at: string | null;
  capture: CaptureInfo | null;
  /** Resolution of frames actually decoded by the backend. */
  decoded_width: number;
  decoded_height: number;
  /** Frames the backend received from the phone, per second. */
  capture_fps: number;
  /** Frames that went through the processing path, per second. */
  process_fps: number;
  frames_received: number;
  frames_processed: number;
  frames_skipped: number;
  bitrate_kbps: number;
  packets_lost: number;
  /** Round trip over the telemetry data channel. */
  rtt_ms: number | null;
  /** phone clock minus backend clock, NTP-style estimate (PRD §10). */
  clock_offset_ms: number | null;
  quality: QualityReport | null;
  codec: string | null;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Returned to the dashboard when it asks to pair a new phone. */
export interface PairingSession {
  token: string;
  camera_id: string;
  join_url: string;
  expires_at: string;
  status: "waiting" | "claimed" | "expired";
}

/** Returned to the phone when it opens the join link. */
export interface JoinInfo {
  token: string;
  camera_id: string;
  ice_servers: IceServer[];
  server_time_ms: number;
  status: "waiting" | "claimed" | "expired";
}

export interface OfferRequest {
  token: string;
  sdp: string;
  type: "offer";
  device_name: string;
  capture: CaptureInfo;
  client_time_ms: number;
}

export interface AnswerResponse {
  sdp: string;
  type: "answer";
  camera_id: string;
}

export interface NetworkInfo {
  lan_ips: string[];
  public_base_url: string | null;
  suggested_base_url: string;
}

// ---------------------------------------------------------------------------
// Dashboard websocket, server -> client (JSON text frames)
// ---------------------------------------------------------------------------

export type DashboardMessage =
  | { type: "snapshot"; cameras: CameraState[]; server_time_ms: number }
  | { type: "camera_update"; camera: CameraState }
  | { type: "camera_removed"; camera_id: string }
  | { type: "session_update"; session: PairingSession };

/**
 * Dashboard websocket, server -> client (binary frames).
 *
 * Layout: [uint32 big-endian header length N][N bytes UTF-8 JSON FrameHeader][JPEG bytes]
 */
export interface FrameHeader {
  camera_id: string;
  frame_id: number;
  /** Presentation time from the RTP stream, milliseconds. */
  pts_ms: number | null;
  /** Canonical backend receive time, epoch milliseconds (PRD §9). */
  ts_ms: number;
  width: number;
  height: number;
  quality: QualityReport;
}

// ---------------------------------------------------------------------------
// Telemetry data channel between phone and backend
// ---------------------------------------------------------------------------

export type TelemetryFromServer = { type: "ping"; t0: number; seq: number };

export type TelemetryFromPhone =
  | { type: "pong"; t0: number; t1: number; t2: number; seq: number }
  | {
      type: "status";
      battery: number | null;
      charging: boolean | null;
      capture: CaptureInfo;
      visible: boolean;
    };

export const FRAME_HEADER_LEN_BYTES = 4;

/** Parse one binary dashboard frame. Returns null if the payload is malformed. */
export function decodeFrameMessage(buf: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } | null {
  if (buf.byteLength < FRAME_HEADER_LEN_BYTES) return null;
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, false);
  const start = FRAME_HEADER_LEN_BYTES;
  const end = start + headerLen;
  if (end > buf.byteLength) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, headerLen))) as FrameHeader;
    return { header, jpeg: new Uint8Array(buf, end) };
  } catch {
    return null;
  }
}
