import json

import pytest

from app.registry import CameraRegistry, RegistryFull
from app.sessions import SessionManager


def make(max_cameras=3, ttl=60, store=None):
    reg = CameraRegistry(max_cameras)
    return reg, SessionManager(reg, ttl, store)


def test_ids_are_allocated_lowest_first():
    _, sm = make()
    assert [sm.create("https://h").camera_id for _ in range(3)] == ["CAM01", "CAM02", "CAM03"]


def test_registry_full_raises():
    _, sm = make(max_cameras=2)
    sm.create("https://h")
    sm.create("https://h")
    with pytest.raises(RegistryFull):
        sm.create("https://h")


def test_cancel_frees_the_slot_for_reuse():
    _, sm = make(max_cameras=1)
    s = sm.create("https://h")
    assert sm.cancel(s.token)
    assert sm.create("https://h").camera_id == "CAM01"


def test_cancel_leaves_claimed_sessions_alone():
    _, sm = make()
    s = sm.create("https://h")
    sm.claim(s.token)
    assert sm.cancel(s.token) is False
    assert sm.get(s.token) is not None


def test_join_url_uses_the_base_url():
    _, sm = make()
    s = sm.create("https://abc.ngrok-free.app/")
    assert s.join_url == f"https://abc.ngrok-free.app/camera/{s.token}"


def test_sweep_expires_only_unclaimed(monkeypatch):
    reg, sm = make(ttl=10)
    waiting = sm.create("https://h")
    claimed = sm.create("https://h")
    sm.claim(claimed.token)
    monkeypatch.setattr("app.sessions.now_s", lambda: waiting.expires_s + 1)
    expired = sm.sweep()
    assert [s.token for s in expired] == [waiting.token]
    assert sm.get(claimed.token) is not None
    # The expired session's slot is free again.
    assert sm.create("https://h").camera_id == waiting.camera_id


def test_claimed_pairings_survive_a_restart(tmp_path):
    store = tmp_path / "sessions.json"
    reg, sm = make(store=store)
    s = sm.create("https://h")
    sm.claim(s.token)
    reg.ensure(s.camera_id).device_name = "Pixel 8"
    sm.save()
    assert json.loads(store.read_text())[0]["camera_id"] == s.camera_id

    # A fresh process: the phone's old token still works and keeps its identity.
    reg2, sm2 = make(store=store)
    assert sm2.load() == 1
    restored = sm2.claim(s.token)
    assert restored is not None and restored.camera_id == s.camera_id
    rec = reg2.get(s.camera_id)
    assert rec is not None and rec.status == "offline" and rec.device_name == "Pixel 8"
    # And a new phone does not get the restored camera's ID.
    assert sm2.create("https://h").camera_id != s.camera_id


def test_unclaimed_sessions_are_not_persisted(tmp_path):
    store = tmp_path / "sessions.json"
    _, sm = make(store=store)
    sm.create("https://h")
    sm.save()
    assert json.loads(store.read_text()) == []


def test_corrupt_store_is_ignored(tmp_path):
    store = tmp_path / "sessions.json"
    store.write_text("{not json")
    _, sm = make(store=store)
    assert sm.load() == 0
