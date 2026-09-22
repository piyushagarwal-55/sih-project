"""WebRTC receiver (PRD §6), one RTCPeerConnection per camera node.

The phone is the offerer and sends video only. aiortc does not trickle ICE:
`setLocalDescription` gathers every candidate before it returns, so the answer
we send back is complete and the phone must also finish gathering before it
posts its offer.

Each peer also carries a "telemetry" data channel. We use it for an NTP-style
exchange (PRD §10): with timestamps t0 (our send), t1 (phone receive),
t2 (phone send), t3 (our receive),

    rtt    = (t3 - t0) - (t2 - t1)
    offset = ((t1 - t0) + (t2 - t3)) / 2      # phone clock minus ours

The offset from the lowest-RTT sample in a short window is kept, because that
sample has the least queueing noise in it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.rtcdatachannel import RTCDataChannel

from .clock import mono_s, now_ms, now_s
from .config import Settings
from .hub import DashboardHub
from .models import AnswerResponse, CaptureInfo, OfferRequest
from .pipeline import CameraPipeline
from .registry import CameraRecord, CameraRegistry

log = logging.getLogger("ingest.rtc")

PING_INTERVAL_S = 2.0
STATS_INTERVAL_S = 1.0
STALE_AFTER_S = 3.0


@dataclass
class Peer:
    camera_id: str
    pc: RTCPeerConnection
    pipeline: CameraPipeline | None = None
    channel: RTCDataChannel | None = None
    tasks: list[asyncio.Task] = field(default_factory=list)
    ping_seq: int = 0
    samples: deque = field(default_factory=lambda: deque(maxlen=8))  # (rtt_ms, offset_ms)
    last_bytes: int | None = None
    last_bytes_t: float | None = None
    closing: bool = False


def negotiated_codec(sdp: str) -> str | None:
    """First payload type on the video m-line, resolved through its rtpmap."""
    m = re.search(r"^m=video \d+ [\w/]+ ([\d ]+)", sdp, re.MULTILINE)
    if not m:
        return None
    first_pt = m.group(1).split()[0]
    rtpmap = re.search(rf"^a=rtpmap:{first_pt} ([\w-]+)/", sdp, re.MULTILINE)
    return rtpmap.group(1) if rtpmap else None


class RtcManager:
    def __init__(self, registry: CameraRegistry, hub: DashboardHub, settings: Settings) -> None:
        self.registry = registry
        self.hub = hub
        self.settings = settings
        self.peers: dict[str, Peer] = {}
        self.executor = ThreadPoolExecutor(max_workers=max(4, settings.max_cameras), thread_name_prefix="frame")

    def _config(self) -> RTCConfiguration:
        servers = []
        for s in self.settings.ice_servers():
            servers.append(RTCIceServer(urls=s["urls"], username=s.get("username"), credential=s.get("credential")))
        return RTCConfiguration(iceServers=servers)

    def _emit(self, rec: CameraRecord) -> None:
        self.hub.broadcast({"type": "camera_update", "camera": rec.to_state().model_dump()})

    # -- offer / answer ----------------------------------------------------

    async def accept_offer(self, camera_id: str, req: OfferRequest) -> AnswerResponse:
        # A phone reconnecting with its old token replaces its previous peer.
        await self.close(camera_id, keep_record=True, emit=False)

        rec = self.registry.ensure(camera_id)
        rec.device_name = req.device_name.strip() or rec.device_name
        rec.capture = req.capture
        rec.status = "connecting"
        rec.connection_state = "new"
        rec.token = req.token
        rec.connected_at_s = None
        rec.last_frame_at_s = None
        rec.offline_since_s = None
        # A rough offset straight away; the data channel refines it within seconds.
        if req.client_time_ms:
            rec.clock_offset_ms = float(req.client_time_ms - now_ms())

        pc = RTCPeerConnection(self._config())
        peer = Peer(camera_id=camera_id, pc=pc)
        self.peers[camera_id] = peer

        @pc.on("track")
        def on_track(track) -> None:
            if track.kind != "video":
                return
            pipeline = CameraPipeline(rec, track, self.hub, self.settings, self.executor)
            peer.pipeline = pipeline
            peer.tasks.append(asyncio.create_task(pipeline.run(), name=f"pipeline-{camera_id}"))

        @pc.on("datachannel")
        def on_datachannel(channel: RTCDataChannel) -> None:
            if channel.label != "telemetry":
                return
            peer.channel = channel

            @channel.on("message")
            def on_message(message) -> None:
                self._on_telemetry(peer, rec, message)

            peer.tasks.append(asyncio.create_task(self._ping_loop(peer), name=f"ping-{camera_id}"))

        @pc.on("connectionstatechange")
        async def on_state() -> None:
            state = pc.connectionState
            rec.connection_state = state
            log.info("%s: connection %s", camera_id, state)
            if state == "connected":
                rec.connected_at_s = now_s()
                rec.status = "live"
            elif state == "disconnected":
                rec.status = "degraded"
            elif state in ("failed", "closed") and self.peers.get(camera_id) is peer:
                await self.close(camera_id, keep_record=True)
                return
            self._emit(rec)

        await pc.setRemoteDescription(RTCSessionDescription(sdp=req.sdp, type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)  # aiortc gathers all ICE candidates here

        rec.codec = negotiated_codec(pc.localDescription.sdp)
        peer.tasks.append(asyncio.create_task(self._stats_loop(peer, rec), name=f"stats-{camera_id}"))
        self._emit(rec)
        log.info("%s: answered offer from %r (codec %s)", camera_id, rec.device_name, rec.codec)
        return AnswerResponse(sdp=pc.localDescription.sdp, camera_id=camera_id)

    # -- telemetry ---------------------------------------------------------

    async def _ping_loop(self, peer: Peer) -> None:
        while not peer.closing:
            ch = peer.channel
            if ch is not None and ch.readyState == "open":
                peer.ping_seq += 1
                ch.send(json.dumps({"type": "ping", "t0": now_ms(), "seq": peer.ping_seq}))
            await asyncio.sleep(PING_INTERVAL_S)

    def _on_telemetry(self, peer: Peer, rec: CameraRecord, message) -> None:
        t3 = now_ms()
        try:
            msg = json.loads(message)
        except (TypeError, ValueError):
            return
        kind = msg.get("type")
        if kind == "pong":
            try:
                t0, t1, t2 = float(msg["t0"]), float(msg["t1"]), float(msg["t2"])
            except (KeyError, TypeError, ValueError):
                return
            rtt = (t3 - t0) - (t2 - t1)
            offset = ((t1 - t0) + (t2 - t3)) / 2.0
            if rtt < 0 or rtt > 10_000:
                return
            peer.samples.append((rtt, offset))
            best_rtt, best_offset = min(peer.samples, key=lambda s: s[0])
            rec.rtt_ms = rtt
            rec.clock_offset_ms = best_offset
        elif kind == "status":
            cap = msg.get("capture")
            if isinstance(cap, dict):
                with contextlib.suppress(Exception):
                    rec.capture = CaptureInfo(**cap)

    # -- stats -------------------------------------------------------------

    async def _stats_loop(self, peer: Peer, rec: CameraRecord) -> None:
        while not peer.closing:
            await asyncio.sleep(STATS_INTERVAL_S)
            t = mono_s()
            if peer.pipeline:
                rec.capture_fps = peer.pipeline.recv_rate.rate(t)
                rec.process_fps = peer.pipeline.proc_rate.rate(t)
            await self._sample_bitrate(peer, rec)

            if rec.connection_state in ("failed", "closed"):
                rec.status = "offline"
            elif rec.last_frame_at_s is None:
                rec.status = "connecting"
            elif now_s() - rec.last_frame_at_s > STALE_AFTER_S:
                rec.status = "degraded"
                rec.capture_fps = 0.0
                rec.process_fps = 0.0
            elif rec.quality is not None and (rec.quality.frozen or rec.quality.integrity < 0.5):
                rec.status = "degraded"
            elif rec.connection_state == "connected":
                rec.status = "live"
            self._emit(rec)

    async def _sample_bitrate(self, peer: Peer, rec: CameraRecord) -> None:
        # aiortc's inbound-rtp stats carry packet counts but no byte count; bytes
        # live on the transport. Each camera has its own bundled transport, so its
        # bytesReceived is the video bitrate plus a trickle of RTCP and telemetry.
        try:
            report = await peer.pc.getStats()
        except Exception:  # noqa: BLE001
            return
        received: int | None = None
        for stat in report.values():
            kind = getattr(stat, "type", None)
            if kind == "transport":
                received = (received or 0) + int(getattr(stat, "bytesReceived", 0) or 0)
            elif kind == "inbound-rtp" and getattr(stat, "kind", None) == "video":
                rec.packets_lost = max(0, int(getattr(stat, "packetsLost", 0) or 0))
        if received is None:
            return
        t = mono_s()
        if peer.last_bytes is not None and peer.last_bytes_t is not None and t > peer.last_bytes_t:
            rec.bitrate_kbps = max(0.0, (received - peer.last_bytes) * 8 / (t - peer.last_bytes_t) / 1000)
        peer.last_bytes, peer.last_bytes_t = received, t

    # -- teardown ----------------------------------------------------------

    def pipeline_for(self, camera_id: str) -> CameraPipeline | None:
        peer = self.peers.get(camera_id)
        return peer.pipeline if peer else None

    async def close(self, camera_id: str, keep_record: bool = True, emit: bool = True) -> None:
        peer = self.peers.pop(camera_id, None)
        if peer is not None:
            peer.closing = True
            if peer.pipeline:
                peer.pipeline.stop()
            for task in peer.tasks:
                task.cancel()
            for task in peer.tasks:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            with contextlib.suppress(Exception):
                await peer.pc.close()

        rec = self.registry.get(camera_id)
        if rec is None:
            return
        if keep_record:
            rec.status = "offline"
            rec.connection_state = "closed"
            rec.offline_since_s = rec.offline_since_s or now_s()
            rec.capture_fps = rec.process_fps = rec.bitrate_kbps = 0.0
            if emit:
                self._emit(rec)
        else:
            self.registry.remove(camera_id)
            if emit:
                self.hub.broadcast({"type": "camera_removed", "camera_id": camera_id})

    async def shutdown(self) -> None:
        for camera_id in list(self.peers):
            await self.close(camera_id, keep_record=True, emit=False)
        self.executor.shutdown(wait=False, cancel_futures=True)
