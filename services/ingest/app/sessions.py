"""Pairing sessions: the QR code the dashboard shows is one of these.

A session reserves a camera ID up front so the dashboard can say "this phone
will become CAM03". Once a phone connects, the token stays bound to that camera,
which lets the phone reconnect after a network blip and keep the same identity.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from .clock import iso, now_s
from .models import PairingSession, SessionStatus
from .registry import CameraRegistry

log = logging.getLogger("ingest.sessions")


@dataclass
class Session:
    token: str
    camera_id: str
    base_url: str
    created_s: float
    expires_s: float
    status: SessionStatus = "waiting"

    @property
    def join_url(self) -> str:
        return f"{self.base_url}/camera/{self.token}"

    def to_model(self) -> PairingSession:
        return PairingSession(
            token=self.token,
            camera_id=self.camera_id,
            join_url=self.join_url,
            expires_at=iso(self.expires_s) or "",
            status=self.status,
        )


class SessionManager:
    """Claimed sessions are persisted, so a backend restart (every save under
    `--reload`) does not orphan the phones: they reconnect with their token and
    come back as the same CAMnn without anyone rescanning a QR code."""

    def __init__(self, registry: CameraRegistry, ttl_seconds: int, store: Path | None = None) -> None:
        self.registry = registry
        self.ttl = ttl_seconds
        self.store = store
        self._by_token: dict[str, Session] = {}

    # -- persistence -----------------------------------------------------------

    def load(self) -> int:
        """Restore claimed sessions and show their cameras as offline until they reconnect."""
        if not self.store or not self.store.exists():
            return 0
        try:
            rows = json.loads(self.store.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("ignoring unreadable %s: %s", self.store, exc)
            return 0
        t = now_s()
        restored = 0
        for row in rows:
            try:
                session = Session(
                    token=row["token"],
                    camera_id=row["camera_id"],
                    base_url=row["base_url"],
                    created_s=float(row.get("created_s", t)),
                    expires_s=float(row.get("created_s", t)) + self.ttl,
                    status="claimed",
                )
            except (KeyError, TypeError, ValueError):
                continue
            rec = self.registry.ensure(session.camera_id)
            rec.device_name = row.get("device_name") or rec.device_name
            rec.status = "offline"
            rec.connection_state = "closed"
            rec.offline_since_s = t
            rec.token = session.token
            self._by_token[session.token] = session
            restored += 1
        return restored

    def save(self) -> None:
        if not self.store:
            return
        rows = []
        for s in self._by_token.values():
            if s.status != "claimed":
                continue
            rec = self.registry.get(s.camera_id)
            rows.append({
                "token": s.token,
                "camera_id": s.camera_id,
                "base_url": s.base_url,
                "created_s": s.created_s,
                "device_name": rec.device_name if rec else None,
            })
        try:
            self.store.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.store.with_suffix(".tmp")
            tmp.write_text(json.dumps(rows, indent=2), encoding="utf-8")
            os.replace(tmp, self.store)  # atomic, so a crash never leaves half a file
        except OSError as exc:
            log.warning("could not persist sessions: %s", exc)

    def create(self, base_url: str) -> Session:
        camera_id = self.registry.allocate_id()
        t = now_s()
        session = Session(
            token=secrets.token_urlsafe(9),
            camera_id=camera_id,
            base_url=base_url.rstrip("/"),
            created_s=t,
            expires_s=t + self.ttl,
        )
        self._by_token[session.token] = session
        return session

    def get(self, token: str) -> Session | None:
        return self._by_token.get(token)

    def claim(self, token: str) -> Session | None:
        """Mark a session as used. Claimed sessions never expire (reconnect support)."""
        session = self._by_token.get(token)
        if session is None or session.status == "expired":
            return None
        session.status = "claimed"
        return session

    def cancel(self, token: str) -> bool:
        """Drop a QR that was never scanned and free its camera slot. Claimed sessions are left alone."""
        session = self._by_token.get(token)
        if session is None or session.status != "waiting":
            return False
        del self._by_token[token]
        self.registry.release(session.camera_id)
        return True

    def forget_camera(self, camera_id: str) -> None:
        for token in [t for t, s in self._by_token.items() if s.camera_id == camera_id]:
            del self._by_token[token]

    def sweep(self) -> list[Session]:
        """Expire unclaimed sessions past their TTL, freeing their reserved camera IDs."""
        t = now_s()
        expired: list[Session] = []
        for token, session in list(self._by_token.items()):
            if session.status == "waiting" and t >= session.expires_s:
                session.status = "expired"
                self.registry.release(session.camera_id)
                expired.append(session)
                del self._by_token[token]
        return expired
