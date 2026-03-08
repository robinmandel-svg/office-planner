from __future__ import annotations

from dataclasses import dataclass


class DecodeError(Exception):
    pass


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
    raw = data[offset : offset + 3]
    v = int.from_bytes(raw, byteorder="big", signed=False)
    if v & 0x800000:
        v -= 1 << 24
    return v


def _read_i32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 4], byteorder="big", signed=True)


def parse_fspec_at(data: bytes, start: int) -> tuple[bytes, int, list[int]]:
    if start >= len(data):
        raise DecodeError("Missing FSPEC at end of payload.")

    fspec = bytearray()
    idx = start
    while idx < len(data):
        b = data[idx]
        fspec.append(b)
        idx += 1
        if (b & 0x01) == 0:
            break

    if fspec[-1] & 0x01:
        raise DecodeError("FSPEC extension bit set but no further FSPEC octet available.")

    frns: list[int] = []
    frn_base = 1
    for octet in fspec:
        bit = 0x80
        for _ in range(7):
            if octet & bit:
                frns.append(frn_base)
            frn_base += 1
            bit >>= 1

    return bytes(fspec), idx, frns


def decode_i062_010(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 2, "I062/010")
    sac = data[offset]
    sic = data[offset + 1]
    return ItemDecode({"sac": sac, "sic": sic}, offset + 2)


def decode_i062_040(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 2, "I062/040")
    return ItemDecode(_read_u16(data, offset), offset + 2)


def decode_i062_070(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 3, "I062/070")
    raw = int.from_bytes(data[offset : offset + 3], byteorder="big", signed=False)
    return ItemDecode({"seconds": raw / 128.0, "raw": raw}, offset + 3)


def decode_i062_080(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 1, "I062/080")
    i = offset
    out = bytearray()
    while i < len(data):
        b = data[i]
        out.append(b)
        i += 1
        if (b & 0x01) == 0:
            break
    if out[-1] & 0x01:
        raise DecodeError("I062/080 truncated: FX bit set but no continuation.")
    return ItemDecode({"raw_hex": bytes(out).hex(" "), "length": len(out)}, i)


def decode_i062_100(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 6, "I062/100")
    x_raw = _read_i24(data, offset)
    y_raw = _read_i24(data, offset + 3)
    return ItemDecode({"x_m": x_raw * 0.5, "y_m": y_raw * 0.5, "x_raw": x_raw, "y_raw": y_raw}, offset + 6)


def decode_i062_105(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 8, "I062/105")
    lat_raw = _read_i32(data, offset)
    lon_raw = _read_i32(data, offset + 4)
    scale = 180.0 / (2**25)
    return ItemDecode(
        {"lat_deg": lat_raw * scale, "lon_deg": lon_raw * scale, "lat_raw": lat_raw, "lon_raw": lon_raw},
        offset + 8,
    )


def decode_i062_185(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 4, "I062/185")
    vx_raw = _read_i16(data, offset)
    vy_raw = _read_i16(data, offset + 2)
    return ItemDecode(
        {"vx_mps": vx_raw * 0.25, "vy_mps": vy_raw * 0.25, "vx_raw": vx_raw, "vy_raw": vy_raw},
        offset + 4,
    )


def decode_i062_210(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 2, "I062/210")
    ax_raw = int.from_bytes(data[offset : offset + 1], byteorder="big", signed=True)
    ay_raw = int.from_bytes(data[offset + 1 : offset + 2], byteorder="big", signed=True)
    return ItemDecode(
        {"ax_mps2": ax_raw * 0.25, "ay_mps2": ay_raw * 0.25, "ax_raw": ax_raw, "ay_raw": ay_raw}, offset + 2
    )


def decode_i062_015(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 1, "I062/015")
    return ItemDecode(data[offset], offset + 1)


def decode_i062_060(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 2, "I062/060")
    return ItemDecode(data[offset : offset + 2].hex(" "), offset + 2)


def decode_i062_245(data: bytes, offset: int) -> ItemDecode:
    _require(data, offset, 7, "I062/245")
    return ItemDecode(data[offset : offset + 7].hex(" "), offset + 7)


def decode_i062_390(data: bytes, offset: int) -> ItemDecode:
    # Basic parser: variable length with REP count, each repetition 7 octets for this MVP.
    _require(data, offset, 1, "I062/390")
    rep = data[offset]
    item_len = 1 + rep * 7
    _require(data, offset, item_len, "I062/390")
    return ItemDecode({"rep": rep, "raw_hex": data[offset : offset + item_len].hex(" ")}, offset + item_len)


def decode_i062_500(data: bytes, offset: int) -> ItemDecode:
    # Compound quality item. For MVP keep raw bytes by walking extension bits.
    _require(data, offset, 1, "I062/500")
    i = offset
    out = bytearray()
    while i < len(data):
        b = data[i]
        out.append(b)
        i += 1
        if (b & 0x01) == 0:
            break
    if out[-1] & 0x01:
        raise DecodeError("I062/500 truncated: FX bit set but no continuation.")
    return ItemDecode({"raw_hex": bytes(out).hex(" "), "length": len(out)}, i)


def decode_fixed_u8(data: bytes, offset: int, item: str) -> ItemDecode:
    _require(data, offset, 1, item)
    return ItemDecode(data[offset], offset + 1)


def decode_fixed_u16(data: bytes, offset: int, item: str) -> ItemDecode:
    _require(data, offset, 2, item)
    return ItemDecode(_read_u16(data, offset), offset + 2)


