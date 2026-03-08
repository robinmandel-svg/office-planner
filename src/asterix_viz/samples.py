from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from .cat062_encode import build_cat062_packet
from .models import RawPacket


@dataclass(slots=True)
class Sample:
    name: str
    payload: bytes


def _frame(cat: int, payload: bytes) -> bytes:
    total_len = 3 + len(payload)
    return bytes([cat]) + total_len.to_bytes(2, byteorder="big") + payload


def build_cat062_core_record() -> bytes:
    now = datetime.now(timezone.utc)
    packet = build_cat062_packet(
        track_number=345,
        lat_deg=48.8566,
        lon_deg=2.3522,
        vx_mps=210.0,
        vy_mps=25.0,
        tod_seconds=float(now.timestamp() % 86400.0),
        sac=1,
        sic=99,
        status_octet=0,
    )
    return packet[3:]


def build_samples() -> list[Sample]:
    now = int(datetime.now(timezone.utc).timestamp())
    tod3 = now.to_bytes(4, byteorder="big")[-3:]

    return [
        Sample("minimal_valid_no_payload", _frame(62, b"")),
        Sample("header_only_cat48", _frame(48, b"")),
        Sample("cat062_core_decodable", bytes([62]) + (3 + len(build_cat062_core_record())).to_bytes(2, "big") + build_cat062_core_record()),
        Sample("malformed_length", bytes([62, 0x00, 0x10, 0x00, 0x01]) + tod3),
    ]


def generate_raw_packets(count: int) -> list[RawPacket]:
    samples = build_samples()
    if count < 1:
        return []

    out: list[RawPacket] = []
    for i in range(count):
        sample = samples[i % len(samples)]
        out.append(
            RawPacket(
                payload=sample.payload,
                source=f"sample:{sample.name}",
                received_at=datetime.now(timezone.utc),
            )
        )
    return out
