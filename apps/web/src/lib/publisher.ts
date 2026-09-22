/**
 * Phone side of PRD §5-6: capture the camera and publish it over WebRTC.
 *
 *   getUserMedia -> RTCPeerConnection (send-only video + "telemetry" channel)
 *   -> offer, wait for ICE gathering -> POST /api/rtc/offer -> answer
 *
 * The backend (aiortc) does not accept trickled candidates, so we wait for ICE
 * gathering to finish before sending the offer.
 */

import type { CaptureInfo, IceServer, TelemetryFromPhone, TelemetryFromServer } from "@divya/contracts";

import { api, ApiError } from "./api";
import { startTestPattern } from "./testPattern";

export type Facing = "environment" | "user";
export type PublisherPhase = "idle" | "starting" | "connecting" | "live" | "reconnecting" | "stopped" | "error";

export interface PublisherStats {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  codec: string | null;
  connectionState: RTCPeerConnectionState | "new";
}

export interface PublisherOptions {
  token: string;
  deviceName: string;
  iceServers: IceServer[];
  source: "camera" | "test";
  preferCodec: "h264" | "vp8";
  onPhase: (phase: PublisherPhase, detail?: string) => void;
  onStats: (stats: PublisherStats) => void;
  onStream: (stream: MediaStream) => void;
}

const ICE_GATHER_TIMEOUT_MS = 4000;
const MAX_BITRATE = 2_500_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

export class CameraPublisher {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private stopTest: (() => void) | null = null;
  private facing: Facing = "environment";
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private lastBytes = 0;
  private lastBytesAt = 0;
  private stopped = false;
  private wakeLock: WakeLockSentinel | null = null;

  constructor(private readonly opts: PublisherOptions) {}

  get currentFacing() {
    return this.facing;
  }

  async start(facing: Facing = "environment"): Promise<void> {
    this.stopped = false;
    this.facing = facing;
    this.opts.onPhase("starting");
    try {
      this.stream = await this.acquire(facing);
    } catch (err) {
      this.opts.onPhase("error", describeMediaError(err));
      throw err;
    }
    this.opts.onStream(this.stream);
    await this.requestWakeLock();
    document.addEventListener("visibilitychange", this.onVisibility);
    await this.connect();
  }

  async switchCamera(): Promise<void> {
    if (this.opts.source === "test" || !this.stream) return;
    const next: Facing = this.facing === "environment" ? "user" : "environment";
    const fresh = await this.acquire(next);
    const track = fresh.getVideoTracks()[0];
    if (!track) return;
    // replaceTrack swaps the source without renegotiating the connection.
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
    await sender?.replaceTrack(track);
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = fresh;
    this.facing = next;
    this.opts.onStream(fresh);
    this.sendStatus();
  }

