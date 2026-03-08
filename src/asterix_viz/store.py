from __future__ import annotations

from collections import deque
from dataclasses import asdict
from datetime import datetime, timezone
from itertools import count
from math import asin, atan2, cos, degrees, radians, sin, sqrt
from threading import Lock

from .cat062 import decode_cat062_records
from .cat021 import decode_cat021_records
from .models import ParsedPacket, RawPacket, TrackSnapshot
from .parser import extract_fspec_prefix, parse_asterix_header


class PacketStore:
    def __init__(
        self,
        max_packets: int = 2000,
        stale_after_s: float = 15.0,
        max_history_points: int = 120,
        confirm_min_updates: int = 3,
        confirm_window_s: float = 8.0,
        coast_after_s: float = 6.0,
        drop_after_s: float = 20.0,
    ) -> None:
        self._packets: deque[ParsedPacket] = deque(maxlen=max_packets)
        self._id_counter = count(1)
        self._lock = Lock()
        self._tracks: dict[str, TrackSnapshot] = {}
        self._track_history: dict[str, deque[dict[str, object]]] = {}
        self._stale_after_s = stale_after_s
        self._max_history_points = max_history_points
        self._confirm_min_updates = max(1, int(confirm_min_updates))
        self._confirm_window_s = max(1.0, float(confirm_window_s))
        self._coast_after_s = max(0.5, float(coast_after_s))
        self._drop_after_s = max(self._coast_after_s + 0.5, float(drop_after_s))

    def ingest(self, raw: RawPacket) -> ParsedPacket:
        cat, declared_len, payload, validation = parse_asterix_header(raw.payload)
        fspec_bytes, fspec_len, fspec_warnings = extract_fspec_prefix(payload)
        if fspec_warnings:
            validation.warnings.extend(fspec_warnings)

        decoded_records: list[dict[str, object]] = []
        if cat == 62 and validation.ok:
            records, dec_warnings, dec_errors = decode_cat062_records(payload)
            decoded_records = records
            if dec_warnings:
                validation.warnings.extend(dec_warnings)
            if dec_errors:
                validation.errors.extend(dec_errors)
                validation.ok = False
        elif cat == 21 and validation.ok:
            records, dec_warnings, dec_errors = decode_cat021_records(payload)
            decoded_records = records
            if dec_warnings:
                validation.warnings.extend(dec_warnings)
            if dec_errors:
                # CAT021 support is best-effort in MVP; keep packets usable for track extraction.
                validation.warnings.extend([f"CAT021 decode: {e}" for e in dec_errors])

        parsed = ParsedPacket(
            packet_id=next(self._id_counter),
            received_at=raw.received_at.isoformat(),
            source=raw.source,
            size_bytes=len(raw.payload),
            raw_hex=raw.payload.hex(" "),
            cat=cat,
            declared_len=declared_len,
            payload_size=len(payload),
            fspec_hex=fspec_bytes.hex(" ") if fspec_bytes else None,
            fspec_length=fspec_len,
            decoded_records=decoded_records,
            validation=validation,
        )

        with self._lock:
            self._packets.appendleft(parsed)
            self._update_tracks(parsed)
        return parsed

    def _update_tracks(self, packet: ParsedPacket) -> None:
        if packet.cat not in (62, 21):
            return

        for record in packet.decoded_records:
            items = record.get("items", {})
            if not isinstance(items, dict):
                continue

            if packet.cat == 62:
                track_number = items.get("I062/040")
            else:
                track_number = items.get("I021/161")
                if not isinstance(track_number, int):
                    taddr = items.get("I021/080")
                    if isinstance(taddr, dict):
                        ta = str(taddr.get("target_address", ""))
                        try:
                            track_number = int(ta, 16) & 0x0FFF
                        except ValueError:
                            track_number = None
            if not isinstance(track_number, int):
                continue

            src = items.get("I062/010") if packet.cat == 62 else items.get("I021/010")
            if isinstance(src, dict):
                src_id = f"{src.get('sac', 'x')}-{src.get('sic', 'x')}"
            else:
                src_id = packet.source.replace(":", "-")

            key = f"{src_id}:{track_number}"
            if packet.cat == 62:
                wgs = items.get("I062/105") if isinstance(items.get("I062/105"), dict) else None
                cart = items.get("I062/100") if isinstance(items.get("I062/100"), dict) else None
                vel = items.get("I062/185") if isinstance(items.get("I062/185"), dict) else None
                status = items.get("I062/080") if isinstance(items.get("I062/080"), dict) else None
                tod = items.get("I062/070") if isinstance(items.get("I062/070"), dict) else None
                alt = items.get("I062/130") if isinstance(items.get("I062/130"), dict) else None
            else:
                wgs = items.get("I021/131") if isinstance(items.get("I021/131"), dict) else None
                if wgs is None:
                    wgs = items.get("I021/130") if isinstance(items.get("I021/130"), dict) else None
                cart = None
                vel = items.get("I021/160") if isinstance(items.get("I021/160"), dict) else None
                status = items.get("I021/200") if isinstance(items.get("I021/200"), dict) else None
                tod = items.get("I021/071") if isinstance(items.get("I021/071"), dict) else None
                alt = items.get("I021/145") if isinstance(items.get("I021/145"), dict) else None

            prev = self._tracks.get(key)
            count = (prev.update_count + 1) if prev else 1
            now_ts = datetime.fromisoformat(packet.received_at)
            first_seen = prev.first_seen if prev else packet.received_at
            life_s = max(0.0, (now_ts - datetime.fromisoformat(first_seen)).total_seconds())
            confirmed_now = bool(prev.confirmed_once) if prev else False
            if not confirmed_now and count >= self._confirm_min_updates and life_s <= self._confirm_window_s:
                confirmed_now = True

            lat = float(wgs.get("lat_deg")) if wgs and isinstance(wgs.get("lat_deg"), (int, float)) else None
            lon = float(wgs.get("lon_deg")) if wgs and isinstance(wgs.get("lon_deg"), (int, float)) else None
            x_m = float(cart.get("x_m")) if cart and isinstance(cart.get("x_m"), (int, float)) else None
            y_m = float(cart.get("y_m")) if cart and isinstance(cart.get("y_m"), (int, float)) else None

            vx = float(vel.get("vx_mps")) if vel and isinstance(vel.get("vx_mps"), (int, float)) else None
            vy = float(vel.get("vy_mps")) if vel and isinstance(vel.get("vy_mps"), (int, float)) else None
            speed = sqrt(vx * vx + vy * vy) if vx is not None and vy is not None else None
            bearing_deg = (degrees(atan2(vx, vy)) + 360.0) % 360.0 if vx is not None and vy is not None else None
            altitude_ft = float(alt.get("value_ft")) if alt and isinstance(alt.get("value_ft"), (int, float)) else None
            # Hide implausible/negative altitudes from operator display for this MVP.
            if altitude_ft is not None and (altitude_ft < 0 or altitude_ft > 80000):
                altitude_ft = None
            altitude_m = (altitude_ft / 3.28084) if altitude_ft is not None else None

            self._tracks[key] = TrackSnapshot(
                key=key,
                track_number=track_number,
                source_id=src_id,
                last_packet_id=packet.packet_id,
                last_update=packet.received_at,
                age_seconds=0.0,
                update_count=count,
                status_raw=status.get("raw_hex") if status else None,
                tod_seconds=float(tod.get("seconds")) if tod and isinstance(tod.get("seconds"), (int, float)) else None,
                lat_deg=lat,
                lon_deg=lon,
                x_m=x_m,
                y_m=y_m,
                vx_mps=vx,
                vy_mps=vy,
                speed_mps=speed,
                bearing_deg=bearing_deg,
                altitude_ft=altitude_ft,
                altitude_m=altitude_m,
                first_seen=first_seen,
                confirmed_once=confirmed_now,
            )

            hist = self._track_history.get(key)
            if hist is None:
                hist = deque(maxlen=self._max_history_points)
                self._track_history[key] = hist
            hist.append(
                {
                    "ts": packet.received_at,
                    "packet_id": packet.packet_id,
                    "lat_deg": lat,
                    "lon_deg": lon,
                    "x_m": x_m,
                    "y_m": y_m,
                    "speed_mps": speed,
                    "bearing_deg": bearing_deg,
                    "altitude_m": altitude_m,
                    "altitude_ft": altitude_ft,
                }
            )

    def list_packets(self, limit: int = 100) -> list[ParsedPacket]:
        with self._lock:
            return list(self._packets)[:limit]

    def _snapshot_track_rows_locked(self, include_stale: bool, now: datetime) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for track in self._tracks.values():
            updated = datetime.fromisoformat(track.last_update)
            age_s = max(0.0, (now - updated).total_seconds())
            first_seen_dt = datetime.fromisoformat(track.first_seen)
            life_s = max(0.0, (updated - first_seen_dt).total_seconds())
            lifecycle_state = self._track_state(track=track, age_s=age_s)
            if not include_stale and lifecycle_state == "dropped":
                continue

            row = asdict(track)
            row["age_seconds"] = age_s
            row["life_seconds"] = life_s
            row["lifecycle_state"] = lifecycle_state
            row["is_stale"] = age_s > self._stale_after_s or lifecycle_state in ("coasting", "dropped")
            row["history_points"] = len(self._track_history.get(track.key, ()))
            history = list(self._track_history.get(track.key, ()))
            quality = self._quality_for_track(row=row, history=history)
            row["quality_score"] = quality["score"]
            row["quality_reasons"] = quality["reasons"]
            rows.append(row)
        rows.sort(key=lambda r: r["age_seconds"])
        return rows

    def _track_state(self, track: TrackSnapshot, age_s: float) -> str:
        if age_s > self._drop_after_s:
            return "dropped"
        if age_s > self._coast_after_s:
            return "coasting"
        if track.confirmed_once:
            return "confirmed"
        return "tentative"

    @staticmethod
    def _to_datetime(value: object) -> datetime | None:
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value)
            except ValueError:
                return None
        return None

    @staticmethod
    def _geo_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        r = 6371000.0
        p1 = radians(lat1)
        p2 = radians(lat2)
        dphi = radians(lat2 - lat1)
        dlambda = radians(lon2 - lon1)
        a = sin(dphi / 2.0) ** 2 + cos(p1) * cos(p2) * sin(dlambda / 2.0) ** 2
        return 2.0 * r * asin(min(1.0, sqrt(max(0.0, a))))

    def _quality_for_track(self, row: dict[str, object], history: list[dict[str, object]]) -> dict[str, object]:
        score = 100.0
        reasons: list[str] = []

        age_s = float(row.get("age_seconds", 0.0) or 0.0)
        if age_s > self._coast_after_s:
            score -= min(35.0, 10.0 + (age_s - self._coast_after_s) * 3.0)
            reasons.append("stale")
        elif age_s > 2.0:
            score -= min(10.0, (age_s - 2.0) * 2.0)

        if row.get("lat_deg") is None or row.get("lon_deg") is None:
            score -= 20.0
            reasons.append("missing_position")
        if row.get("speed_mps") is None:
            score -= 10.0
            reasons.append("missing_speed")
        if row.get("altitude_m") is None:
            score -= 8.0
            reasons.append("missing_altitude")

        if len(history) >= 2:
            p1 = history[-2]
            p2 = history[-1]
            t1 = self._to_datetime(p1.get("ts"))
            t2 = self._to_datetime(p2.get("ts"))
            if t1 and t2:
                dt = (t2 - t1).total_seconds()
            else:
                dt = 0.0

            if dt > 0:
                lat1, lon1 = p1.get("lat_deg"), p1.get("lon_deg")
                lat2, lon2 = p2.get("lat_deg"), p2.get("lon_deg")
                if all(isinstance(v, (int, float)) for v in (lat1, lon1, lat2, lon2)):
                    dist = self._geo_distance_m(float(lat1), float(lon1), float(lat2), float(lon2))
                    implied_speed = dist / dt
                    if implied_speed > 420.0:
                        score -= 28.0
                        reasons.append("kinematic_jump")

                s1 = p1.get("speed_mps")
                s2 = p2.get("speed_mps")
                if isinstance(s1, (int, float)) and isinstance(s2, (int, float)):
                    accel = (float(s2) - float(s1)) / dt
                    if abs(accel) > 20.0:
                        score -= 12.0
                        reasons.append("speed_jump")

                a1 = p1.get("altitude_m")
                a2 = p2.get("altitude_m")
                if isinstance(a1, (int, float)) and isinstance(a2, (int, float)):
                    vs = (float(a2) - float(a1)) / dt
                    if abs(vs) > 90.0:
                        score -= 10.0
                        reasons.append("vertical_rate")

        if row.get("lifecycle_state") == "tentative":
            score -= 8.0
            reasons.append("unconfirmed")
        if row.get("lifecycle_state") == "coasting":
            score -= 8.0
            reasons.append("coasting")

        if age_s > self._drop_after_s:
            score = min(score, 25.0)
            reasons.append("dropped")

        uniq_reasons = sorted(set(reasons))
        return {"score": int(max(0, min(100, round(score)))), "reasons": uniq_reasons}

    def list_tracks(self, include_stale: bool = False) -> list[dict[str, object]]:
        now = datetime.now(timezone.utc)
        with self._lock:
            return self._snapshot_track_rows_locked(include_stale=include_stale, now=now)

    def get_track(self, key: str) -> dict[str, object] | None:
        now = datetime.now(timezone.utc)
        with self._lock:
            rows = self._snapshot_track_rows_locked(include_stale=True, now=now)
            for row in rows:
                if row.get("key") == key:
                    return row
        return None

    def get_track_history(self, key: str, limit: int = 200) -> list[dict[str, object]]:
        with self._lock:
            hist = self._track_history.get(key)
            if not hist:
                return []
            out = list(hist)[-max(1, limit) :]
        return out

    def stats(self) -> dict[str, int]:
        now = datetime.now(timezone.utc)
        with self._lock:
            total = len(self._packets)
            malformed = sum(1 for p in self._packets if not p.validation.ok)
            cat062 = sum(1 for p in self._packets if p.cat == 62)
            decoded = sum(1 for p in self._packets if p.decoded_records)
            active_tracks = sum(
                1
                for t in self._tracks.values()
                if max(0.0, (now - datetime.fromisoformat(t.last_update)).total_seconds()) <= self._stale_after_s
            )

        return {
            "total_packets": total,
            "malformed_packets": malformed,
            "cat062_packets": cat062,
            "decoded_packets": decoded,
            "active_tracks": active_tracks,
        }
