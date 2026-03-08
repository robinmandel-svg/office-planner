from __future__ import annotations

import asyncio
import base64
import json
import math
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .cat062_encode import build_cat062_packet
from .models import RawPacket
from .store import PacketStore


@dataclass(slots=True)
class OpenSkyConfig:
    interval_s: float = 10.0
    max_tracks: int = 200
    bbox: tuple[float, float, float, float] | None = None
    username: str | None = None
    password: str | None = None
    sac: int = 1
    sic: int = 99
    verify_ssl: bool = True
    ca_bundle_path: str | None = None


class RateLimitError(Exception):
    def __init__(self, message: str, retry_after_s: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class OpenSkyBridge:
    def __init__(self, store: PacketStore) -> None:
        self.store = store
        self.running = False
        self.config = OpenSkyConfig()
        self._task: asyncio.Task[None] | None = None
        self.last_fetch_utc: str | None = None
        self.last_error: str | None = None
        self.last_ingested: int = 0
        self._icao_to_track: dict[str, int] = {}
        self._track_to_icao: dict[int, str] = {}
        self._backoff_s: float = 0.0
        self._backoff_cap_s: float = 1800.0
        self._rate_limited_until: datetime | None = None
        self._consecutive_429: int = 0

    async def start(self, config: OpenSkyConfig) -> None:
        if self.running:
            return
        if not (config.username and config.password):
            # OpenSky public access is aggressively rate-limited; keep defaults conservative.
            config.interval_s = max(config.interval_s, 30.0)
            config.max_tracks = min(config.max_tracks, 80)
        self.config = config
        self.running = True
        self.last_error = None
        self._backoff_s = 0.0
        self._rate_limited_until = None
        self._consecutive_429 = 0
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while self.running:
            now = datetime.now(timezone.utc)
            if self._rate_limited_until is not None and now < self._rate_limited_until:
                wait_s = max(1.0, (self._rate_limited_until - now).total_seconds())
                await asyncio.sleep(wait_s)
                continue

            try:
                ingested = await self._fetch_and_ingest_once()
                self.last_ingested = ingested
                self.last_fetch_utc = datetime.now(timezone.utc).isoformat()
                self.last_error = None
                self._backoff_s = 0.0
                self._consecutive_429 = 0
                self._rate_limited_until = None
            except RateLimitError as exc:
                base = max(2.0, self.config.interval_s)
                if not (self.config.username and self.config.password):
                    base = max(base, 60.0)
                if self._backoff_s <= 0:
                    self._backoff_s = base
                else:
                    self._backoff_s = min(self._backoff_s * 2.0, self._backoff_cap_s)

                if exc.retry_after_s is not None:
                    self._backoff_s = max(self._backoff_s, min(exc.retry_after_s, self._backoff_cap_s))

                self._consecutive_429 += 1
                self._rate_limited_until = datetime.now(timezone.utc) + timedelta(seconds=self._backoff_s)
                until = self._rate_limited_until.isoformat()
                self.last_error = f"{exc} (backoff {self._backoff_s:.0f}s until {until})"
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)
                self._rate_limited_until = None

            sleep_s = max(1.0, self.config.interval_s, self._backoff_s)
            await asyncio.sleep(sleep_s)

    async def _fetch_and_ingest_once(self) -> int:
        data = await asyncio.to_thread(self._fetch_states)
        states = data.get("states") or []

        valid: list[list] = []
        for s in states:
            if not isinstance(s, list) or len(s) < 17:
                continue
            lat = s[6]
            lon = s[5]
            if lat is None or lon is None:
                continue
            valid.append(s)

        valid.sort(key=lambda s: (s[4] or 0), reverse=True)
        selected = valid[: max(1, self.config.max_tracks)]

        now = datetime.now(timezone.utc)
        tod_seconds = float((now.timestamp() % 86400.0))

        count = 0
        for s in selected:
            icao24 = str(s[0] or "")
            lon = float(s[5])
            lat = float(s[6])
            velocity = float(s[9] or 0.0)
            track_deg = float(s[10] or 0.0)

            tr = math.radians(track_deg)
            vx = velocity * math.sin(tr)
            vy = velocity * math.cos(tr)

            track_number = self._resolve_track_number(icao24)
            altitude_m = s[13] if s[13] is not None else s[7]
            altitude_ft = float(altitude_m) * 3.28084 if altitude_m is not None else None

            pkt = build_cat062_packet(
                track_number=track_number,
                lat_deg=lat,
                lon_deg=lon,
                vx_mps=vx,
                vy_mps=vy,
                tod_seconds=tod_seconds,
                altitude_ft=altitude_ft,
                sac=self.config.sac,
                sic=self.config.sic,
                status_octet=0,
            )

            self.store.ingest(
                RawPacket(payload=pkt, source=f"opensky:{icao24}", received_at=datetime.now(timezone.utc))
            )
            count += 1

        return count

    def _resolve_track_number(self, icao24: str) -> int:
        existing = self._icao_to_track.get(icao24)
        if existing is not None:
            return existing

        try:
            base = int(icao24, 16) & 0xFFFF
        except ValueError:
            base = abs(hash(icao24)) & 0xFFFF

        cand = base
        for _ in range(65536):
            owner = self._track_to_icao.get(cand)
            if owner is None or owner == icao24:
                self._track_to_icao[cand] = icao24
                self._icao_to_track[icao24] = cand
                return cand
            cand = (cand + 1) & 0xFFFF

        # Extremely unlikely fallback.
        return base

    def _fetch_states(self) -> dict:
        base = "https://opensky-network.org/api/states/all"
        params = {}
        if self.config.bbox:
            lamin, lomin, lamax, lomax = self.config.bbox
            params = {
                "lamin": str(lamin),
                "lomin": str(lomin),
                "lamax": str(lamax),
                "lomax": str(lomax),
            }

        url = base
        if params:
            url += "?" + urllib.parse.urlencode(params)

        req = urllib.request.Request(url=url, method="GET")
        if self.config.username and self.config.password:
            token = base64.b64encode(f"{self.config.username}:{self.config.password}".encode("utf-8")).decode("ascii")
            req.add_header("Authorization", f"Basic {token}")

        ssl_ctx = self._build_ssl_context()
        try:
            with urllib.request.urlopen(req, timeout=20, context=ssl_ctx) as resp:  # noqa: S310
                payload = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                retry_after_raw = exc.headers.get("Retry-After")
                retry_after_s = None
                if retry_after_raw:
                    try:
                        retry_after_s = float(retry_after_raw)
                    except ValueError:
                        retry_after_s = None
                raise RateLimitError("OpenSky rate limit (HTTP 429)", retry_after_s=retry_after_s) from exc
            raise

        return json.loads(payload)

    def _build_ssl_context(self) -> ssl.SSLContext:
        if not self.config.verify_ssl:
            return ssl._create_unverified_context()

        cafile = self.config.ca_bundle_path
        if cafile:
            p = Path(cafile)
            if not p.exists() or not p.is_file():
                raise FileNotFoundError(f"CA bundle not found: {cafile}")
            return ssl.create_default_context(cafile=str(p))

        return ssl.create_default_context()

    def status(self) -> dict[str, object]:
        bbox = None
        if self.config.bbox:
            bbox = {
                "lamin": self.config.bbox[0],
                "lomin": self.config.bbox[1],
                "lamax": self.config.bbox[2],
                "lomax": self.config.bbox[3],
            }
        return {
            "running": self.running,
            "interval_s": self.config.interval_s,
            "max_tracks": self.config.max_tracks,
            "bbox": bbox,
            "sac": self.config.sac,
            "sic": self.config.sic,
            "verify_ssl": self.config.verify_ssl,
            "ca_bundle_path": self.config.ca_bundle_path,
            "last_fetch_utc": self.last_fetch_utc,
            "last_ingested": self.last_ingested,
            "last_error": self.last_error,
            "backoff_s": self._backoff_s,
            "consecutive_429": self._consecutive_429,
            "rate_limited_until": self._rate_limited_until.isoformat() if self._rate_limited_until else None,
            "authenticated": bool(self.config.username and self.config.password),
        }