  /**
   * After the screen rotates, ask the camera for 720p in the new orientation and
   * tell the backend. Chrome usually re-orients the track by itself; this makes
   * sure the resolution follows rather than staying at the old aspect.
   */
  async onOrientationChange(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || this.opts.source === "test") return;
    const portrait = window.matchMedia("(orientation: portrait)").matches;
    try {
      await track.applyConstraints({
        width: { ideal: portrait ? 720 : 1280 },
        height: { ideal: portrait ? 1280 : 720 },
        frameRate: { ideal: 30, max: 30 },
      });
    } catch {
      /* keep whatever the camera is doing */
    }
    this.sendStatus();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.statsTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.disconnectTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.teardownPeer();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.stopTest?.();
    this.stopTest = null;
    await this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    this.opts.onPhase("stopped");
  }

  // -- media -----------------------------------------------------------------

  private async acquire(facing: Facing): Promise<MediaStream> {
    if (this.opts.source === "test") {
      this.stopTest?.();
      const { stream, stop } = startTestPattern(this.opts.deviceName);
      this.stopTest = stop;
      return stream;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? "This browser cannot open the camera."
          : "Camera access needs HTTPS. Open the link from the QR code (https://...), not a plain http address.",
      );
    }
    // Ask for 720p30 first, then relax. Some phones reject exact constraints.
    const attempts: MediaTrackConstraints[] = [
      { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      { facingMode: { ideal: facing } },
      {},
    ];
    let lastErr: unknown;
    for (const video of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        const track = stream.getVideoTracks()[0];
        if (track && "contentHint" in track) track.contentHint = "motion"; // favour frame rate over detail
        return stream;
      } catch (err) {
        lastErr = err;
        const name = (err as DOMException)?.name;
        if (name === "NotAllowedError" || name === "SecurityError") break; // retrying will not help
      }
    }
    throw lastErr;
  }

  captureInfo(): CaptureInfo {
    const s = this.stream?.getVideoTracks()[0]?.getSettings() ?? {};
    const facing = (s.facingMode as Facing | undefined) ?? (this.opts.source === "test" ? "environment" : this.facing);
    return { width: s.width ?? 0, height: s.height ?? 0, fps: Math.round(s.frameRate ?? 0), facing: facing ?? "unknown" };
  }

  // -- peer connection -------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped || !this.stream) return;
    this.teardownPeer();
    this.opts.onPhase(this.reconnectAttempt ? "reconnecting" : "connecting");

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers as RTCIceServer[] });
    this.pc = pc;

    const track = this.stream.getVideoTracks()[0];
    if (!track) {
      this.opts.onPhase("error", "The camera did not produce a video track.");
      return;
    }
    const transceiver = pc.addTransceiver(track, { direction: "sendonly", streams: [this.stream] });
    this.preferCodec(transceiver);

    const channel = pc.createDataChannel("telemetry");
    this.channel = channel;
    channel.onmessage = (ev) => this.onTelemetry(ev.data);
    channel.onopen = () => this.sendStatus();

    pc.onconnectionstatechange = () => this.onConnectionState(pc);

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);
      const local = pc.localDescription;
      if (!local) throw new Error("Could not build a WebRTC offer.");

      const answer = await api.offer({
        token: this.opts.token,
        sdp: local.sdp,
        type: "offer",
        device_name: this.opts.deviceName,
        capture: this.captureInfo(),
        client_time_ms: Date.now(),
      });
      if (this.pc !== pc) return; // superseded while we were waiting
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await this.tuneSender(pc);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        this.stopped = true;
        this.opts.onPhase("error", err.message);
        return;
      }
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }

    clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => void this.collectStats(), 1000);
  }

  private preferCodec(transceiver: RTCRtpTransceiver) {
    const caps = typeof RTCRtpSender !== "undefined" ? RTCRtpSender.getCapabilities?.("video") : null;
    if (!caps || !("setCodecPreferences" in transceiver)) return;
    const want = this.opts.preferCodec === "h264" ? "video/H264" : "video/VP8";
    const codecs = [...caps.codecs].sort((a, b) => Number(b.mimeType === want) - Number(a.mimeType === want));
    try {
      transceiver.setCodecPreferences(codecs);
    } catch {
      /* the browser keeps its own order */
    }
  }

  private async tuneSender(pc: RTCPeerConnection) {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0]!.maxBitrate = MAX_BITRATE;
    params.encodings[0]!.maxFramerate = 30;
    // When bandwidth is short, drop frame rate before resolution. The backend
    // only processes ~12 FPS anyway, and detection of small or distant people
    // needs the pixels. ("maintain-framerate" fell to 360p while bandwidth ramped up.)
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = "maintain-resolution";
    try {
      await sender.setParameters(params);
    } catch {
      /* not every browser accepts every field */
    }
  }

  private onConnectionState(pc: RTCPeerConnection) {
    if (pc !== this.pc || this.stopped) return;
    const state = pc.connectionState;
    clearTimeout(this.disconnectTimer);
    if (state === "connected") {
      this.reconnectAttempt = 0;
      this.opts.onPhase("live");
    } else if (state === "failed") {
      this.scheduleReconnect("The connection to the laptop failed.");
    } else if (state === "disconnected") {
      // Often recovers on its own (a Wi-Fi blip). Give it a few seconds first.
      this.opts.onPhase("reconnecting", "Signal lost, waiting for it to recover...");
      this.disconnectTimer = setTimeout(() => {
        if (this.pc === pc && pc.connectionState !== "connected") this.scheduleReconnect("The connection dropped.");
      }, 4000);
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.opts.onPhase("reconnecting", `${reason} Retrying in ${Math.round(delay / 1000)}s...`);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private teardownPeer() {
    clearInterval(this.statsTimer);
    this.channel?.close();
    this.channel = null;
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
  }

  // -- telemetry -------------------------------------------------------------

  private onTelemetry(raw: unknown) {
    if (typeof raw !== "string") return;
    let msg: TelemetryFromServer;
    try {
      msg = JSON.parse(raw) as TelemetryFromServer;
    } catch {
      return;
    }
    if (msg.type === "ping") {
      const t1 = Date.now();
      this.send({ type: "pong", t0: msg.t0, t1, t2: Date.now(), seq: msg.seq });
    }
  }

  async sendStatus() {
    let battery: number | null = null;
    let charging: boolean | null = null;
    try {
      const b = await (navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> })
        .getBattery?.();
      if (b) {
        battery = Math.round(b.level * 100);
        charging = b.charging;
      }
    } catch {
      /* not supported */
    }
    this.send({ type: "status", battery, charging, capture: this.captureInfo(), visible: !document.hidden });
  }

  private send(msg: TelemetryFromPhone) {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(msg));
  }

  private async collectStats() {
    const pc = this.pc;
    if (!pc) return;
    const report = await pc.getStats();
    let fps = 0;
    let width = 0;
    let height = 0;
    let bytes = 0;
    let codecId: string | undefined;
    const codecs = new Map<string, string>();
    report.forEach((s) => {
      if (s.type === "outbound-rtp" && s.kind === "video") {
        fps = s.framesPerSecond ?? 0;
        width = s.frameWidth ?? 0;
        height = s.frameHeight ?? 0;
        bytes = s.bytesSent ?? 0;
        codecId = s.codecId;
      } else if (s.type === "codec") {
        codecs.set(s.id, String(s.mimeType ?? "").replace("video/", ""));
      }
    });
    const now = performance.now();
    const kbps = this.lastBytesAt ? ((bytes - this.lastBytes) * 8) / (now - this.lastBytesAt) : 0;
    this.lastBytes = bytes;
    this.lastBytesAt = now;
    this.opts.onStats({
      width,
      height,
      fps: Math.round(fps),
      bitrateKbps: Math.max(0, kbps),
      codec: codecId ? (codecs.get(codecId) ?? null) : null,
      connectionState: pc.connectionState,
    });
  }

  // -- screen ------------------------------------------------------------------

  private async requestWakeLock() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* battery saver or unsupported; the page shows a reminder */
    }
  }

  private onVisibility = () => {
    // The wake lock is released whenever the page is hidden; take it again.
    if (!document.hidden && !this.stopped) void this.requestWakeLock();
    this.sendStatus();
  };
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    // Some networks never report "complete" (an unreachable STUN server). Send what we have.
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export function describeMediaError(err: unknown): string {
  const name = (err as DOMException)?.name;
  switch (name) {
    case "NotAllowedError":
      return "Camera permission was blocked. Allow camera access for this site in your browser settings, then tap Start again.";
    case "NotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
      return "The camera is in use by another app. Close it and try again.";
    case "OverconstrainedError":
      return "This camera does not support the requested mode.";
    case "SecurityError":
      return "Camera access needs HTTPS. Open the exact link from the QR code.";
    default:
      return err instanceof Error ? err.message : "Could not start the camera.";
  }
}
