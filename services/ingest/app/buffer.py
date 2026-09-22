"""Rolling evidence buffer (PRD §13).

Holds the last N seconds of processed frames as JPEG, per camera, overwriting
the oldest. When an event fires later, the clip can be cut from here without
waiting for any file to finish.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class BufferedFrame:
    frame_id: int
    ts_s: float
    pts_ms: float | None
    jpeg: bytes


class RollingBuffer:
    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        self._frames: deque[BufferedFrame] = deque()
        self._bytes = 0

    def push(self, frame: BufferedFrame) -> None:
        self._frames.append(frame)
        self._bytes += len(frame.jpeg)
        cutoff = frame.ts_s - self.seconds
        while self._frames and self._frames[0].ts_s < cutoff:
            self._bytes -= len(self._frames.popleft().jpeg)

    def latest(self) -> BufferedFrame | None:
        return self._frames[-1] if self._frames else None

    def window(self, start_s: float, end_s: float) -> list[BufferedFrame]:
        return [f for f in self._frames if start_s <= f.ts_s <= end_s]

    def __len__(self) -> int:
        return len(self._frames)

    @property
    def size_bytes(self) -> int:
        return self._bytes

    @property
    def span_seconds(self) -> float:
        if len(self._frames) < 2:
            return 0.0
        return self._frames[-1].ts_s - self._frames[0].ts_s
