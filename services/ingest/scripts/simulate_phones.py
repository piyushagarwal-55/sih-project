"""Pretend to be N phones, over real WebRTC, and optionally verify the dashboard sees them.

Each simulated phone does exactly what the browser camera page does:
    POST /api/sessions -> GET /api/sessions/{token} -> WebRTC offer with a video
    track and a "telemetry" data channel -> answer pings with pongs.

Usage (with the ingest service running):
    uv run python scripts/simulate_phones.py                 # 3 phones, forever
    uv run python scripts/simulate_phones.py --count 3 --seconds 12 --verify

With --verify it also connects to /ws/dashboard as a dashboard would, counts the
binary preview frames per camera, and exits non-zero if any camera falls short.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import struct
import sys
import time
from fractions import Fraction

import av
import cv2
import httpx
import numpy as np
import websockets
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack

COLOURS = [(42, 71, 226), (192, 101, 21), (132, 122, 13), (208, 34, 101), (9, 83, 180), (60, 122, 27)]


class PatternTrack(VideoStreamTrack):
    """A moving, noisy test pattern so the quality and frozen detectors see a live scene."""

    def __init__(self, label: str, width: int, height: int, fps: int, colour: tuple[int, int, int]) -> None:
        super().__init__()
        self.label, self.w, self.h, self.fps, self.colour = label, width, height, fps, colour
        self._n = 0
        self._start = time.monotonic()
        self._rng = np.random.default_rng()
        yy, xx = np.mgrid[0:height, 0:width]
        self._base = ((xx / width) * 90 + (yy / height) * 50).astype(np.uint8)

    async def recv(self) -> av.VideoFrame:
        # Pace ourselves to the requested FPS, like a real camera would.
        self._n += 1
        target = self._start + self._n / self.fps
        delay = target - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

        t = self._n / self.fps
        img = np.dstack([self._base, self._base // 2 + 40, 255 - self._base]).copy()
        cx = int(self.w * (0.5 + 0.38 * math.sin(t * 0.9)))
        cy = int(self.h * (0.5 + 0.30 * math.cos(t * 1.3)))
        cv2.circle(img, (cx, cy), self.h // 8, self.colour, -1)
        cv2.rectangle(img, (40, 40), (self.w - 40, self.h - 40), (255, 255, 255), 3)
        for i in range(0, self.w, 80):  # a grid gives the blur metric real edges
            cv2.line(img, (i, 0), (i, self.h), (230, 230, 230), 1)
        cv2.putText(img, self.label, (70, 130), cv2.FONT_HERSHEY_SIMPLEX, 2.4, (255, 255, 255), 5, cv2.LINE_AA)
        cv2.putText(img, f"frame {self._n}  {time.strftime('%H:%M:%S')}", (70, self.h - 80),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3, cv2.LINE_AA)
        noise = self._rng.integers(0, 6, img.shape, dtype=np.uint8)
        img = cv2.add(img, noise)

        frame = av.VideoFrame.from_ndarray(img, format="bgr24")
        frame.pts = self._n * (90000 // self.fps)
        frame.time_base = Fraction(1, 90000)
        return frame


async def wait_ice_complete(pc: RTCPeerConnection) -> None:
    # aiortc gathers inside setLocalDescription, so nothing to wait for here;
    # kept for symmetry with the browser client, which must wait.
    return None


async def run_phone(i: int, base: str, seconds: float, width: int, height: int, fps: int, stop: asyncio.Event) -> str:
    async with httpx.AsyncClient(base_url=base, timeout=30) as http:
        session = (await http.post("/api/sessions", json={})).raise_for_status().json()
        token, camera_id = session["token"], session["camera_id"]
        info = (await http.get(f"/api/sessions/{token}")).raise_for_status().json()

        ice = [RTCIceServer(**s) for s in info["ice_servers"]]
        pc = RTCPeerConnection(RTCConfiguration(iceServers=ice))
        pc.addTrack(PatternTrack(f"SIM {camera_id}", width, height, fps, COLOURS[i % len(COLOURS)]))

        channel = pc.createDataChannel("telemetry")

        @channel.on("message")
        def on_message(message: str) -> None:
            msg = json.loads(message)
            if msg.get("type") == "ping":
                t1 = int(time.time() * 1000)
                channel.send(json.dumps({"type": "pong", "t0": msg["t0"], "t1": t1,
                                         "t2": int(time.time() * 1000), "seq": msg["seq"]}))

        @channel.on("open")
        def on_open() -> None:
            channel.send(json.dumps({"type": "status", "battery": None, "charging": None, "visible": True,
                                     "capture": {"width": width, "height": height, "fps": fps, "facing": "environment"}}))

        await pc.setLocalDescription(await pc.createOffer())
        await wait_ice_complete(pc)
        answer = (await http.post("/api/rtc/offer", json={
            "token": token,
            "sdp": pc.localDescription.sdp,
            "type": "offer",
            "device_name": f"Simulated phone {i + 1}",
            "capture": {"width": width, "height": height, "fps": fps, "facing": "environment"},
            "client_time_ms": int(time.time() * 1000),
        })).raise_for_status().json()
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))
        print(f"[sim] {camera_id} publishing {width}x{height}@{fps} (token {token})", flush=True)

        try:
            if seconds > 0:
                await asyncio.wait_for(stop.wait(), timeout=seconds)
            else:
                await stop.wait()
        except asyncio.TimeoutError:
            pass
        finally:
            await pc.close()
        return camera_id


async def watch_dashboard(ws_url: str, seconds: float, result: dict) -> None:
    frames: dict[str, int] = {}
    last_state: dict[str, dict] = {}
    first_ts: dict[str, float] = {}
    async with websockets.connect(ws_url, max_size=None) as ws:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.monotonic()))
            except asyncio.TimeoutError:
                break
            if isinstance(msg, bytes):
                (n,) = struct.unpack(">I", msg[:4])
                header = json.loads(msg[4:4 + n])
                cid = header["camera_id"]
                frames[cid] = frames.get(cid, 0) + 1
                first_ts.setdefault(cid, time.monotonic())
                # The JPEG must decode, or the dashboard would show nothing.
                img = cv2.imdecode(np.frombuffer(msg[4 + n:], np.uint8), cv2.IMREAD_COLOR)
                if img is None:
                    result.setdefault("bad_jpeg", 0)
                    result["bad_jpeg"] += 1
            else:
                data = json.loads(msg)
                if data["type"] == "camera_update":
                    last_state[data["camera"]["camera_id"]] = data["camera"]
                elif data["type"] == "snapshot":
                    for cam in data["cameras"]:
                        last_state[cam["camera_id"]] = cam
    result["frames"] = frames
    result["state"] = last_state
    result["first_ts"] = first_ts


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--seconds", type=float, default=0, help="0 runs until Ctrl+C")
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--height", type=int, default=540)
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--verify", action="store_true", help="watch the dashboard socket and assert frames arrive")
    args = ap.parse_args()

    if args.verify and args.seconds <= 0:
        args.seconds = 12

    stop = asyncio.Event()
    phones = [asyncio.create_task(run_phone(i, args.base, args.seconds, args.width, args.height, args.fps, stop))
              for i in range(args.count)]

    result: dict = {}
    watcher = None
    if args.verify:
        ws_url = args.base.replace("http", "ws", 1) + "/ws/dashboard"
        # Give the peers a moment to connect, then watch for most of the run.
        await asyncio.sleep(2.0)
        watcher = asyncio.create_task(watch_dashboard(ws_url, args.seconds - 3.0, result))

    try:
        camera_ids = await asyncio.gather(*phones)
    except KeyboardInterrupt:
        stop.set()
        return 0
    if watcher:
        await watcher

    if not args.verify:
        return 0

    window = max(args.seconds - 3.0, 1.0)
    print("\n=== dashboard verification ===")
    failures = 0
    for cid in camera_ids:
        n = result.get("frames", {}).get(cid, 0)
        st = result.get("state", {}).get(cid, {})
        q = st.get("quality") or {}
        fps = n / window
        ok = fps >= 3.0
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {cid}: {n} preview frames (~{fps:.1f}/s) | status={st.get('status')} "
              f"capture_fps={st.get('capture_fps')} process_fps={st.get('process_fps')} codec={st.get('codec')} "
              f"decoded={st.get('decoded_width')}x{st.get('decoded_height')} bitrate={st.get('bitrate_kbps')}kbps "
              f"rtt={st.get('rtt_ms')}ms offset={st.get('clock_offset_ms')}ms "
              f"quality={q.get('score')} blur={q.get('blur')} frozen={q.get('frozen')}")
    if result.get("bad_jpeg"):
        failures += 1
        print(f"FAIL {result['bad_jpeg']} preview JPEGs did not decode")
    print("RESULT:", "PASS" if failures == 0 else f"FAIL ({failures})")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
