from __future__ import annotations

from .models import PacketValidation


def parse_asterix_header(data: bytes) -> tuple[int | None, int | None, bytes, PacketValidation]:
    validation = PacketValidation()

    if len(data) < 3:
        validation.ok = False
        validation.errors.append("Packet shorter than ASTERIX header (3 bytes).")
        return None, None, b"", validation

    cat = data[0]
    declared_len = int.from_bytes(data[1:3], byteorder="big", signed=False)

    if declared_len < 3:
        validation.ok = False
        validation.errors.append(f"Invalid declared length {declared_len}; must be >= 3.")

    actual_len = len(data)
    if declared_len != actual_len:
        validation.ok = False
        validation.errors.append(
            f"Length mismatch: declared={declared_len}, actual={actual_len}."
        )

    payload = data[3:] if actual_len >= 3 else b""
    return cat, declared_len, payload, validation


def extract_fspec_prefix(payload: bytes) -> tuple[bytes | None, int, list[str]]:
    warnings: list[str] = []
    if not payload:
        return None, 0, warnings

    fspec = bytearray()
    i = 0

    # FSPEC is a variable-length sequence. The LSB (FX) indicates continuation.
    while i < len(payload):
        b = payload[i]
        fspec.append(b)
        i += 1
        if (b & 0x01) == 0:
            break

    if fspec and (fspec[-1] & 0x01) == 1:
        warnings.append("FSPEC appears truncated: extension bit set but payload ended.")

    return bytes(fspec), len(fspec), warnings
