"""Camera registry (PRD §14).

One record per camera node. Physical fields (position, height, yaw, FOV,
calibration) are placeholders here; the calibration module fills them later.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .clock import iso
from .models import CameraState, CameraStatus, CaptureInfo, QualityReport


@dataclass
class CameraRecord:
    camera_id: str
    device_name: str = "Phone"
    status: CameraStatus = "pending"
    connection_state: str = "new"
    connected_at_s: float | None = None
    last_frame_at_s: float | None = None
    capture: CaptureInfo | None = None
    decoded_width: int = 0
    decoded_height: int = 0
    capture_fps: float = 0.0
    process_fps: float = 0.0
    frames_received: int = 0
    frames_processed: int = 0
    frames_skipped: int = 0
    bitrate_kbps: float = 0.0
    packets_lost: int = 0
    rtt_ms: float | None = None
    clock_offset_ms: float | None = None
    quality: QualityReport | None = None
    codec: str | None = None
    token: str | None = None
    offline_since_s: float | None = None

    # PRD §14 physical registry fields, filled by calibration later.
    position: dict[str, float] = field(default_factory=dict)
    height_m: float | None = None
    yaw_deg: float | None = None
    fov_deg: float | None = None
    homography: list[list[float]] | None = None

    def to_state(self) -> CameraState:
        return CameraState(
            camera_id=self.camera_id,
            device_name=self.device_name,
            status=self.status,
            connection_state=self.connection_state,
            connected_at=iso(self.connected_at_s),
            last_frame_at=iso(self.last_frame_at_s),
            capture=self.capture,
            decoded_width=self.decoded_width,
            decoded_height=self.decoded_height,
            capture_fps=round(self.capture_fps, 1),
            process_fps=round(self.process_fps, 1),
            frames_received=self.frames_received,
            frames_processed=self.frames_processed,
            frames_skipped=self.frames_skipped,
            bitrate_kbps=round(self.bitrate_kbps, 1),
            packets_lost=self.packets_lost,
            rtt_ms=None if self.rtt_ms is None else round(self.rtt_ms, 1),
            clock_offset_ms=None if self.clock_offset_ms is None else round(self.clock_offset_ms, 1),
            quality=self.quality,
            codec=self.codec,
        )


class RegistryFull(Exception):
    pass


class CameraRegistry:
    def __init__(self, max_cameras: int) -> None:
        self.max_cameras = max_cameras
        self._cameras: dict[str, CameraRecord] = {}
        self._reserved: set[str] = set()

    def allocate_id(self) -> str:
        """Lowest free CAMnn that is neither registered nor reserved by a pending QR."""
        taken = set(self._cameras) | self._reserved
        for n in range(1, self.max_cameras + 1):
            cid = f"CAM{n:02d}"
            if cid not in taken:
                self._reserved.add(cid)
                return cid
        raise RegistryFull(f"all {self.max_cameras} camera slots are in use")

    def release(self, camera_id: str) -> None:
        self._reserved.discard(camera_id)

    def ensure(self, camera_id: str) -> CameraRecord:
        self._reserved.discard(camera_id)
        rec = self._cameras.get(camera_id)
        if rec is None:
            rec = CameraRecord(camera_id=camera_id)
            self._cameras[camera_id] = rec
        return rec

    def get(self, camera_id: str) -> CameraRecord | None:
        return self._cameras.get(camera_id)

    def remove(self, camera_id: str) -> CameraRecord | None:
        self._reserved.discard(camera_id)
        return self._cameras.pop(camera_id, None)

    def all(self) -> list[CameraRecord]:
        return [self._cameras[k] for k in sorted(self._cameras)]

    def states(self) -> list[CameraState]:
        return [r.to_state() for r in self.all()]
