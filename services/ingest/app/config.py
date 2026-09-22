"""Runtime settings, read once from the environment (and the repo-root .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

SERVICE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVICE_DIR.parent.parent
DATA_DIR = SERVICE_DIR / "data"

# Repo root first, then a service-local override if someone adds one.
load_dotenv(REPO_ROOT / ".env")
load_dotenv(SERVICE_DIR / ".env", override=True)


def _int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else default


def _str(name: str, default: str = "") -> str:
    return os.getenv(name, "").strip() or default


def _list(name: str, default: str) -> list[str]:
    return [p.strip() for p in _str(name, default).split(",") if p.strip()]


@dataclass(frozen=True)
class Settings:
    host: str = field(default_factory=lambda: _str("INGEST_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _int("INGEST_PORT", 8000))

    # Where phones load the camera page from. Empty -> https://<lan-ip>:<web_port>
    public_base_url: str = field(default_factory=lambda: _str("PUBLIC_BASE_URL").rstrip("/"))
    web_port: int = field(default_factory=lambda: _int("WEB_PORT", 3000))
    web_scheme: str = field(default_factory=lambda: _str("WEB_SCHEME", "https"))

    # PRD §8: capture FPS and processing FPS are separate concepts.
    process_fps: int = field(default_factory=lambda: _int("PROCESS_FPS", 12))
    preview_width: int = field(default_factory=lambda: _int("PREVIEW_WIDTH", 640))
    jpeg_quality: int = field(default_factory=lambda: _int("JPEG_QUALITY", 72))

    # PRD §13: rolling buffer kept independently of inference.
    buffer_seconds: int = field(default_factory=lambda: _int("BUFFER_SECONDS", 10))

    max_cameras: int = field(default_factory=lambda: _int("MAX_CAMERAS", 12))
    session_ttl_seconds: int = field(default_factory=lambda: _int("SESSION_TTL_SECONDS", 600))
    # An offline camera keeps its slot (so the phone can reconnect as the same
    # CAMnn) for this long, then the slot is freed.
    offline_ttl_seconds: int = field(default_factory=lambda: _int("OFFLINE_TTL_SECONDS", 900))

    stun_urls: list[str] = field(default_factory=lambda: _list("STUN_URLS", "stun:stun.l.google.com:19302"))
    turn_url: str = field(default_factory=lambda: _str("TURN_URL"))
    turn_username: str = field(default_factory=lambda: _str("TURN_USERNAME"))
    turn_credential: str = field(default_factory=lambda: _str("TURN_CREDENTIAL"))

    def ice_servers(self) -> list[dict]:
        servers: list[dict] = []
        if self.stun_urls:
            servers.append({"urls": self.stun_urls})
        if self.turn_url:
            servers.append(
                {"urls": [self.turn_url], "username": self.turn_username, "credential": self.turn_credential}
            )
        return servers


settings = Settings()
