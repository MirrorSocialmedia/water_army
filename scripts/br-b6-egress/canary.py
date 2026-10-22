#!/usr/bin/env python3
# =============================================================================
# br-b6e canary — protocol-aware TCP connection logger (runs in canary image)
#
# Logs EVERY inbound connection to /canary/conn.log with:
#   - dual-stamped start line
#   - "conn ... src=<SRC-IP> port=<SRC-PORT>" — SRC-IP is the discriminator:
#       gost-container IP  = via-proxy traffic
#       device-container IP= DIRECT traffic (the fail-open path)
#       gateway IP         = host self-check
#   - the first line + received payload (probe tags land here)
#
# Protocol handling (so probes terminate cleanly with 200):
#   - "CONNECT host:port HTTP/x"  -> 200 Connection established, then answer
#     the tunneled HTTP request with 200 OK body "OK"  (socks5 chain shape)
#   - "GET/POST/... HTTP/x"       -> 200 OK body "OK"  (direct HTTP probe)
#   - anything else               -> log bytes, reply "OK" best-effort
# Orchestrator MARK lines are appended via `docker exec ... echo >> log`.
# =============================================================================
import datetime
import os
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "16370"))
LOG = "/canary/conn.log"


def w(line: str) -> None:
    with open(LOG, "a") as f:
        f.write(line + "\n")
        f.flush()


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_first_line(c: socket.socket):
    buf = b""
    while b"\r\n" not in buf:
        try:
            d = c.recv(4096)
        except socket.timeout:
            break
        if not d:
            break
        buf += d
    if b"\r\n" not in buf:
        return buf.decode("utf-8", "replace"), b""
    first, rest = buf.split(b"\r\n", 1)
    return first.decode("utf-8", "replace"), rest


def read_http_request(c: socket.socket, prefix: bytes) -> bytes:
    """Read (with prefix) until end-of-headers. Returns all bytes."""
    buf = prefix
    while b"\r\n\r\n" not in buf:
        try:
            d = c.recv(4096)
        except socket.timeout:
            break
        if not d:
            break
        buf += d
    return buf


def handle(c: socket.socket, addr) -> None:
    w(f"conn src={addr[0]} port={addr[1]}")
    try:
        c.settimeout(20)
        first, rest = read_first_line(c)
        w(f"first-line: {first!r}")
        if first.startswith("CONNECT"):
            c.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            w("reply: 200 Connection established")
            data = read_http_request(c, rest)
            w("recv: %r" % data[:400].decode("utf-8", "replace"))
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
            w("reply: 200 OK (tunneled)")
        elif first[:5] in (b"GET", b"POST", b"PUT", b"HEAD", b"DELE"):
            data = read_http_request(c, rest)
            w("recv: %r" % data[:400].decode("utf-8", "replace"))
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
            w("reply: 200 OK")
        else:
            # raw / non-HTTP: log what arrives, best-effort OK
            data = rest
            try:
                while True:
                    d = c.recv(4096)
                    if not d:
                        break
                    data += d
                    if len(data) > 65536:
                        break
            except socket.timeout:
                pass
            if data:
                w("recv-raw: %r" % data[:400].decode("utf-8", "replace"))
            c.sendall(b"OK")
            w("reply: OK (raw)")
    except Exception as e:  # noqa: BLE001 - canary must never die
        w(f"err: {e!r}")
    finally:
        try:
            c.close()
        except OSError:
            pass


def main() -> None:
    os.makedirs("/canary", exist_ok=True)
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", PORT))
    s.listen(16)
    w(f"=== canary start (python) {now()} port={PORT} ===")
    while True:
        c, addr = s.accept()
        handle(c, addr)


if __name__ == "__main__":
    main()
