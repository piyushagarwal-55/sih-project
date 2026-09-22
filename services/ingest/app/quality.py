"""Frame quality assessment (PRD §12).

The score is confidence in the *visual input*, never a threat score. Downstream
stages use it to discount their own evidence: a blurred frame still gets
detections, but face recognition is told its evidence is weak.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

from .models import QualityReport

ANALYSIS_WIDTH = 320

# Laplacian variance roughly spans 5 (very soft) to 1000+ (crisp detail) at
# 320px width. The log scale keeps a textured scene from dominating.
BLUR_FLOOR = 8.0
BLUR_GOOD = 350.0

# Mean absolute difference (0-255) between thumbnails below which two frames
# count as identical. Real sensor noise stays well above this.
FROZEN_DIFF = 0.08
FROZEN_SECONDS = 3.0


def _grey_small(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    if w > ANALYSIS_WIDTH:
        scale = ANALYSIS_WIDTH / w
        bgr = cv2.resize(bgr, (ANALYSIS_WIDTH, max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


def blur_score(grey: np.ndarray) -> float:
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def brightness_score(grey: np.ndarray) -> float:
    return float(grey.mean()) / 255.0


def integrity_score(grey: np.ndarray) -> float:
    """1.0 for a normal frame. Penalises blank, flat, or decoder-garbage frames."""
    if grey.size == 0:
        return 0.0
    std = float(grey.std())
    if std < 1.5:  # lens covered, black frame, or a flat fill
        return 0.15
    if std < 6.0:
        return 0.6
    return 1.0


def combine(blur: float, brightness: float, integrity: float) -> float:
    b = min(1.0, max(0.0, (math.log(max(blur, 1.0)) - math.log(BLUR_FLOOR)) / (math.log(BLUR_GOOD) - math.log(BLUR_FLOOR))))
    # Brightness is usable across a wide middle band; penalise the extremes.
    if brightness < 0.08 or brightness > 0.95:
        light = 0.2
    elif brightness < 0.18:
        light = 0.2 + 0.8 * (brightness - 0.08) / 0.10
    elif brightness > 0.85:
        light = 0.2 + 0.8 * (0.95 - brightness) / 0.10
    else:
        light = 1.0
    return round(integrity * (0.65 * b + 0.35 * light), 3)


class FrozenDetector:
    """Flags a feed that keeps delivering the same picture (PRD §82, dead feeds)."""

    def __init__(self, hold_seconds: float = FROZEN_SECONDS) -> None:
        self.hold_seconds = hold_seconds
        self._last: np.ndarray | None = None
        self._last_t: float | None = None
        self._same_since: float | None = None

    def update(self, grey: np.ndarray, t: float) -> bool:
        thumb = cv2.resize(grey, (64, 36), interpolation=cv2.INTER_AREA).astype(np.int16)
        frozen = False
        if self._last is not None and float(np.abs(thumb - self._last).mean()) < FROZEN_DIFF:
            # The picture has been unchanged since the *first* frame of the run,
            # which is the previous frame, not this one.
            if self._same_since is None:
                self._same_since = self._last_t if self._last_t is not None else t
            frozen = (t - self._same_since) >= self.hold_seconds
        else:
            self._same_since = None
        self._last = thumb
        self._last_t = t
        return frozen


def assess(bgr: np.ndarray, frozen_detector: FrozenDetector | None = None, t: float = 0.0) -> QualityReport:
    grey = _grey_small(bgr)
    blur = blur_score(grey)
    brightness = brightness_score(grey)
    integrity = integrity_score(grey)
    frozen = frozen_detector.update(grey, t) if frozen_detector else False
    score = combine(blur, brightness, integrity)
    if frozen:
        score = round(score * 0.3, 3)
    return QualityReport(
        blur=round(blur, 1),
        brightness=round(brightness, 3),
        integrity=integrity,
        score=score,
        frozen=frozen,
    )
