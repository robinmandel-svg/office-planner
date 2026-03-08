from __future__ import annotations

from dataclasses import dataclass
from math import cos, radians, sin

from .cat062 import DecodeError, parse_fspec_at


@dataclass(slots=True)
class ItemDecode:
    value: object
    next_offset: int


def _require(data: bytes, offset: int, needed: int, item: str) -> None:
    if offset + needed > len(data):
        raise DecodeError(f"{item} truncated: need {needed} bytes at offset {offset}.")


def _read_u16(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 2], byteorder="big", signed=False)


def _read_i16(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 2], byteorder="big", signed=True)


def _read_i24(data: bytes, offset: int) -> int:
    raw = int.from_bytes(data[offset : offset + 3], byteorder="big", signed=False)
    if raw & 0x800000:
        raw -= 1 << 24
    return raw


def _read_i32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 4], byteorder="big", signed=True)


def _skip_var_fx(data: bytes, offset: int, item: str) -> ItemDecode:
    _require(data, offset, 1, item)
    i = offset
    out = bytearray()
    while i < len(data):
        b = data[i]
        out.append(b)
        i += 1
        if (b & 0x01) == 0:
            break
    if out[-1] & 0x01:
        raise DecodeError(f"{item} truncated: FX set but no continuation.")
    return ItemDecode({"raw_hex": bytes(out).hex(" "), "length": len(out)}, i)


def _skip_explicit(data: bytes, offset: int, item: str) -> ItemDecode:
    _require(data, offset, 1, item)
    ln = data[offset]
    _require(data, offset, ln, item)
    return ItemDecode({"raw_hex": data[offset : offset + ln].hex(" "), "length": ln}, offset + ln)


def decode_i021_010(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 2, "I021/010")
    return ItemDecode({"sac": data[offset], "sic": data[offset + 1]}, offset + 2)


def decode_i021_161(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 2, "I021/161")
    raw = _read_u16(data, offset)
    return ItemDecode(raw & 0x0FFF, offset + 2)


def decode_i021_071(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 3, "I021/071")
    raw = int.from_bytes(data[offset : offset + 3], byteorder="big", signed=False)
    return ItemDecode({"seconds": raw / 128.0, "raw": raw}, offset + 3)


def decode_i021_080(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 3, "I021/080")
    return ItemDecode({"target_address": data[offset : offset + 3].hex()}, offset + 3)


def decode_i021_130(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 6, "I021/130")
    lat_raw = _read_i24(data, offset)
    lon_raw = _read_i24(data, offset + 3)
    scale = 180.0 / (2**23)
    return ItemDecode(
        {
            "lat_deg": lat_raw * scale,
            "lon_deg": lon_raw * scale,
            "lat_raw": lat_raw,
            "lon_raw": lon_raw,
        },
        offset + 6,
    )


def decode_i021_131(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 8, "I021/131")
    lat_raw = _read_i32(data, offset)
    lon_raw = _read_i32(data, offset + 4)
    scale = 0.00000016763806343078613
    return ItemDecode(
        {
            "lat_deg": lat_raw * scale,
            "lon_deg": lon_raw * scale,
            "lat_raw": lat_raw,
            "lon_raw": lon_raw,
        },
        offset + 8,
    )


def decode_i021_145(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 2, "I021/145")
    raw = _read_i16(data, offset)
    fl = raw * 0.25
    return ItemDecode({"flight_level": fl, "value_ft": fl * 100.0, "raw": raw}, offset + 2)


def decode_i021_160(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 4, "I021/160")
    v = int.from_bytes(data[offset : offset + 4], byteorder="big", signed=False)
    re = (v >> 31) & 0x01
    gs_raw = (v >> 16) & 0x7FFF
    ta_raw = v & 0xFFFF

    gs_nms = gs_raw * 0.00006103515625
    speed_mps = gs_nms * 1852.0
    bearing_deg = ta_raw * 0.0054931640625
    br = radians(bearing_deg)
    vx_mps = speed_mps * sin(br)
    vy_mps = speed_mps * cos(br)

    return ItemDecode(
        {
            "re": re,
            "speed_mps": speed_mps,
            "bearing_deg": bearing_deg,
            "vx_mps": vx_mps,
            "vy_mps": vy_mps,
            "gs_raw": gs_raw,
            "ta_raw": ta_raw,
        },
        offset + 4,
    )


