# ASTERIX Visualizer (MVP)

Lightweight ASTERIX visualizer for CAT062 validation, live tracking, and real integration testing.

## Features

- UDP ingest (default `0.0.0.0:30062`)
- Optional UDP multicast join
- ASTERIX structural parser (`CAT`, `LEN`, FSPEC)
- CAT062 decode + validation checks
- Active tracks API and per-track history trails
- Track kinematics display including speed magnitude and altitude
- Metric display by default with UI toggle to aeronautical units
- Heading-aware map markers (triangle) and projected future plot
- Basemap view (Leaflet + OpenStreetMap)
- Replay controls (load/start/stop/speed/loop)
- Direct hex packet ingest API/UI
- OpenSky live bridge (poll live aircraft states and convert to CAT062)
  - Stable aircraft-to-track mapping to improve continuity over time

## Quick Start

1. Create and activate a virtual environment.
2. Install dependencies:
   - `pip install -e .`
3. Run:
   - `uvicorn asterix_viz.main:app --reload`
4. Open:
   - `http://127.0.0.1:8000`

## Live UDP Configuration

Configure before start:

- `ASTERIX_UDP_HOST` (default `0.0.0.0`)
- `ASTERIX_UDP_PORT` (default `30062`)
- `ASTERIX_UDP_MULTICAST_GROUP` (optional, example `239.1.2.3`)
- `ASTERIX_UDP_MULTICAST_IFACE` (default `0.0.0.0`)

Example:

```bash
ASTERIX_UDP_PORT=30062 uvicorn asterix_viz.main:app --reload
```

## OpenSky Bridge (Online Data Flow)

Start it from the UI (`Start OpenSky`) or by API:

```bash
curl -X POST http://127.0.0.1:8000/api/opensky/start \
  -H 'Content-Type: application/json' \
  -d '{
    "interval_s": 10,
    "max_tracks": 200,
    "sac": 1,
    "sic": 99,
    "bbox": {"lamin": 24.0, "lomin": -125.0, "lamax": 50.0, "lomax": -66.0}
  }'
```

Optional credentials (higher/steadier rate limits depending on OpenSky policy):

```json
{
  "username": "your_opensky_user",
  "password": "your_opensky_password"
}
```

If you hit `SSL: CERTIFICATE_VERIFY_FAILED`, use one of:

1. Preferred: provide your CA bundle path:

```json
{
  "ca_bundle_path": "/etc/ssl/certs/ca-certificates.crt",
  "verify_ssl": true
}
```

2. Debug fallback only: disable SSL verification:

```json
{
  "verify_ssl": false
}
```

Stop and status:

```bash
curl -X POST http://127.0.0.1:8000/api/opensky/stop
curl http://127.0.0.1:8000/api/opensky/status
```

## API

- `GET /api/health`
- `GET /api/packets?limit=100`
- `GET /api/tracks`
- `GET /api/track?key=1-99:345`
- `GET /api/track/history?key=1-99:345&limit=500`
- `POST /api/ingest/hex`
- `POST /api/opensky/start`
- `POST /api/opensky/stop`
- `GET /api/opensky/status`
- `POST /api/samples/generate?count=20`
- `POST /api/replay/load_demo?count=120&interval_ms=200`
- `POST /api/replay/load_default_file`
- `POST /api/replay/load_file?path=src/asterix_viz/data/replay_demo.hex`
- `POST /api/replay/start?speed=1.0&loop=false`
- `POST /api/replay/stop`

`POST /api/ingest/hex` body example:

```json
{
  "hex": "3e00169b0c0163...",
  "source": "pipeline:test"
}
```

## Replay File Format

Text file, one packet per line:

- `HEX_PAYLOAD`
- `DELAY_MS HEX_PAYLOAD`

A demo file is included at:

- `src/asterix_viz/data/replay_demo.hex`
- `src/asterix_viz/data/external/cat062_multitrack_5k.hex` (recommended for track testing)

## External UDP Sender Tool

```bash
python3 tools/send_replay_udp.py src/asterix_viz/data/replay_demo.hex --host 127.0.0.1 --port 30062
```

Loop and accelerate:

```bash
python3 tools/send_replay_udp.py src/asterix_viz/data/replay_demo.hex --host 127.0.0.1 --port 30062 --loop --speed 4.0
```
