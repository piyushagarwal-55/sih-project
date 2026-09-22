"""Canonical backend time (PRD §9-10).

Phones have their own clocks and they drift. For event ordering we trust exactly
one clock: this process. Everything that gets compared across cameras is stamped
with these helpers.
"""

from __future__ import annotations

import time
from datetime import datetime


def now_s() -> float:
    """Wall-clock seconds since the epoch."""
    return time.time()


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ts_s: float | None) -> str | None:
    """ISO-8601 with the local UTC offset, millisecond precision."""
    if ts_s is None:
        return None
    return datetime.fromtimestamp(ts_s).astimezone().isoformat(timespec="milliseconds")


def mono_s() -> float:
    """Monotonic seconds, for rates and intervals. Never goes backwards."""
    return time.monotonic()