# FRN -> (item id, length spec in XML UAP)
_UAP = {
    1: ("I021/010", "2"),
    2: ("I021/040", "2+"),
    3: ("I021/161", "2"),
    4: ("I021/015", "1"),
    5: ("I021/071", "3"),
    6: ("I021/130", "6"),
    7: ("I021/131", "8"),
    8: ("I021/072", "3"),
    9: ("I021/150", "2"),
    10: ("I021/151", "2"),
    11: ("I021/080", "3"),
    12: ("I021/073", "3"),
    13: ("I021/074", "4"),
    14: ("I021/075", "3"),
    15: ("I021/076", "4"),
    16: ("I021/140", "2"),
    17: ("I021/090", "1+"),
    18: ("I021/210", "1"),
    19: ("I021/070", "2"),
    20: ("I021/230", "2"),
    21: ("I021/145", "2"),
    22: ("I021/152", "2"),
    23: ("I021/200", "1"),
    24: ("I021/155", "2"),
    25: ("I021/157", "2"),
    26: ("I021/160", "4"),
    27: ("I021/165", "2"),
    28: ("I021/077", "3"),
    29: ("I021/170", "6"),
    30: ("I021/020", "1"),
    31: ("I021/220", "1+"),
    32: ("I021/146", "2"),
    33: ("I021/148", "2"),
    34: ("I021/110", "1+"),
    35: ("I021/016", "1"),
    36: ("I021/008", "1"),
    37: ("I021/271", "1+"),
    38: ("I021/132", "1"),
    39: ("I021/250", "1+N*8"),
    40: ("I021/260", "7"),
    41: ("I021/400", "1"),
    42: ("I021/295", "1+"),
    48: ("I021/RE", "1+"),
    49: ("I021/SP", "1+"),
}

_DECODERS = {
    "I021/010": decode_i021_010,
    "I021/161": decode_i021_161,
    "I021/071": decode_i021_071,
    "I021/080": decode_i021_080,
    "I021/130": decode_i021_130,
    "I021/131": decode_i021_131,
    "I021/145": decode_i021_145,
    "I021/160": decode_i021_160,
}


def _skip_by_len_spec(data: bytes, offset: int, item: str, len_spec: str) -> ItemDecode:
    if len_spec.isdigit():
        ln = int(len_spec)
        _require(data, offset, ln, item)
        return ItemDecode({"raw_hex": data[offset : offset + ln].hex(" "), "length": ln}, offset + ln)

    if len_spec == "1+" or len_spec == "2+":
        return _skip_var_fx(data, offset, item)

    if len_spec == "1+N*8":
        _require(data, offset, 1, item)
        rep = data[offset]
        ln = 1 + rep * 8
        _require(data, offset, ln, item)
        return ItemDecode({"raw_hex": data[offset : offset + ln].hex(" "), "rep": rep, "length": ln}, offset + ln)

    if len_spec == "-":
        return _skip_explicit(data, offset, item)

    raise DecodeError(f"Unsupported length spec {len_spec} for {item}.")


def decode_cat021_records(payload: bytes) -> tuple[list[dict[str, object]], list[str], list[str]]:
    records: list[dict[str, object]] = []
    warnings: list[str] = []
    errors: list[str] = []

    offset = 0
    record_id = 0
    while offset < len(payload):
        record_id += 1
        try:
            fspec, offset, frns = parse_fspec_at(payload, offset)
        except DecodeError as exc:
            errors.append(f"Record {record_id}: {exc}")
            break

        record: dict[str, object] = {
            "record_index": record_id,
            "fspec_hex": fspec.hex(" "),
            "frns": frns,
            "items": {},
        }

        for frn in frns:
            u = _UAP.get(frn)
            if u is None:
                errors.append(f"Record {record_id}: unknown FRN {frn} for CAT021.")
                break

            item_name, len_spec = u
            try:
                decoder = _DECODERS.get(item_name)
                if decoder is None:
                    decoded = _skip_by_len_spec(payload, offset, item_name, len_spec)
                else:
                    decoded = decoder(payload, offset)
            except DecodeError as exc:
                errors.append(f"Record {record_id} {item_name}: {exc}")
                break

            offset = decoded.next_offset
            record["items"][item_name] = decoded.value

        records.append(record)

        if errors and errors[-1].startswith(f"Record {record_id}"):
            break

    if offset != len(payload):
        warnings.append(f"Decoder stopped at payload offset {offset} of {len(payload)}; trailing bytes remain.")

    return records, warnings, errors
