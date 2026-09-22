"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { decodeFrameMessage, type CameraState, type DashboardMessage, type FrameHeader, type PairingSession } from "@divya/contracts";

import { dashboardSocketUrl } from "./api";

export type SocketStatus = "connecting" | "open" | "closed";

export interface LiveFrame {
  bitmap: ImageBitmap;
  header: FrameHeader;
  receivedAt: number;
}

type FrameListener = (frame: LiveFrame) => void;

/**
 * Frames arrive at ~12/s per camera. Pushing them through React state would
 * re-render the whole grid dozens of times a second, so they go through this
 * tiny bus instead and each tile paints its own canvas.
 */
class FrameBus {
  private listeners = new Map<string, Set<FrameListener>>();
  private latest = new Map<string, LiveFrame>();

  subscribe(cameraId: string, fn: FrameListener): () => void {
    let set = this.listeners.get(cameraId);
    if (!set) this.listeners.set(cameraId, (set = new Set()));
    set.add(fn);
    const last = this.latest.get(cameraId);
    if (last) fn(last);
    return () => set.delete(fn);
  }

  publish(frame: LiveFrame) {
    const id = frame.header.camera_id;
    const prev = this.latest.get(id);
    this.latest.set(id, frame);
    this.listeners.get(id)?.forEach((fn) => fn(frame));
    prev?.bitmap.close(); // free GPU memory for the frame we just replaced
  }

  drop(cameraId: string) {
    this.latest.get(cameraId)?.bitmap.close();
    this.latest.delete(cameraId);
  }
}

export function useIngest(onSession?: (s: PairingSession) => void) {
  const [cameras, setCameras] = useState<Record<string, CameraState>>({});
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const busRef = useRef(new FrameBus());
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;
    // Decode at most one frame per camera at a time; drop the rest.
    const decoding = new Set<string>();

    const connect = () => {
      setStatus("connecting");
      ws = new WebSocket(dashboardSocketUrl());
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const msg = JSON.parse(ev.data) as DashboardMessage;
          switch (msg.type) {
            case "snapshot":
              setClockSkewMs(Date.now() - msg.server_time_ms);
              setCameras(Object.fromEntries(msg.cameras.map((c) => [c.camera_id, c])));
              break;
            case "camera_update":
              setCameras((prev) => ({ ...prev, [msg.camera.camera_id]: msg.camera }));
              break;
            case "camera_removed":
              busRef.current.drop(msg.camera_id);
              setCameras((prev) => {
                const { [msg.camera_id]: _gone, ...rest } = prev;
                return rest;
              });
              break;
            case "session_update":
              onSessionRef.current?.(msg.session);
              break;
          }
          return;
        }

        const decoded = decodeFrameMessage(ev.data as ArrayBuffer);
        if (!decoded) return;
        const id = decoded.header.camera_id;
        if (decoding.has(id)) return;
        decoding.add(id);
        createImageBitmap(new Blob([decoded.jpeg as BlobPart], { type: "image/jpeg" }))
          .then((bitmap) => {
            if (disposed) return bitmap.close();
            busRef.current.publish({ bitmap, header: decoded.header, receivedAt: performance.now() });
          })
          .catch(() => {
            /* a corrupt frame; the next one will replace it */
          })
          .finally(() => decoding.delete(id));
      };

      ws.onclose = () => {
        if (disposed) return;
        setStatus("closed");
        attempt += 1;
        retry = setTimeout(connect, Math.min(1000 * 2 ** Math.min(attempt, 4), 10_000));
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const subscribeFrames = useCallback((cameraId: string, fn: FrameListener) => busRef.current.subscribe(cameraId, fn), []);

  return { cameras, status, clockSkewMs, subscribeFrames };
}
