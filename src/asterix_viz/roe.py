from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from math import asin, atan2, cos, degrees, radians, sin, sqrt
from threading import Lock


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _geo_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1 = radians(lat1)
    p2 = radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lon2 - lon1)
    a = sin(dphi / 2.0) ** 2 + cos(p1) * cos(p2) * sin(dlambda / 2.0) ** 2
    return 2.0 * r * asin(min(1.0, sqrt(max(0.0, a))))


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1 = radians(lat1)
    p2 = radians(lat2)
    dlambda = radians(lon2 - lon1)
    y = sin(dlambda) * cos(p2)
    x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dlambda)
    return (degrees(atan2(y, x)) + 360.0) % 360.0


def _predict_point(lat_deg: float, lon_deg: float, speed_mps: float, bearing_deg: float, dt_seconds: float) -> tuple[float, float] | None:
    if not all(isinstance(v, (int, float)) for v in (lat_deg, lon_deg, speed_mps, bearing_deg, dt_seconds)):
        return None
    distance = float(speed_mps) * float(dt_seconds)
    r = 6371000.0
    lat1 = radians(lat_deg)
    lon1 = radians(lon_deg)
    brng = radians(bearing_deg)
    ang = distance / r
    lat2 = asin(sin(lat1) * cos(ang) + cos(lat1) * sin(ang) * cos(brng))
    lon2 = lon1 + atan2(sin(brng) * sin(ang) * cos(lat1), cos(ang) - sin(lat1) * sin(lat2))
    lat = degrees(lat2)
    lon = (degrees(lon2) + 540.0) % 360.0 - 180.0
    return (lat, lon)


def _estimate_entry_times(
    *,
    op_lat: float,
    op_lon: float,
    lat: float,
    lon: float,
    speed_mps: float,
    bearing_deg: float,
    red_m: float,
    amber_m: float,
    green_m: float,
    max_horizon_s: float,
    step_s: float = 2.0,
) -> dict[str, float | None]:
    """Estimate first entry time into each ring using sampled trajectory."""
    entries: dict[str, float | None] = {"red": None, "amber": None, "green": None}
    d_prev = _geo_distance_m(op_lat, op_lon, lat, lon)
    t_prev = 0.0

    if d_prev <= red_m:
        entries["red"] = 0.0
    if d_prev <= amber_m:
        entries["amber"] = 0.0
    if d_prev <= green_m:
        entries["green"] = 0.0

    t = step_s
    max_h = max(0.0, float(max_horizon_s))
    while t <= max_h + 1e-9:
        p = _predict_point(lat, lon, speed_mps, bearing_deg, t)
        if p is None:
            break
        d = _geo_distance_m(op_lat, op_lon, p[0], p[1])
        for zone, radius in (("red", red_m), ("amber", amber_m), ("green", green_m)):
            if entries[zone] is not None:
                continue
            if d <= radius:
                if d_prev > radius and abs(d_prev - d) > 1e-6:
                    frac = (d_prev - radius) / (d_prev - d)
                    frac = max(0.0, min(1.0, frac))
                    entries[zone] = t_prev + frac * (t - t_prev)
                else:
                    entries[zone] = t
        d_prev = d
        t_prev = t
        t += step_s
    return entries


def _heading_offsets_deg(uncertainty_deg: float, samples: int = 9) -> list[float]:
    u = max(0.0, float(uncertainty_deg))
    count = max(1, int(samples))
    if u <= 0.0 or count == 1:
        return [0.0]
    if count % 2 == 0:
        count += 1
    step = (2.0 * u) / float(count - 1)
    return [(-u + step * i) for i in range(count)]


def _estimate_entry_times_cone(
    *,
    op_lat: float,
    op_lon: float,
    lat: float,
    lon: float,
    speed_mps: float,
    bearing_deg: float,
    heading_uncertainty_deg: float,
    red_m: float,
    amber_m: float,
    green_m: float,
    max_horizon_s: float,
    step_s: float = 2.0,
    heading_samples: int = 9,
) -> dict[str, float | None]:
    entries: dict[str, float | None] = {"red": None, "amber": None, "green": None}
    for offset in _heading_offsets_deg(heading_uncertainty_deg, heading_samples):
        sample = _estimate_entry_times(
            op_lat=op_lat,
            op_lon=op_lon,
            lat=lat,
            lon=lon,
            speed_mps=speed_mps,
            bearing_deg=bearing_deg + offset,
            red_m=red_m,
            amber_m=amber_m,
            green_m=green_m,
            max_horizon_s=max_horizon_s,
            step_s=step_s,
        )
        for zone in ("red", "amber", "green"):
            t = sample[zone]
            if t is None:
                continue
            best = entries[zone]
            if best is None or t < best:
                entries[zone] = t
    return entries


