import pytest
from fastapi.testclient import TestClient

from app import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Keep test pairings out of the real data/ directory.
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    with TestClient(main.app) as c:
        yield c


def test_health(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True and body["cameras"] == 0


def test_network_suggests_an_https_url(client):
    body = client.get("/api/network").json()
    assert body["suggested_base_url"].startswith(("https://", "http://"))


def test_pairing_round_trip(client):
    s = client.post("/api/sessions", json={"base_url": "https://demo.ngrok-free.app"}).json()
    assert s["camera_id"] == "CAM01"
    assert s["join_url"] == f"https://demo.ngrok-free.app/camera/{s['token']}"
    assert s["status"] == "waiting"

    info = client.get(f"/api/sessions/{s['token']}").json()
    assert info["camera_id"] == "CAM01"
    assert info["ice_servers"], "phones need at least a STUN server"

    assert client.delete(f"/api/sessions/{s['token']}").json()["cancelled"] is True
    assert client.get(f"/api/sessions/{s['token']}").status_code == 404
    # The cancelled slot is handed out again.
    assert client.post("/api/sessions", json={}).json()["camera_id"] == "CAM01"


def test_rejects_a_bad_base_url(client):
    assert client.post("/api/sessions", json={"base_url": "ftp://nope"}).status_code == 422


def test_offer_with_unknown_token_is_404(client):
    r = client.post("/api/rtc/offer", json={"token": "nope", "sdp": "v=0", "type": "offer"})
    assert r.status_code == 404


def test_unknown_camera_endpoints_are_404(client):
    assert client.delete("/api/cameras/CAM99").status_code == 404
    assert client.get("/api/cameras/CAM99/snapshot.jpg").status_code == 404


def test_dashboard_socket_sends_a_snapshot_first(client):
    with client.websocket_connect("/ws/dashboard") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "snapshot"
        assert msg["cameras"] == []
