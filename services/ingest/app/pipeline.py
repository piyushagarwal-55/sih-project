"""Per-camera frame pipeline (PRD §7-13).

    WebRTC track -> decoded av.VideoFrame -> stamp -> schedule -> BGR ndarray
                 -> quality -> preview JPEG -> rolling buffer + dashboard + sinks

Two rules keep this real-time with several phones on one asyncio loop:

1. `track.recv()` is drained continuously. Stop draining and aiortc's jitter
   buffer grows, and the feed falls further and further behind reality.
2. Heavy work (colour conversion, quality, JPEG) runs in a thread pool, and at
   most one job per camera is in flight. If the previous job is still running,
   the new frame is counted as skipped rather than queued ("latest frame wins").
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import Callable
from concurrent.futures import Executor
from dataclasses import dataclass
from fractions import Fraction

import cv2
import numpy as np
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack

from .buffer import BufferedFrame, RollingBuffer
from .clock import mono_s, now_s
from .config import Settings
from .hub import DashboardHub
from .models import QualityReport
from .quality import FrozenDetector, assess
from .registry import CameraRecord
from .scheduler import FrameScheduler

log = logging.getLogger("ingest.pipeline")


@dataclass(frozen=True)
class FramePacket:
    """Everything later stages need to know about one processed frame (PRD §9)."""

    camera_id: str
    frame_id: int
    pts_ms: float | None  # stream time from RTP
    ts_s: float  # canonical backend wall-clock receive time
    mono_s: float  # monotonic receive time, for intervals
    width: int
    height: int
    quality: QualityReport


# A sink receives the full-resolution BGR frame. Detection and tracking will
# register here next; for now nothing does. Sinks run in the worker thread.
FrameSink = Callable[[FramePacket, np.ndarray], None]


class RateMeter:
    """Events per second over a sliding window."""

    def __init__(self, window_s: float = 2.0) -> None:
        self.window = window_s
        self._ticks: deque[float] = deque()

    def tick(self, t: float) -> None:
        self._ticks.append(t)
        self._trim(t)

    def rate(self, t: float) -> float:
        self._trim(t)
        if len(self._ticks) < 2:
            return float(len(self._ticks))
        return (len(self._ticks) - 1) / max(self._ticks[-1] - self._ticks[0], 1e-3)

    def _trim(self, t: float) -> None:
        cutoff = t - self.window
        while self._ticks and self._ticks[0] < cutoff:
            self._ticks.popleft()


@dataclass
class _WorkResult:
    quality: QualityReport
    jpeg: bytes
    preview_w: int
    preview_h: int


def _pts_ms(pts: int | None, time_base: Fraction | None) -> float | None:
    if pts is None or time_base is None:
        return None
    return round(float(pts * time_base) * 1000.0, 1)


class CameraPipeline:
    def __init__(
        self,
        record: CameraRecord,
        track: MediaStreamTrack,
        hub: DashboardHub,
        settings: Settings,
        executor: Executor,
    ) -> None:
        self.record = record
        self.track = track
        self.hub = hub
        self.settings = settings
        self.executor = executor
        self.scheduler = FrameScheduler(settings.process_fps)
        self.buffer = RollingBuffer(settings.buffer_seconds)
        self.frozen = FrozenDetector()
        self.sinks: list[FrameSink] = []
        self.recv_rate = RateMeter()
        self.proc_rate = RateMeter()
        self._frame_id = 0
        self._in_flight: asyncio.Task | None = None
        self._stopped = False

    # -- receive loop ------------------------------------------------------

    async def run(self) -> None:
        rec = self.record
        log.info("%s: pipeline started", rec.camera_id)
        try:
            while not self._stopped:
                frame = await self.track.recv()
                t_mono, t_wall = mono_s(), now_s()
                self._frame_id += 1
                rec.frames_received += 1
                rec.last_frame_at_s = t_wall
                rec.decoded_width, rec.decoded_height = frame.width, frame.height
                self.recv_rate.tick(t_mono)

                busy = self._in_flight is not None and not self._in_flight.done()
                if busy or not self.scheduler.should_process(t_mono):
                    rec.frames_skipped += 1
                    continue

                self._in_flight = asyncio.create_task(
                    self._process(frame, self._frame_id, _pts_ms(frame.pts, frame.time_base), t_wall, t_mono)
                )
        except MediaStreamError:
            log.info("%s: track ended", rec.camera_id)
        except asyncio.CancelledError:
            raise
        finally:
            self._stopped = True
            log.info("%s: pipeline stopped after %d frames", rec.camera_id, rec.frames_received)

    def stop(self) -> None:
        self._stopped = True

    # -- processing --------------------------------------------------------

    async def _process(self, frame, frame_id: int, pts_ms: float | None, ts_s: float, t_mono: float) -> None:
        loop = asyncio.get_running_loop()
        try:
            result: _WorkResult = await loop.run_in_executor(
                self.executor, self._work, frame, frame_id, pts_ms, ts_s, t_mono
            )
        except Exception:  # noqa: BLE001 - one bad frame must not kill the camera
            log.exception("%s: frame %d failed", self.record.camera_id, frame_id)
            return

        rec = self.record
        rec.frames_processed += 1
        rec.quality = result.quality
        self.proc_rate.tick(mono_s())

        self.buffer.push(BufferedFrame(frame_id=frame_id, ts_s=ts_s, pts_ms=pts_ms, jpeg=result.jpeg))
        self.hub.publish_frame(
            rec.camera_id,
            {
                "camera_id": rec.camera_id,
                "frame_id": frame_id,
                "pts_ms": pts_ms,
                "ts_ms": int(ts_s * 1000),
                "width": result.preview_w,
                "height": result.preview_h,
                "quality": result.quality.model_dump(),
            },
            result.jpeg,
        )

    def _work(self, frame, frame_id: int, pts_ms: float | None, ts_s: float, t_mono: float) -> _WorkResult:
        """Runs in a worker thread. At most one call per camera at a time."""
        bgr = frame.to_ndarray(format="bgr24")
        quality = assess(bgr, self.frozen, t_mono)

        h, w = bgr.shape[:2]
        target_w = min(self.settings.preview_width, w)
        if target_w < w:
            preview = cv2.resize(bgr, (target_w, int(h * target_w / w)), interpolation=cv2.INTER_AREA)
        else:
            preview = bgr
        ok, enc = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, self.settings.jpeg_quality])
        if not ok:
            raise RuntimeError("JPEG encode failed")

        if self.sinks:
            packet = FramePacket(
                camera_id=self.record.camera_id,
                frame_id=frame_id,
                pts_ms=pts_ms,
                ts_s=ts_s,
                mono_s=t_mono,
                width=w,
                height=h,
                quality=quality,
            )
            for sink in self.sinks:
                try:
                    sink(packet, bgr)
                except Exception:  # noqa: BLE001
                    log.exception("%s: sink %r failed", self.record.camera_id, sink)

        return _WorkResult(quality=quality, jpeg=enc.tobytes(), preview_w=preview.shape[1], preview_h=preview.shape[0])
