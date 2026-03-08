from __future__ import annotations


def _enc_u16(v: int) -> bytes:
    return int(v & 0xFFFF).to_bytes(2, byteorder="big", signed=False)


def _enc_i16(v: int) -> bytes:
    return int(v).to_bytes(2, byteorder="big", signed=True)


def _enc_i32(v: int) -> bytes:
    return int(v).to_bytes(4, byteorder="big", signed=True)


def build_cat062_packet(
    *,
    track_number: int,
    lat_deg: float,
    lon_deg: float,
    vx_mps: float,
    vy_mps: float,
    tod_seconds: float,
    altitude_ft: float | None = None,
    sac: int = 1,
    sic: int = 99,
    status_octet: int = 0,
) -> bytes:
    # FRNs always present: 1(I062/010), 4(I062/070), 5(I062/105), 7(I062/185), 12(I062/040), 13(I062/080)
    # Optional: 18(I062/130) geometric altitude (6.25 ft LSB).
    if altitude_ft is None:
        fspec = bytes([0x9B, 0x0C])
    else:
        fspec = bytes([0x9B, 0x0D, 0x10])

    source = bytes([sac & 0xFF, sic & 0xFF])

    tod_raw = int(max(0.0, min(86399.9921875, tod_seconds)) * 128.0) & 0xFFFFFF
    tod = tod_raw.to_bytes(3, byteorder="big", signed=False)

    scale = 180.0 / (2**25)
    lat_raw = int(lat_deg / scale)
    lon_raw = int(lon_deg / scale)
    wgs84 = _enc_i32(lat_raw) + _enc_i32(lon_raw)

    vx_raw = int(vx_mps / 0.25)
    vy_raw = int(vy_mps / 0.25)
    vel = _enc_i16(vx_raw) + _enc_i16(vy_raw)

    trk = _enc_u16(track_number)
    status = bytes([status_octet & 0xFF])

    record = fspec + source + tod + wgs84 + vel + trk + status
    if altitude_ft is not None:
        alt_raw = int(altitude_ft / 6.25)
        record += _enc_i16(alt_raw)

    total_len = 3 + len(record)
    return bytes([62]) + total_len.to_bytes(2, byteorder="big", signed=False) + record
