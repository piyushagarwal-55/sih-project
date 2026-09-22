# Divya Drishti

Live multi-camera surveillance intelligence for SIH 2026.

**Module 1 (this commit): live camera ingest.** Any phone becomes a camera node by
scanning a QR code. Its rear camera streams over WebRTC to the laptop, where every
frame is decoded, timestamped against one canonical clock, quality-scored, buffered,
and shown live on a command-centre dashboard. Several phones stream at once.

```
 PHONE (browser)                         LAPTOP
 ┌───────────────────┐   HTTPS   ┌────────────────────────────────────────────────────┐
 │ /camera/<token>   │──────────▶│ apps/web  server.mjs  (one origin)                 │
 │ getUserMedia()    │  signalling│   Next.js pages                                   │
 │ RTCPeerConnection │           │   /api/*, /ws/*  ──proxy──▶  services/ingest (Py)   │
 └────────┬──────────┘           │                              FastAPI + aiortc      │
          │  WebRTC media (SRTP, UDP, peer to peer)           │                        │
          └───────────────────────────────────────────────▶ RtcManager                 │
                                                           │   └▶ CameraPipeline × N   │
                                                           │        decode → stamp →   │
                                                           │        schedule → quality │
                                                           │        → JPEG → buffer    │
 DASHBOARD (laptop browser)  ◀── /ws/dashboard ─────────────── DashboardHub          │
   camera grid, live stats       JSON state + binary frames  └────────────────────────┘
```

## Quick start

Everything needed is already installed on this laptop (Node 20, pnpm 10, Python 3.13, uv).

```bash
pnpm bootstrap      # once: JS deps, Python venv, dev HTTPS certificate
pnpm dev:lan        # starts both services, HTTPS on port 3000
```

1. On the laptop open **https://localhost:3000**. Chrome warns about the certificate once:
   **Advanced → Proceed to localhost**.
2. Click **Connect Mobile**. A QR code appears.
3. Scan it with the phone (same Wi-Fi). The phone warns about the certificate too:
   **Advanced → Proceed** (Android) or **Show details → visit this website** (iPhone).
4. Tap **Start camera** and allow camera access.
5. The feed appears on the dashboard. Click **Add another camera** for phone 2, 3, 4...

> Phones only allow the camera on `https://` pages. That is why there is a certificate at
> all. `pnpm dev` (plain http) is for when ngrok provides the HTTPS, see below.

## Three ways to connect phones

| Situation | Command | QR points at |
|---|---|---|
| Phones on the **same Wi-Fi** as the laptop | `pnpm dev:lan` | `https://<laptop-LAN-IP>:3000` (automatic) |
| Phones **cannot reach** the laptop (different network, or Wi-Fi isolates devices) | `pnpm dev` + `ngrok http 3000` | the ngrok `https://…` URL |
| Campus / hostel / office Wi-Fi that **blocks device-to-device** traffic | turn on a **phone hotspot**, join the laptop and the other phones to it, then `pnpm dev:lan` | the hotspot LAN IP |

**About this laptop's network.** It is on `172.22.199.56/21`, which looks like a campus or
office network. Those often enable *client isolation*: phones can reach the internet but not
each other or the laptop. If the phone cannot even open the QR link, that is the cause, and
a phone hotspot is the quickest fix. (Windows Firewall is switched off on this machine, so
it is not what is blocking you.)

### Using ngrok

```bash
pnpm dev                    # terminal 1
ngrok http 3000             # terminal 2 (install from https://ngrok.com/download)
```

In the dashboard, **Connect Mobile → Change address**, paste the `https://….ngrok-free.app`
URL, and click **Use this address**. It is remembered in this browser. Alternatively set
`PUBLIC_BASE_URL` in `.env` (copy `.env.example`).

