"""Frame scheduler (PRD §8).

A phone may send 30 FPS. The processing path does not need all of them, so the
scheduler picks an evenly spaced subset. Every frame is still *received* and
counted; only the expensive work is sampled.
"""

from __future__ import annotations


class FrameScheduler:
    def __init__(self, target_fps: float) -> None:
        if target_fps <= 0:
            raise ValueError("target_fps must be positive")
        self.interval = 1.0 / target_fps
        self._next_due: float | None = None

    def should_process(self, t: float) -> bool:
        """`t` is monotonic seconds. Returns True for frames that should be processed."""
        if self._next_due is None:
            self._next_due = t + self.interval
            return True
        if t + 1e-6 >= self._next_due:
            # Advance from the due time rather than from `t`, so the average rate
            # holds even when frames arrive jittery. Resync after a long stall.
            self._next_due += self.interval
            if self._next_due < t:
                self._next_due = t + self.interval
            return True
        return False
