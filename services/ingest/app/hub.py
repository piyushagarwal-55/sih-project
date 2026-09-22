"""Dashboard fan-out over WebSocket (PRD §60).

WebRTC carries media phone -> backend. This hub carries *state* backend ->
dashboard: JSON for camera/session changes, binary for preview frames.

Backpressure rule: a slow dashboard must never slow ingestion. Each client
keeps exactly one pending frame per camera; a newer frame overwrites an unsent
older one. JSON state messages are small and are queued in order.
"""

from __future__ import annotations

import asyncio
import json
import logging
import struct
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("ingest.hub")

HEADER_LEN = struct.Struct(">I")


def encode_frame(header: dict[str, Any], jpeg: bytes) -> bytes:
    """[uint32 BE header length][JSON header][JPEG]. Decoded by @divya/contracts."""
    head = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return HEADER_LEN.pack(len(head)) + head + jpeg


class _Client:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.messages: asyncio.Queue[str] = asyncio.Queue(maxsize=512)
        self.frames: dict[str, bytes] = {}
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.frames_sent = 0
        self.frames_dropped = 0

    def push_json(self, text: str) -> None:
        try:
            self.messages.put_nowait(text)
        except asyncio.QueueFull:
            # Something is badly wrong with this client; it will be dropped by
            # the sender when the next send fails.
            log.warning("dashboard client message queue full; dropping state message")
        self.wake.set()

    def push_frame(self, camera_id: str, payload: bytes) -> None:
        if camera_id in self.frames:
            self.frames_dropped += 1
        self.frames[camera_id] = payload
        self.wake.set()

    async def run(self) -> None:
        while True:
            await self.wake.wait()
            self.wake.clear()
            while not self.messages.empty():
                await self.ws.send_text(self.messages.get_nowait())
            while self.frames:
                camera_id, payload = self.frames.popitem()
                await self.ws.send_bytes(payload)
                self.frames_sent += 1
                # Let fresh state messages jump ahead of the next frame.
                while not self.messages.empty():
                    await self.ws.send_text(self.messages.get_nowait())


class DashboardHub:
    def __init__(self) -> None:
        self._clients: set[_Client] = set()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def attach(self, ws: WebSocket, first_message: dict[str, Any]) -> _Client:
        client = _Client(ws)
        client.push_json(json.dumps(first_message, separators=(",", ":")))
        client.task = asyncio.create_task(self._drive(client))
        self._clients.add(client)
        log.info("dashboard connected (%d total)", len(self._clients))
        return client

    async def _drive(self, client: _Client) -> None:
        try:
            await client.run()
        except Exception as exc:  # noqa: BLE001 - any send failure means the socket is gone
            log.debug("dashboard sender stopped: %s", exc)
        finally:
            self._clients.discard(client)

    def detach(self, client: _Client) -> None:
        self._clients.discard(client)
        if client.task and not client.task.done():
            client.task.cancel()
        log.info("dashboard disconnected (%d total)", len(self._clients))

    def broadcast(self, message: dict[str, Any]) -> None:
        if not self._clients:
            return
        text = json.dumps(message, separators=(",", ":"))
        for client in list(self._clients):
            client.push_json(text)

    def publish_frame(self, camera_id: str, header: dict[str, Any], jpeg: bytes) -> None:
        if not self._clients:
            return
        payload = encode_frame(header, jpeg)
        for client in list(self._clients):
            client.push_frame(camera_id, payload)

    async def close(self) -> None:
        for client in list(self._clients):
            self.detach(client)
            try:
                await client.ws.close()
            except Exception:  # noqa: BLE001
                pass
