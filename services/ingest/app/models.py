"""Wire schemas. Mirrored in packages/contracts/src/index.ts, keep them in step."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

CameraStatus = Literal["pending", "connecting", "live", "degraded", "offline"]
SessionStatus = Literal["waiting", "claimed", "expired"]


class QualityReport(BaseModel):
    blur: float
    brightness: float
    integrity: float
    score: float
    frozen: bool = False


class CaptureInfo(BaseModel):
    width: int = 0
    height: int = 0
    fps: float = 0
    facing: Literal["environment", "user", "unknown"] = "unknown"


class CameraState(BaseModel):
    camera_id: str
    device_name: str
    status: CameraStatus
    connection_state: str = "new"
    connected_at: str | None = None
    last_frame_at: str | None = None
    capture: CaptureInfo | None = None
    decoded_width: int = 0
    decoded_height: int = 0
    capture_fps: float = 0
    process_fps: float = 0
    frames_received: int = 0
    frames_processed: int = 0
    frames_skipped: int = 0
    bitrate_kbps: float = 0
    packets_lost: int = 0
    rtt_ms: float | None = None
    clock_offset_ms: float | None = None
    quality: QualityReport | None = None
    codec: str | None = None


class IceServer(BaseModel):
    urls: str | list[str]
    username: str | None = None
    credential: str | None = None


class PairingSession(BaseModel):
    token: str
    camera_id: str
    join_url: str
    expires_at: str
    status: SessionStatus


class JoinInfo(BaseModel):
    token: str
    camera_id: str
    ice_servers: list[IceServer]
    server_time_ms: int
    status: SessionStatus


class OfferRequest(BaseModel):
    token: str
    sdp: str
    type: Literal["offer"] = "offer"
    device_name: str = Field(default="Phone", max_length=60)
    capture: CaptureInfo = Field(default_factory=CaptureInfo)
    client_time_ms: int = 0


class AnswerResponse(BaseModel):
    sdp: str
    type: Literal["answer"] = "answer"
    camera_id: str


class CreateSessionRequest(BaseModel):
    # The dashboard can override the base URL (for example a fresh ngrok URL)
    # without restarting the backend.
    base_url: str | None = None


class NetworkInfo(BaseModel):
    lan_ips: list[str]
    public_base_url: str | None
    suggested_base_url: str
