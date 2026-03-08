#!/usr/bin/env python3
from __future__ import annotations

import argparse
import socket
import time
from pathlib import Path


def iter_packets(path: Path):
    for lineno, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        parts = line.split(maxsplit=1)
        if len(parts) == 1:
            delay_ms = 200
            hex_bytes = parts[0]
        else:
            try:
                delay_ms = int(parts[0])
                hex_bytes = parts[1]
            except ValueError:
                delay_ms = 200
                hex_bytes = line

        hex_clean = "".join(hex_bytes.split())
        payload = bytes.fromhex(hex_clean)
        yield delay_ms, payload, lineno


def main() -> None:
    parser = argparse.ArgumentParser(description="Send replay hex packets over UDP.")
    parser.add_argument("file", type=Path, help="Replay file path")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=30062)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()

    if args.speed <= 0:
        raise SystemExit("--speed must be > 0")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dst = (args.host, args.port)

    try:
        while True:
            sent = 0
            for delay_ms, payload, lineno in iter_packets(args.file):
                sock.sendto(payload, dst)
                sent += 1
                print(f"sent line={lineno} bytes={len(payload)}")
                time.sleep((delay_ms / 1000.0) / args.speed)

            print(f"done batch packets={sent}")
            if not args.loop:
                break
    finally:
        sock.close()


if __name__ == "__main__":
    main()