def _min_distance_at_horizon(
    *,
    op_lat: float,
    op_lon: float,
    lat: float,
    lon: float,
    speed_mps: float,
    bearing_deg: float,
    horizon_s: float,
    heading_uncertainty_deg: float,
    heading_samples: int = 9,
) -> float | None:
    best: float | None = None
    horizon = max(0.0, float(horizon_s))
    for offset in _heading_offsets_deg(heading_uncertainty_deg, heading_samples):
        p = _predict_point(lat, lon, speed_mps, bearing_deg + offset, horizon)
        if p is None:
            continue
        d = _geo_distance_m(op_lat, op_lon, p[0], p[1])
        if best is None or d < best:
            best = d
    return best


@dataclass(slots=True)
class RoesConfig:
    green_m: float = 30000.0
    amber_m: float = 15000.0
    red_m: float = 5000.0
    red_horizon_s: float = 60.0
    amber_horizon_s: float = 120.0
    hysteresis_s: float = 5.0
    heading_uncertainty_deg: float = 8.0


@dataclass(slots=True)
class OperatorPosition:
    lat_deg: float
    lon_deg: float
    alt_msl_m: float
    updated_at: str


class RoeEngine:
    def __init__(self) -> None:
        self._lock = Lock()
        self._config = RoesConfig()
        self._operator: OperatorPosition | None = None
        self._track_state: dict[str, dict[str, object]] = {}

    def status(self) -> dict[str, object]:
        with self._lock:
            return {
                "config": asdict(self._config),
                "operator": asdict(self._operator) if self._operator else None,
            }

    def set_operator_position(self, lat_deg: float, lon_deg: float, alt_msl_m: float) -> dict[str, object]:
        with self._lock:
            self._operator = OperatorPosition(
                lat_deg=float(lat_deg),
                lon_deg=float(lon_deg),
                alt_msl_m=float(alt_msl_m),
                updated_at=_iso(_now_utc()),
            )
            return asdict(self._operator)

    def set_config(
        self,
        green_m: float,
        amber_m: float,
        red_m: float,
        red_horizon_s: float,
        amber_horizon_s: float,
        hysteresis_s: float,
        heading_uncertainty_deg: float,
    ) -> dict[str, object]:
        green_m = float(green_m)
        amber_m = float(amber_m)
        red_m = float(red_m)
        if not (red_m > 0 and amber_m > red_m and green_m > amber_m):
            raise ValueError("Expected ring radii order: red < amber < green.")
        cfg = RoesConfig(
            green_m=green_m,
            amber_m=amber_m,
            red_m=red_m,
            red_horizon_s=max(1.0, float(red_horizon_s)),
            amber_horizon_s=max(1.0, float(amber_horizon_s)),
            hysteresis_s=max(0.0, float(hysteresis_s)),
            heading_uncertainty_deg=max(0.0, min(45.0, float(heading_uncertainty_deg))),
        )
        with self._lock:
            self._config = cfg
            return asdict(self._config)

    def enrich_tracks(self, tracks: list[dict[str, object]], now: datetime | None = None) -> list[dict[str, object]]:
        now_dt = now or _now_utc()
        out: list[dict[str, object]] = []
        with self._lock:
            for track in tracks:
                out.append(self._enrich_track_locked(track, now_dt))
        return out

    def enrich_track(self, track: dict[str, object], now: datetime | None = None) -> dict[str, object]:
        now_dt = now or _now_utc()
        with self._lock:
            return self._enrich_track_locked(track, now_dt)

    def _enrich_track_locked(self, track: dict[str, object], now_dt: datetime) -> dict[str, object]:
        row = dict(track)
        key = str(row.get("key", ""))
        row["operator_cue"] = None
        row["alert"] = {
            "level": "none",
            "reason": "operator_unset" if self._operator is None else "insufficient_data",
            "distance_m": None,
            "horizon_s": None,
        }
        if self._operator is None:
            return row

        lat = row.get("lat_deg")
        lon = row.get("lon_deg")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            return row

        op = self._operator
        cfg = self._config
        distance_now = _geo_distance_m(op.lat_deg, op.lon_deg, float(lat), float(lon))
        az = _bearing_deg(op.lat_deg, op.lon_deg, float(lat), float(lon))
        alt_tgt = row.get("altitude_m")
        if isinstance(alt_tgt, (int, float)):
            el = degrees(atan2(float(alt_tgt) - op.alt_msl_m, max(distance_now, 1.0)))
        else:
            el = None
        row["operator_cue"] = {"azimuth_deg_true": az, "elevation_deg": el}

        speed = row.get("speed_mps")
        bearing = row.get("bearing_deg")
        d60 = None
        d120 = None
        tti_red_s = None
        tti_amber_s = None
        tti_green_s = None
        if isinstance(speed, (int, float)) and isinstance(bearing, (int, float)):
            d60 = _min_distance_at_horizon(
                op_lat=op.lat_deg,
                op_lon=op.lon_deg,
                lat=float(lat),
                lon=float(lon),
                speed_mps=float(speed),
                bearing_deg=float(bearing),
                horizon_s=cfg.red_horizon_s,
                heading_uncertainty_deg=cfg.heading_uncertainty_deg,
                heading_samples=9,
            )
            d120 = _min_distance_at_horizon(
                op_lat=op.lat_deg,
                op_lon=op.lon_deg,
                lat=float(lat),
                lon=float(lon),
                speed_mps=float(speed),
                bearing_deg=float(bearing),
                horizon_s=cfg.amber_horizon_s,
                heading_uncertainty_deg=cfg.heading_uncertainty_deg,
                heading_samples=9,
            )
            entries = _estimate_entry_times_cone(
                op_lat=op.lat_deg,
                op_lon=op.lon_deg,
                lat=float(lat),
                lon=float(lon),
                speed_mps=float(speed),
                bearing_deg=float(bearing),
                heading_uncertainty_deg=cfg.heading_uncertainty_deg,
                red_m=cfg.red_m,
                amber_m=cfg.amber_m,
                green_m=cfg.green_m,
                max_horizon_s=max(cfg.red_horizon_s, cfg.amber_horizon_s),
                step_s=2.0,
                heading_samples=9,
            )
            tti_red_s = entries["red"]
            tti_amber_s = entries["amber"]
            tti_green_s = entries["green"]

        # Baseline by current position: highest zone currently occupied.
        if distance_now <= cfg.red_m:
            proposed_level = "red"
            reason = "inside_red"
            horizon_s = 0.0
        elif distance_now <= cfg.amber_m:
            proposed_level = "amber"
            reason = "inside_amber"
            horizon_s = 0.0
        elif distance_now <= cfg.green_m:
            proposed_level = "green"
            reason = "inside_green"
            horizon_s = 0.0
        else:
            proposed_level = "none"
            reason = "outside"
            horizon_s = None

        # Escalation by predicted entry in configured horizons.
        # Highest severity always wins.
        if tti_red_s is not None and tti_red_s <= cfg.red_horizon_s:
            proposed_level = "red"
            reason = "predicted_red_within_60"
            horizon_s = tti_red_s
        elif tti_amber_s is not None and tti_amber_s <= cfg.amber_horizon_s:
            if proposed_level in ("none", "green"):
                proposed_level = "amber"
                reason = "predicted_amber_within_120"
                horizon_s = tti_amber_s
        elif tti_green_s is not None and tti_green_s <= cfg.amber_horizon_s:
            if proposed_level == "none":
                proposed_level = "green"
                reason = "predicted_green_within_120"
                horizon_s = tti_green_s

        final_level = proposed_level
        track_st = self._track_state.get(key)
        if track_st:
            old_level = str(track_st.get("level", "none"))
            old_changed = _parse_iso(str(track_st.get("changed_at"))) or now_dt
            if self._level_rank(proposed_level) < self._level_rank(old_level):
                if (now_dt - old_changed).total_seconds() < cfg.hysteresis_s:
                    final_level = old_level
                    reason = "hysteresis_hold"
                else:
                    self._track_state[key] = {"level": proposed_level, "changed_at": _iso(now_dt)}
            elif proposed_level != old_level:
                self._track_state[key] = {"level": proposed_level, "changed_at": _iso(now_dt)}
        else:
            self._track_state[key] = {"level": proposed_level, "changed_at": _iso(now_dt)}

        row["alert"] = {
            "level": final_level,
            "reason": reason,
            "distance_m": distance_now,
            "distance_60s_m": d60,
            "distance_120s_m": d120,
            "tti_red_s": tti_red_s,
            "tti_amber_s": tti_amber_s,
            "tti_green_s": tti_green_s,
            "horizon_s": horizon_s,
        }
        return row

    @staticmethod
    def _level_rank(level: str) -> int:
        return {"none": 0, "green": 1, "amber": 2, "red": 3}.get(level, 0)