ngrok carries the page and the signalling. The **video itself still travels directly**
phone → laptop over WebRTC, so the two must be able to reach each other, or you need a
TURN server (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` in `.env`).

## Testing without phones

```bash
pnpm simulate                                         # 3 simulated phones, until Ctrl+C
cd services/ingest && uv run python scripts/simulate_phones.py --count 3 --seconds 15 --verify
```

The simulator is a real aiortc WebRTC client: it pairs through the same API, publishes a
moving test pattern, answers clock-sync pings, and with `--verify` watches the dashboard
socket and fails if any camera's frames do not arrive.

You can also make a laptop browser tab act as a phone: open any QR link with
`?source=test&autostart=1` appended. Keep that tab **visible**; Chrome stops producing
frames from a canvas in a hidden tab (a real camera is not affected).

```bash
pnpm test         # 33 backend unit tests (quality, scheduler, buffer, sessions, API, wire format)
pnpm typecheck    # TypeScript across the workspace
```

## What each part does (and the PRD section it implements)

| PRD | Where | What |
|---|---|---|
| §5 camera acquisition | `apps/web/src/lib/publisher.ts` | `getUserMedia` rear camera, 1280×720 up to 30 FPS, falls back if the phone rejects those constraints, audio off |
| §5.2 registration | `services/ingest/app/sessions.py`, `registry.py` | QR token reserves `CAMnn`; the WebRTC connection is bound to it |
| §6 WebRTC transport | `publisher.ts` → `app/rtc.py` | Phone sends video only; aiortc receives. H.264 preferred (hardware encoder on phones), VP8 fallback |
| §7 decoding | `app/pipeline.py` | aiortc decodes; frames become BGR arrays for OpenCV |
| §8 frame scheduling | `app/scheduler.py` | Every frame is received; only `PROCESS_FPS` (default 12) go through processing |
| §9 timestamping | `app/pipeline.py`, `app/clock.py` | Each frame keeps its RTP PTS **and** a canonical backend wall-clock time |
| §10 clock sync | `app/rtc.py` telemetry channel | NTP-style ping/pong over a data channel gives each phone's RTT and clock offset |
| §11-12 preprocessing, quality | `app/quality.py` | Blur (Laplacian variance), brightness, integrity, frozen-feed detection → one score |
| §13 rolling buffer | `app/buffer.py` | Last `BUFFER_SECONDS` of frames per camera, ready for evidence clips |
| §14 camera registry | `app/registry.py` | One record per camera; position, yaw, FOV and homography fields are ready for calibration |
| §60 live state | `app/hub.py`, `apps/web/src/lib/useIngest.ts` | WebSocket: JSON for state, binary for frames. A slow dashboard never slows ingestion |

Per tile on the dashboard, `27/12/12 fps` means **received from phone / processed by backend /
painted on screen**. Also shown: resolution, codec, bitrate, RTT, clock skew, blur, light,
quality score, and warnings for frozen or stalled feeds.

## Behaviour worth knowing

- **Phones reconnect by themselves.** If Wi-Fi drops or the backend restarts, the phone retries
  with backoff and comes back as the same `CAMnn`. Pairings are saved in
  `services/ingest/data/sessions.json`, so saving a Python file under `pnpm dev` does not
  force anyone to rescan.
- **Offline cameras keep their slot for 15 minutes** (`OFFLINE_TTL_SECONDS`), then it is freed.
  Remove one sooner with the tile's **Remove** button.
- **Unused QR codes expire after 10 minutes** (`SESSION_TTL_SECONDS`), and closing the dialog
  frees its reserved slot immediately.
- **Keep phone screens on.** Mobile browsers pause the camera when the screen locks. The page
  holds a wake lock where supported; plugging the phone in is the reliable answer.
- **Flip camera** swaps front/rear without reconnecting (`replaceTrack`).
- **Snapshot** on a tile opens the latest full frame from the backend buffer.

## Layout

```
apps/web/              Next.js 15 + TypeScript + Tailwind v4
  server.mjs           one origin: Next pages + /api and /ws proxied to Python
  src/app/page.tsx                 dashboard
  src/app/camera/[token]/page.tsx  phone camera page
  src/lib/publisher.ts             phone-side WebRTC
  src/lib/useIngest.ts             dashboard socket + frame bus
services/ingest/       Python 3.13, FastAPI, aiortc, OpenCV (driven by Turbo through uv)
  app/main.py          REST + WebSocket routes
  app/rtc.py           peer connections, telemetry, stats
  app/pipeline.py      per-camera frame pipeline  ← detection plugs in here next
  scripts/simulate_phones.py
  tests/
packages/contracts/    TypeScript wire types, mirrored by app/models.py
```

## API

| Method | Path | Used by |
|---|---|---|
| `POST` | `/api/sessions` | dashboard: new QR (`{base_url?}`) |
| `DELETE` | `/api/sessions/{token}` | dashboard: dialog closed without a scan |
| `GET` | `/api/sessions/{token}` | phone: camera ID and ICE servers |
| `POST` | `/api/rtc/offer` | phone: SDP offer → answer |
| `GET` | `/api/cameras` | camera registry |
| `DELETE` | `/api/cameras/{id}` | remove a camera |
| `GET` | `/api/cameras/{id}/snapshot.jpg` | latest buffered frame |
| `GET` | `/api/cameras/{id}/buffer` | rolling buffer size and span |
| `GET` | `/api/network` | detected LAN IPs and suggested phone URL |
| `WS` | `/ws/dashboard` | live state and preview frames |

## Next module

`CameraPipeline.sinks` in `services/ingest/app/pipeline.py` is the hook for detection:
each sink receives a `FramePacket` (camera, frame ID, PTS, canonical time, quality) plus the
full-resolution BGR frame, in a worker thread, at `PROCESS_FPS`. YOLO + ByteTrack register
there without touching the transport.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Phone: *"Camera access needs HTTPS"* | The page was opened over `http://`. Use `pnpm dev:lan`, or an ngrok URL. |
| Phone cannot open the QR link at all | Different network, or the Wi-Fi isolates devices. Use a phone hotspot or ngrok. |
| Phone stuck on *"Connecting to the laptop..."* | Signalling worked but media cannot flow. Same network (hotspot) or add a TURN server. |
| QR points at `localhost` | **Connect Mobile → Change address** and pick the LAN IP chip, or paste the ngrok URL. |
| Feed freezes when the phone locks | Expected in mobile browsers. Keep the screen on and the phone charging. |
| iPhone | Use Safari, iOS 15 or newer. Accept the certificate on the first visit. |
| Dashboard says *Backend offline* | `pnpm dev` / `pnpm dev:lan` is not running, or port 8000 is taken. |
| Security app (McAfee etc.) prompts about Python or Node | Allow them on private networks, or the phone cannot connect. |
