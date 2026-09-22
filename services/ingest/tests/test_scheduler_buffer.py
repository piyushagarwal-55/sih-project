import pytest

from app.buffer import BufferedFrame, RollingBuffer
from app.scheduler import FrameScheduler


@pytest.mark.parametrize("capture_fps,target_fps", [(30, 12), (30, 10), (25, 12), (15, 12)])
def test_scheduler_holds_the_target_rate(capture_fps, target_fps):
    sched = FrameScheduler(target_fps)
    seconds = 10
    picked = sum(sched.should_process(i / capture_fps) for i in range(capture_fps * seconds))
    expected = min(target_fps, capture_fps) * seconds
    assert abs(picked - expected) <= 2


def test_scheduler_resyncs_after_a_stall():
    sched = FrameScheduler(10)
    for i in range(10):
        sched.should_process(i * 0.1)
    # Five seconds of nothing, then frames again: no burst of catch-up frames.
    burst = sum(sched.should_process(6.0 + i * 0.001) for i in range(50))
    assert burst == 1


def test_scheduler_rejects_nonpositive_rate():
    with pytest.raises(ValueError):
        FrameScheduler(0)


def frame(i: int, ts: float) -> BufferedFrame:
    return BufferedFrame(frame_id=i, ts_s=ts, pts_ms=None, jpeg=b"x" * 100)


def test_buffer_keeps_only_the_window():
    buf = RollingBuffer(seconds=10)
    for i in range(300):  # 30 s at 10 fps
        buf.push(frame(i, i * 0.1))
    assert buf.span_seconds <= 10.0 + 1e-9
    assert buf.latest().frame_id == 299
    assert len(buf) == 101
    assert buf.size_bytes == 101 * 100


def test_buffer_window_query():
    buf = RollingBuffer(seconds=60)
    for i in range(100):
        buf.push(frame(i, float(i)))
    clip = buf.window(40.0, 50.0)
    assert [f.frame_id for f in clip] == list(range(40, 51))
