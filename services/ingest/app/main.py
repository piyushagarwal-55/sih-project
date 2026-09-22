"""FastAPI app: REST for pairing and config, WebSocket for live dashboard state (PRD §60-61)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .clock import now_ms, now_s
from .config import DATA_DIR, settings
from .hub import DashboardHub
from .models import (
    AnswerResponse,
    CameraState,
    CreateSessionRequest,
    IceServer,
    JoinInfo,
    NetworkInfo,
    OfferRequest,
    PairingSession,
)
from .network import lan_ipv4s, suggested_base_url
from .registry import CameraRegistry, RegistryFull
from .rtc import RtcManager
from .sessions import SessionManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(name)s: %(message)s")
logging.getLogger("aioice").setLevel(logging.WARNING)
logging.getLogger("aiortc").setLevel(logging.WARNING)
log = logging.getLogger("ingest")


class State:
    registry: CameraRegistry
    sessions: SessionManager
    hub: DashboardHub
    rtc: RtcManager


state = State()


async def _sweep() -> None:
    """Expire unused QR codes, and free slots of cameras that have been offline too long."""
    while True:
        await asyncio.sleep(5)
        for s in state.sessions.sweep():
            state.hub.broadcast({"type": "session_update", "session": s.to_model().model_dump()})
        t = now_s()
        for rec in state.registry.all():
            if rec.status == "offline" and rec.offline_since_s and t - rec.offline_since_s > settings.offline_ttl_seconds:
                log.info("%s: offline for %ds, freeing the slot", rec.camera_id, settings.offline_ttl_seconds)
                await state.rtc.close(rec.camera_id, keep_record=False)
                state.sessions.forget_camera(rec.camera_id)
                state.sessions.save()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    state.registry = CameraRegistry(settings.max_cameras)
    state.sessions = SessionManager(state.registry, settings.session_ttl_seconds, DATA_DIR / "sessions.json")
    state.hub = DashboardHub()
    state.rtc = RtcManager(state.registry, state.hub, settings)
    restored = state.sessions.load()
    sweeper = asyncio.create_task(_sweep())
    base = suggested_base_url(settings.public_base_url, settings.web_scheme, settings.web_port)
    log.info("ingest ready: process_fps=%d max_cameras=%d phones join via %s", settings.process_fps, settings.max_cameras, base)
    if restored:
        log.info("restored %d camera pairing(s); those phones will reconnect on their own", restored)
    try:
        yield
    finally:
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper
        await state.rtc.shutdown()
        await state.hub.close()


app = FastAPI(title="Divya Drishti ingest", version="0.1.0", lifespan=lifespan)

# The phone reaches us through the Next.js proxy (same origin), and the
# dashboard runs on localhost. Open CORS is fine for a local prototype.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# -- health / config ----------------------------------------------------------


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "cameras": len(state.registry.all()),
        "live": sum(1 for r in state.registry.all() if r.status == "live"),
        "dashboards": state.hub.client_count,
        "server_time_ms": now_ms(),
    }


@app.get("/api/network", response_model=NetworkInfo)
async def network() -> NetworkInfo:
    return NetworkInfo(
        lan_ips=lan_ipv4s(),
        public_base_url=settings.public_base_url or None,
        suggested_base_url=suggested_base_url(settings.public_base_url, settings.web_scheme, settings.web_port),
    )


# -- pairing ------------------------------------------------------------------


@app.post("/api/sessions", response_model=PairingSession)
async def create_session(body: CreateSessionRequest | None = None) -> PairingSession:
    base = (body.base_url if body and body.base_url else "").strip().rstrip("/")
    if not base:
        base = suggested_base_url(settings.public_base_url, settings.web_scheme, settings.web_port)
    if not base.startswith(("http://", "https://")):
        raise HTTPException(422, "base_url must start with http:// or https://")
    try:
        session = state.sessions.create(base)
    except RegistryFull as exc:
        raise HTTPException(409, str(exc)) from exc
    log.info("pairing session for %s -> %s", session.camera_id, session.join_url)
    return session.to_model()


@app.get("/api/sessions/{token}", response_model=JoinInfo)
async def join_info(token: str) -> JoinInfo:
    session = state.sessions.get(token)
    if session is None:
        raise HTTPException(404, "This QR code has expired or was already removed. Scan a fresh one.")
    return JoinInfo(
        token=session.token,
        camera_id=session.camera_id,
        ice_servers=[IceServer(**s) for s in settings.ice_servers()],
        server_time_ms=now_ms(),
        status=session.status,
    )


@app.delete("/api/sessions/{token}")
async def cancel_session(token: str) -> dict:
    """The dashboard closed its QR dialog. Free the reserved slot unless a phone already joined."""
    return {"ok": True, "cancelled": state.sessions.cancel(token)}


@app.post("/api/rtc/offer", response_model=AnswerResponse)
async def rtc_offer(req: OfferRequest) -> AnswerResponse:
    session = state.sessions.claim(req.token)
    if session is None:
        raise HTTPException(404, "This QR code has expired. Scan a fresh one.")
    try:
        answer = await state.rtc.accept_offer(session.camera_id, req)
    except Exception as exc:
        log.exception("%s: offer failed", session.camera_id)
        raise HTTPException(400, f"Could not accept the WebRTC offer: {exc}") from exc
    state.sessions.save()
    state.hub.broadcast({"type": "session_update", "session": session.to_model().model_dump()})
    return answer


# -- cameras ------------------------------------------------------------------


@app.get("/api/cameras", response_model=list[CameraState])
async def list_cameras() -> list[CameraState]:
    return state.registry.states()


@app.delete("/api/cameras/{camera_id}")
async def remove_camera(camera_id: str) -> dict:
    if state.registry.get(camera_id) is None:
        raise HTTPException(404, f"{camera_id} is not registered")
    await state.rtc.close(camera_id, keep_record=False)
    state.sessions.forget_camera(camera_id)
    state.sessions.save()
    return {"ok": True, "camera_id": camera_id}


@app.get("/api/cameras/{camera_id}/snapshot.jpg")
async def snapshot(camera_id: str) -> Response:
    pipeline = state.rtc.pipeline_for(camera_id)
    latest = pipeline.buffer.latest() if pipeline else None
    if latest is None:
        raise HTTPException(404, f"no frame from {camera_id} yet")
    return Response(content=latest.jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/cameras/{camera_id}/buffer")
async def buffer_info(camera_id: str) -> dict:
    pipeline = state.rtc.pipeline_for(camera_id)
    if pipeline is None:
        raise HTTPException(404, f"{camera_id} has no active pipeline")
    b = pipeline.buffer
    return {"camera_id": camera_id, "frames": len(b), "span_seconds": round(b.span_seconds, 2), "size_bytes": b.size_bytes}


# -- dashboard websocket ------------------------------------------------------


@app.websocket("/ws/dashboard")
async def dashboard(ws: WebSocket) -> None:
    await ws.accept()
    client = await state.hub.attach(
        ws,
        {"type": "snapshot", "cameras": [c.model_dump() for c in state.registry.states()], "server_time_ms": now_ms()},
    )
    try:
        while True:
            # The dashboard does not need to talk back yet; reading keeps the
            # socket alive and notices when the tab closes.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        state.hub.detach(client)
