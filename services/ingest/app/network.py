"""Figure out which address phones on the same Wi-Fi can reach us on."""

from __future__ import annotations

import ipaddress
import socket


def _primary_ipv4() -> str | None:
    # Connecting a UDP socket sends nothing; it just asks the OS which interface
    # it would route through.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


def _rank(ip: str) -> int:
    addr = ipaddress.ip_address(ip)
    if ip.startswith("192.168."):
        return 0
    if ip.startswith("10."):
        return 1
    if addr.is_private:  # 172.16/12 is usually a VM or WSL adapter
        return 2
    return 3


def lan_ipv4s() -> list[str]:
    found: list[str] = []
    primary = _primary_ipv4()
    if primary:
        found.append(primary)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found:
                found.append(ip)
    except OSError:
        pass
    usable = [ip for ip in found if not ip.startswith(("127.", "169.254."))]
    # Keep the routed interface first, then order the rest by how likely they are to be the Wi-Fi.
    head = usable[:1] if primary in usable else []
    tail = sorted((ip for ip in usable if ip not in head), key=_rank)
    return head + tail


def suggested_base_url(public_base_url: str, scheme: str, port: int) -> str:
    if public_base_url:
        return public_base_url.rstrip("/")
    ips = lan_ipv4s()
    host = ips[0] if ips else "localhost"
    return f"{scheme}://{host}:{port}"
