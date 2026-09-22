import json
import struct

from app.hub import encode_frame
from app.rtc import negotiated_codec


def test_frame_encoding_matches_the_contract():
    """Mirrors decodeFrameMessage in packages/contracts: [u32 BE len][JSON][JPEG]."""
    header = {"camera_id": "CAM01", "frame_id": 7, "ts_ms": 123}
    jpeg = b"\xff\xd8fakejpeg\xff\xd9"
    payload = encode_frame(header, jpeg)
    (n,) = struct.unpack(">I", payload[:4])
    assert json.loads(payload[4 : 4 + n]) == header
    assert payload[4 + n :] == jpeg


SDP = """v=0
m=video 9 UDP/TLS/RTP/SAVPF 102 96 97
a=rtpmap:96 VP8/90000
a=rtpmap:97 rtx/90000
a=rtpmap:102 H264/90000
"""


def test_negotiated_codec_is_the_first_payload_type():
    assert negotiated_codec(SDP) == "H264"


def test_negotiated_codec_handles_missing_video():
    assert negotiated_codec("v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\n") is None
