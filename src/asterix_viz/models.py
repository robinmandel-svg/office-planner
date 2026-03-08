from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass(slots=True)
class PacketValidation:
    ok: bool = True
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ParsedPacket:
    packet_id: int
    received_at: str
    source: str
    size_bytes: int
    raw_hex: str
    cat: int | None
    declared_len: int | None
    payload_size: int
    fspec_hex: str | None
    fspec_length: int
    decoded_records: list[dict[str, object]]
    validation: PacketValidation


@dataclass(slots=True)
class TrackSnapshot:
    key: str
    track_number: int
    source_id: str
    last_packet_id: int
    last_update: str
    age_seconds: float
    update_count: int
    status_raw: str | None
    tod_seconds: float | None
    lat_deg: float | None
    lon_deg: float | None
    x_m: float | None
    y_m: float | None
    vx_mps: float | None
    vy_mps: float | None
    speed_mps: float | None
    bearing_deg: float | None
    altitude_ft: float | None
    altitude_m: float | None
    first_seen: str
    confirmed_once: bool


@dataclass(slots=True)
class RawPacket:
    payload: bytes
    source: str
    received_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
