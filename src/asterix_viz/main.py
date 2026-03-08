from __future__ import annotations

import os
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .ingest import UdpIngestService
from .models import RawPacket
from .opensky import OpenSkyBridge, OpenSkyConfig
from .replay import ReplayFrame, ReplayService
from .roe import RoeEngine
from .samples import build_cat062_core_record, generate_raw_packets
from .store import PacketStore

app = FastAPI(title="ASTERIX Visualizer", version="0.4.0")
PARIS_100KM_BBOX = (47.96, 0.98, 49.76, 3.72)  # lamin, lomin, lamax, lomax

udp_host = os.getenv("ASTERIX_UDP_HOST", "0.0.0.0")
udp_port = int(os.getenv("ASTERIX_UDP_PORT", "30062"))
multicast_group = os.getenv("ASTERIX_UDP_MULTICAST_GROUP")
multicast_interface = os.getenv("ASTERIX_UDP_MULTICAST_IFACE", "0.0.0.0")

store = PacketStore(max_packets=5000)
ingest = UdpIngestService(
    store=store,
    host=udp_host,
    port=udp_port,
    multicast_group=multicast_group,
    multicast_interface=multicast_interface,
)
replay = ReplayService(store=store)
opensky = OpenSkyBridge(store=store)
roe = RoeEngine()

app.mount("/static", StaticFiles(directory="src/asterix_viz/static"), name="static")


@app.on_event("startup")
async def startup_event() -> None:
    await ingest.start()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await opensky.stop()
    await replay.stop()
    await ingest.stop()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse("src/asterix_viz/static/index.html")


@app.get("/api/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "udp_bind": {
            "host": ingest.host,
            "port": ingest.port,
            "multicast_group": ingest.multicast_group,
            "multicast_interface": ingest.multicast_interface,
        },
        "stats": store.stats(),
        "replay": replay.status(),
        "opensky": opensky.status(),
        "roe": roe.status(),
        "now_utc": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/packets")
async def packets(limit: int = Query(default=100, ge=1, le=1000)) -> dict[str, object]:
    rows = [asdict(p) for p in store.list_packets(limit=limit)]
    return {"items": rows, "count": len(rows)}


@app.get("/api/tracks")
async def tracks(include_stale: bool = Query(default=False)) -> dict[str, object]:
    rows = roe.enrich_tracks(store.list_tracks(include_stale=include_stale))
    return {"items": rows, "count": len(rows)}


@app.get("/api/track")
async def track_detail(key: str = Query(..., min_length=1)) -> dict[str, object]:
    row = store.get_track(key)
    if row is None:
        raise HTTPException(status_code=404, detail="Track not found.")
    return {"item": roe.enrich_track(row)}


@app.get("/api/track/history")
async def track_history(key: str = Query(..., min_length=1), limit: int = Query(default=200, ge=1, le=2000)) -> dict[str, object]:
    rows = store.get_track_history(key, limit=limit)
    return {"items": rows, "count": len(rows)}


@app.post("/api/ingest/hex")
async def ingest_hex(payload: dict = Body(...)) -> dict[str, object]:
    hex_payload = str(payload.get("hex", "")).strip()
    source = str(payload.get("source", "api:hex"))

    if not hex_payload:
        raise HTTPException(status_code=400, detail="Missing 'hex' field.")

    hex_clean = "".join(hex_payload.split())
    if len(hex_clean) % 2 != 0:
        raise HTTPException(status_code=400, detail="Hex payload length must be even.")

    try:
        raw_bytes = bytes.fromhex(hex_clean)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid hex payload: {exc}") from exc

    parsed = store.ingest(RawPacket(payload=raw_bytes, source=source, received_at=datetime.now(timezone.utc)))
    return {
        "packet_id": parsed.packet_id,
        "validation_ok": parsed.validation.ok,
        "errors": parsed.validation.errors,
        "warnings": parsed.validation.warnings,
    }


@app.post("/api/opensky/start")
async def opensky_start(payload: dict = Body(...)) -> dict[str, object]:
    interval_s = float(payload.get("interval_s", 10.0))
    max_tracks = int(payload.get("max_tracks", 200))
    sac = int(payload.get("sac", 1))
    sic = int(payload.get("sic", 99))
    username = payload.get("username")
    password = payload.get("password")
    verify_ssl = bool(payload.get("verify_ssl", True))
    ca_bundle_path = payload.get("ca_bundle_path")

    bbox_raw = payload.get("bbox")
    bbox = None
    if isinstance(bbox_raw, dict):
        try:
            bbox = (
                float(bbox_raw["lamin"]),
                float(bbox_raw["lomin"]),
                float(bbox_raw["lamax"]),
                float(bbox_raw["lomax"]),
            )
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail="Invalid bbox object.") from exc
    else:
        bbox = PARIS_100KM_BBOX

    if interval_s < 1.0:
        raise HTTPException(status_code=400, detail="interval_s must be >= 1.0")
    if max_tracks < 1 or max_tracks > 5000:
        raise HTTPException(status_code=400, detail="max_tracks must be between 1 and 5000")
    if sac < 0 or sac > 255 or sic < 0 or sic > 255:
        raise HTTPException(status_code=400, detail="sac/sic must be in 0..255")

    cfg = OpenSkyConfig(
        interval_s=interval_s,
        max_tracks=max_tracks,
        bbox=bbox,
        username=str(username) if username else None,
        password=str(password) if password else None,
        sac=sac,
        sic=sic,
        verify_ssl=verify_ssl,
        ca_bundle_path=str(ca_bundle_path) if ca_bundle_path else None,
    )
    await opensky.stop()
    await opensky.start(cfg)
    return {"status": opensky.status()}


