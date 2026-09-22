import cv2
import numpy as np

from app.quality import FrozenDetector, assess, integrity_score


def scene(seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = np.full((720, 1280, 3), 110, np.uint8)
    for i in range(0, 1280, 40):
        cv2.line(img, (i, 0), (i, 720), (240, 240, 240), 2)
    cv2.circle(img, (640, 360), 120, (30, 60, 200), -1)
    return cv2.add(img, rng.integers(0, 8, img.shape, dtype=np.uint8))


def test_sharp_frame_scores_higher_than_blurred():
    sharp = assess(scene())
    blurred = assess(cv2.GaussianBlur(scene(), (31, 31), 12))
    assert sharp.blur > blurred.blur * 5
    assert sharp.score > blurred.score


def test_black_frame_has_low_integrity_and_score():
    q = assess(np.zeros((720, 1280, 3), np.uint8))
    assert q.integrity < 0.5
    assert q.score < 0.2
    assert q.brightness == 0.0


def test_integrity_is_full_for_a_textured_frame():
    grey = cv2.cvtColor(scene(), cv2.COLOR_BGR2GRAY)
    assert integrity_score(grey) == 1.0


def test_frozen_detector_needs_identical_frames_for_the_hold_time():
    det = FrozenDetector(hold_seconds=2.0)
    grey = cv2.cvtColor(scene(), cv2.COLOR_BGR2GRAY)
    assert det.update(grey, 0.0) is False
    assert det.update(grey, 1.0) is False  # identical, but not for long enough
    assert det.update(grey, 2.5) is True


def test_frozen_detector_ignores_normal_sensor_noise():
    det = FrozenDetector(hold_seconds=1.0)
    flags = [det.update(cv2.cvtColor(scene(seed=i), cv2.COLOR_BGR2GRAY), i * 0.5) for i in range(10)]
    assert not any(flags)


def test_frozen_feed_halves_the_score_or_more():
    det = FrozenDetector(hold_seconds=0.5)
    frame = scene()
    fresh = assess(frame, det, 0.0)
    assess(frame, det, 0.3)
    frozen = assess(frame, det, 1.0)
    assert frozen.frozen
    assert frozen.score <= fresh.score * 0.5