def decode_fixed_i16_scale(data: bytes, offset: int, item: str, scale: float, unit: str) -> ItemDecode:
    _require(data, offset, 2, item)
    raw = _read_i16(data, offset)
    return ItemDecode({f"value_{unit}": raw * scale, "raw": raw}, offset + 2)


def validate_cat062_records(records: list[dict[str, object]]) -> tuple[list[str], list[str]]:
    warnings: list[str] = []
    errors: list[str] = []

    if not records:
        warnings.append("CAT062 payload contains no decodable records.")
        return warnings, errors

    for record in records:
        idx = record.get("record_index", "?")
        items = record.get("items", {})
        if not isinstance(items, dict):
            errors.append(f"Record {idx}: malformed decoded item container.")
            continue

        if "I062/040" not in items:
            errors.append(f"Record {idx}: missing mandatory MVP item I062/040 (Track Number).")
        if "I062/070" not in items:
            warnings.append(f"Record {idx}: missing I062/070 (Time of Track).")
        if "I062/080" not in items:
            warnings.append(f"Record {idx}: missing I062/080 (Track Status).")
        if "I062/100" not in items and "I062/105" not in items:
            errors.append(f"Record {idx}: missing position item (I062/100 or I062/105).")

        tod = items.get("I062/070")
        if isinstance(tod, dict):
            sec = tod.get("seconds")
            if isinstance(sec, (int, float)) and not (0.0 <= sec < 86400.0):
                warnings.append(f"Record {idx}: I062/070 time-of-day out of range: {sec}.")

        wgs = items.get("I062/105")
        if isinstance(wgs, dict):
            lat = wgs.get("lat_deg")
            lon = wgs.get("lon_deg")
            if isinstance(lat, (int, float)) and abs(lat) > 90:
                errors.append(f"Record {idx}: latitude out of range: {lat}.")
            if isinstance(lon, (int, float)) and abs(lon) > 180:
                errors.append(f"Record {idx}: longitude out of range: {lon}.")

        vel = items.get("I062/185")
        if isinstance(vel, dict):
            vx = vel.get("vx_mps")
            vy = vel.get("vy_mps")
            if isinstance(vx, (int, float)) and isinstance(vy, (int, float)):
                speed = (vx * vx + vy * vy) ** 0.5
                if speed > 1800:
                    warnings.append(f"Record {idx}: high speed magnitude {speed:.1f} m/s.")

    return warnings, errors


def decode_cat062_records(payload: bytes) -> tuple[list[dict[str, object]], list[str], list[str]]:
    records: list[dict[str, object]] = []
    warnings: list[str] = []
    errors: list[str] = []

    handlers = {
        1: ("I062/010", decode_i062_010),
        2: ("I062/390", decode_i062_390),
        3: ("I062/015", decode_i062_015),
        4: ("I062/070", decode_i062_070),
        5: ("I062/105", decode_i062_105),
        6: ("I062/100", decode_i062_100),
        7: ("I062/185", decode_i062_185),
        8: ("I062/210", decode_i062_210),
        9: ("I062/060", decode_i062_060),
        10: ("I062/245", decode_i062_245),
        11: ("I062/500", decode_i062_500),
        12: ("I062/040", decode_i062_040),
        13: ("I062/080", decode_i062_080),
        14: ("I062/290", lambda d, o: decode_fixed_u8(d, o, "I062/290")),
        15: ("I062/200", lambda d, o: decode_fixed_u16(d, o, "I062/200")),
        16: ("I062/295", lambda d, o: decode_fixed_u8(d, o, "I062/295")),
        17: ("I062/136", lambda d, o: decode_fixed_i16_scale(d, o, "I062/136", 0.25, "fl")),
        18: ("I062/130", lambda d, o: decode_fixed_i16_scale(d, o, "I062/130", 6.25, "ft")),
        19: ("I062/135", lambda d, o: decode_fixed_i16_scale(d, o, "I062/135", 0.25, "fl")),
        20: ("I062/220", lambda d, o: decode_fixed_i16_scale(d, o, "I062/220", 6.25, "ft_min")),
        21: ("I062/390A", lambda d, o: decode_fixed_u8(d, o, "I062/390A")),
        22: ("I062/270", lambda d, o: decode_fixed_u16(d, o, "I062/270")),
        23: ("I062/300", lambda d, o: decode_fixed_u8(d, o, "I062/300")),
        24: ("I062/110", lambda d, o: decode_fixed_u16(d, o, "I062/110")),
        25: ("I062/120", decode_i062_060),
    }

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
            handler_info = handlers.get(frn)
            if handler_info is None:
                errors.append(f"Record {record_id}: FRN {frn} present but unsupported in MVP decoder.")
                break

            item_name, handler = handler_info
            try:
                decoded = handler(payload, offset)
            except DecodeError as exc:
                errors.append(f"Record {record_id} {item_name}: {exc}")
                break

            offset = decoded.next_offset
            record["items"][item_name] = decoded.value

        records.append(record)

        # Stop if this record hit a decode error.
        if errors and errors[-1].startswith(f"Record {record_id}"):
            break

    if offset != len(payload):
        warnings.append(f"Decoder stopped at payload offset {offset} of {len(payload)}; trailing bytes remain.")

    v_warnings, v_errors = validate_cat062_records(records)
    warnings.extend(v_warnings)
    errors.extend(v_errors)

    return records, warnings, errors