@app.post("/api/opensky/stop")
async def opensky_stop() -> dict[str, object]:
    await opensky.stop()
    return {"status": opensky.status()}


@app.get("/api/opensky/status")
async def opensky_status() -> dict[str, object]:
    return {"status": opensky.status()}


@app.post("/api/samples/generate")
async def generate_samples(count: int = Query(default=20, ge=1, le=1000)) -> dict[str, object]:
    raws = generate_raw_packets(count)
    for raw in raws:
        store.ingest(raw)
    return {"ingested": len(raws), "stats": store.stats()}


@app.post("/api/replay/load_demo")
async def replay_load_demo(count: int = Query(default=60, ge=1, le=5000), interval_ms: int = Query(default=250, ge=0, le=5000)) -> dict[str, object]:
    frames: list[ReplayFrame] = []
    for i in range(count):
        payload = bytes([62])
        record = bytearray(build_cat062_core_record())

        track_num = 100 + (i % 5)
        record[-3:-1] = int(track_num).to_bytes(2, byteorder="big", signed=False)

        lon_raw = int.from_bytes(record[11:15], byteorder="big", signed=True)
        lon_raw += (i % 50) * 200
        record[11:15] = int(lon_raw).to_bytes(4, byteorder="big", signed=True)

        total_len = 3 + len(record)
        frame = payload + total_len.to_bytes(2, byteorder="big") + bytes(record)
        frames.append(ReplayFrame(delay_ms=interval_ms, payload=frame, source="replay:demo"))

    loaded = replay.load_frames(frames)
    return {"loaded": loaded, "status": replay.status()}


@app.post("/api/replay/load_default_file")
async def replay_load_default_file() -> dict[str, object]:
    file_path = Path("src/asterix_viz/data/replay_demo.hex").resolve()
    loaded = replay.load_from_hex_lines(file_path)
    return {"loaded": loaded, "status": replay.status(), "path": str(file_path)}


@app.post("/api/replay/load_file")
async def replay_load_file(path: str = Query(..., min_length=1)) -> dict[str, object]:
    file_path = Path(path)
    if not file_path.is_absolute():
        file_path = (Path.cwd() / file_path).resolve()

    try:
        file_path.relative_to(Path.cwd().resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Replay file path must be inside workspace.") from exc

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Replay file not found.")

    try:
        loaded = replay.load_from_hex_lines(file_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"loaded": loaded, "status": replay.status(), "path": str(file_path)}


@app.post("/api/replay/start")
async def replay_start(speed: float = Query(default=1.0, ge=0.1, le=20.0), loop: bool = Query(default=False)) -> dict[str, object]:
    try:
        await replay.start(speed=speed, loop=loop)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": replay.status()}


@app.post("/api/replay/stop")
async def replay_stop() -> dict[str, object]:
    await replay.stop()
    return {"status": replay.status()}


@app.post("/api/replay/pause")
async def replay_pause() -> dict[str, object]:
    await replay.stop()
    return {"status": replay.status()}


@app.post("/api/replay/step")
async def replay_step(count: int = Query(default=1, ge=1, le=5000)) -> dict[str, object]:
    try:
        ingested = replay.step(count=count)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ingested": ingested, "status": replay.status()}


@app.post("/api/replay/reset")
async def replay_reset() -> dict[str, object]:
    await replay.stop()
    replay.reset()
    return {"status": replay.status()}


@app.get("/api/replay/status")
async def replay_status() -> dict[str, object]:
    return {"status": replay.status()}


@app.get("/api/roe")
async def roe_status() -> dict[str, object]:
    return roe.status()


@app.post("/api/roe/operator_position")
async def roe_set_operator_position(payload: dict = Body(...)) -> dict[str, object]:
    try:
        lat = float(payload.get("lat_deg"))
        lon = float(payload.get("lon_deg"))
        alt = float(payload.get("alt_msl_m", 0.0))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Expected numeric lat_deg, lon_deg, alt_msl_m.") from exc
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        raise HTTPException(status_code=400, detail="Operator position out of range.")
    op = roe.set_operator_position(lat_deg=lat, lon_deg=lon, alt_msl_m=alt)
    return {"operator": op, "status": roe.status()}


@app.post("/api/roe/config")
async def roe_set_config(payload: dict = Body(...)) -> dict[str, object]:
    try:
        cfg = roe.set_config(
            green_m=float(payload.get("green_m", 30000.0)),
            amber_m=float(payload.get("amber_m", 15000.0)),
            red_m=float(payload.get("red_m", 5000.0)),
            red_horizon_s=float(payload.get("red_horizon_s", 60.0)),
            amber_horizon_s=float(payload.get("amber_horizon_s", 120.0)),
            hysteresis_s=float(payload.get("hysteresis_s", 5.0)),
            heading_uncertainty_deg=float(payload.get("heading_uncertainty_deg", 8.0)),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"config": cfg, "status": roe.status()}


@app.get("/api/alerts")
async def alerts(include_stale: bool = Query(default=False)) -> dict[str, object]:
    rows = roe.enrich_tracks(store.list_tracks(include_stale=include_stale))
    alert_rows = [r for r in rows if str((r.get("alert") or {}).get("level", "none")) != "none"]
    rank = {"red": 3, "amber": 2, "green": 1, "none": 0}
    alert_rows.sort(
        key=lambda r: (
            -rank.get(str((r.get("alert") or {}).get("level", "none")), 0),
            float((r.get("alert") or {}).get("distance_m") or 1e15),
        )
    )
    return {"items": alert_rows, "count": len(alert_rows)}
