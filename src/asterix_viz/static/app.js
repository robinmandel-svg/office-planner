const rowsEl = document.getElementById("packetRows");
const trackRowsEl = document.getElementById("trackRows");
const statsEl = document.getElementById("stats");
const replayStatsEl = document.getElementById("replayStats");
const statusMsgEl = document.getElementById("statusMsg");
const trackDetailEl = document.getElementById("trackDetail");
const alertRowsEl = document.getElementById("alertRows");
const placementModeBannerEl = document.getElementById("placementModeBanner");
const metricRedEl = document.getElementById("metricRed");
const metricAmberEl = document.getElementById("metricAmber");
const metricActiveEl = document.getElementById("metricActive");
const metricReplayEl = document.getElementById("metricReplay");
const toastEl = document.getElementById("toast");

const replayFileInput = document.getElementById("replayFileInput");
const loadFileBtn = document.getElementById("loadFileBtn");
const loadCat062Btn = document.getElementById("loadCat062Btn");
const loadCat062_5kBtn = document.getElementById("loadCat062_5kBtn");
const loadAdsbSmallBtn = document.getElementById("loadAdsbSmallBtn");

const playPauseBtn = document.getElementById("playPauseBtn");
const step1Btn = document.getElementById("step1Btn");
const step10Btn = document.getElementById("step10Btn");
const resetBtn = document.getElementById("resetBtn");
const speedInput = document.getElementById("speedInput");
const loopInput = document.getElementById("loopInput");

const altMinMInput = document.getElementById("altMinM");
const altMaxMInput = document.getElementById("altMaxM");
const bboxLamin = document.getElementById("bboxLamin");
const bboxLomin = document.getElementById("bboxLomin");
const bboxLamax = document.getElementById("bboxLamax");
const bboxLomax = document.getElementById("bboxLomax");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

const unitsSelect = document.getElementById("unitsSelect");
const predictionHorizonInput = document.getElementById("predictionHorizon");
const headingUncertaintyInput = document.getElementById("headingUncertainty");
const setOperatorPointBtn = document.getElementById("setOperatorPointBtn");
const operatorAltMslInput = document.getElementById("operatorAltMsl");
const roeGreenMInput = document.getElementById("roeGreenM");
const roeAmberMInput = document.getElementById("roeAmberM");
const roeRedMInput = document.getElementById("roeRedM");
const roeRedHorizonSInput = document.getElementById("roeRedHorizonS");
const roeAmberHorizonSInput = document.getElementById("roeAmberHorizonS");
const roeHysteresisSInput = document.getElementById("roeHysteresisS");
const applyRoeConfigBtn = document.getElementById("applyRoeConfigBtn");
const roeStatusMsgEl = document.getElementById("roeStatusMsg");
const roeEditableInputs = [
  operatorAltMslInput,
  roeGreenMInput,
  roeAmberMInput,
  roeRedMInput,
  roeRedHorizonSInput,
  roeAmberHorizonSInput,
  roeHysteresisSInput,
  headingUncertaintyInput,
];

let selectedTrackKey = null;
let selectedTrackHistory = [];
let unitsMode = "metric";
let replayRunning = false;
let mapAutoFitDone = false;
let placeOperatorMode = false;
let roeOperator = null;
let roeConfig = null;
let toastTimer = null;
let roeLastEditMs = 0;
const SELECT_HIGHLIGHT = "#60a5fa";
const SELECT_OUTLINE = "#e2e8f0";

const map = L.map("map", { zoomControl: true }).setView([48.8566, 2.3522], 6);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const trackLayer = L.layerGroup().addTo(map);
const trailLayer = L.layerGroup().addTo(map);
const predictionLayer = L.layerGroup().addTo(map);
const coneLayer = L.layerGroup().addTo(map);
const roeLayer = L.layerGroup().addTo(map);

function setRoeStatus(message, isError = false) {
  roeStatusMsgEl.textContent = message;
  roeStatusMsgEl.classList.toggle("bad", Boolean(isError));
  roeStatusMsgEl.classList.toggle("ok", !isError && Boolean(message));
}

function showToast(message, isError = false) {
  if (!toastEl) return;
  toastEl.textContent = String(message || "");
  toastEl.classList.remove("hidden");
  toastEl.classList.toggle("error", Boolean(isError));
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    toastEl.classList.add("hidden");
    toastEl.classList.remove("error");
  }, isError ? 5200 : 3000);
}

function updateMissionStrip(health, alertItems, visibleTracks) {
  const red = alertItems.filter((t) => String((t.alert || {}).level || "none") === "red").length;
  const amber = alertItems.filter((t) => String((t.alert || {}).level || "none") === "amber").length;
  const active = Number(health?.stats?.active_tracks ?? visibleTracks.length ?? 0);
  const replayRunningNow = Boolean(health?.replay?.running);
  const replayText = replayRunningNow ? `Running (${health?.replay?.speed ?? 1}x)` : "Paused";
  metricRedEl.textContent = String(red);
  metricAmberEl.textContent = String(amber);
  metricActiveEl.textContent = String(active);
  metricReplayEl.textContent = replayText;
}

function markRoeEdited() {
  roeLastEditMs = Date.now();
}

function isRoeEditActive() {
  const activeEl = document.activeElement;
  if (roeEditableInputs.includes(activeEl)) return true;
  return Date.now() - roeLastEditMs < 2000;
}

window.addEventListener("error", (ev) => {
  const msg = ev?.message ? String(ev.message) : "Unknown UI error";
  setRoeStatus(`UI error: ${msg}`, true);
  showToast(`UI error: ${msg}`, true);
});

function setPlacementMode(enabled) {
  placeOperatorMode = Boolean(enabled);
  setOperatorPointBtn.textContent = placeOperatorMode ? "Click Map to Reposition Operator..." : "Set Operator Point (Map Click)";
  const container = map.getContainer();
  container.classList.toggle("placement-mode", placeOperatorMode);
  setOperatorPointBtn.classList.toggle("active-mode", placeOperatorMode);
  if (placementModeBannerEl) {
    placementModeBannerEl.classList.toggle("hidden", !placeOperatorMode);
    if (placeOperatorMode) {
      placementModeBannerEl.textContent = "Placement mode active: click on map to place operator point.";
    }
  }
  if (placeOperatorMode) {
    setRoeStatus("Placement mode active. Click on map or a track symbol to place operator.");
    showToast("Placement mode active. Click on the map to place operator.");
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = "";
    try {
      const payload = await res.json();
      detail = payload.detail ? `: ${payload.detail}` : "";
    } catch (_err) {
      detail = "";
    }
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return await res.json();
}

function esc(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmtNum(v, n = 2) {
  return Number.isFinite(v) ? Number(v).toFixed(n) : "-";
}

function normalizeBearing(b) {
  if (!Number.isFinite(b)) return null;
  return (Number(b) % 360 + 360) % 360;
}

function speedLabel(mps) {
  if (!Number.isFinite(mps)) return "-";
  if (unitsMode === "aero") return `${fmtNum(Number(mps) * 1.94384, 1)} kt`;
  return `${fmtNum(Number(mps) * 3.6, 1)} km/h`;
}

function altitudeLabel(meters, feet) {
  if (unitsMode === "aero") return Number.isFinite(feet) ? `${fmtNum(feet, 0)} ft` : "-";
  return Number.isFinite(meters) ? `${fmtNum(meters, 0)} m` : "-";
}

function bearingLabel(deg) {
  const b = normalizeBearing(deg);
  return b == null ? "-" : `${fmtNum(b, 0)} deg`;
}

function distanceLabel(meters) {
  if (!Number.isFinite(meters)) return "-";
  if (unitsMode === "aero") return `${fmtNum(meters / 1852.0, 1)} NM`;
  if (meters >= 1000) return `${fmtNum(meters / 1000.0, 1)} km`;
  return `${fmtNum(meters, 0)} m`;
}

function levelBadge(level) {
  const v = String(level || "none").toLowerCase();
  return `<span class="badge level-${esc(v)}">${esc(v.toUpperCase())}</span>`;
}

function stateBadge(state) {
  const v = String(state || "unknown").toLowerCase();
  return `<span class="badge state-${esc(v)}">${esc(v.toUpperCase())}</span>`;
}

function qualityBadge(score) {
  const s = Number(score);
  const cls = Number.isFinite(s) ? (s >= 80 ? "q-good" : s >= 55 ? "q-mid" : "q-low") : "q-unk";
  return `<span class="badge ${cls}">${Number.isFinite(s) ? `${s}` : "-"}<\/span>`;
}

function angleDeltaDeg(aDeg, bDeg) {
  const a = normalizeBearing(aDeg);
  const b = normalizeBearing(bDeg);
  if (a == null || b == null) return NaN;
  let d = Math.abs(a - b);
  if (d > 180) d = 360 - d;
  return d;
}

function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return "-";
  if (s < 60) return `${fmtNum(s, 0)} s`;
  if (s < 3600) return `${fmtNum(Math.floor(s / 60), 0)} m ${fmtNum(s % 60, 0)} s`;
  return `${fmtNum(Math.floor(s / 3600), 0)} h ${fmtNum(Math.floor((s % 3600) / 60), 0)} m`;
}

function closingSpeedLabel(mps) {
  if (!Number.isFinite(mps)) return "-";
  if (unitsMode === "aero") return `${fmtNum(mps * 1.94384, 1)} kt`;
  return `${fmtNum(mps, 1)} m/s`;
}

function impactDirectionArrow(closingMps) {
  const v = Number(closingMps);
  if (!Number.isFinite(v)) return "";
  if (v > 1.0) return "↓";
  if (v < -1.0) return "↑";
  return "→";
}

function impactEstimate(track) {
  const alert = track?.alert || {};
  const cue = track?.operator_cue || {};
  const distance = Number(alert.distance_m);
  const speed = Number(track?.speed_mps);
  const bearing = Number(track?.bearing_deg);
  const azFromOp = Number(cue.azimuth_deg_true);
  const redRadius = Number(roeConfig?.red_m);

  if (!Number.isFinite(distance) || !Number.isFinite(speed) || !Number.isFinite(bearing) || !Number.isFinite(azFromOp) || !Number.isFinite(redRadius)) {
    return { ttiSeconds: NaN, label: "-", closingMps: NaN };
  }
  if (distance <= redRadius) {
    return { ttiSeconds: 0, label: "Inside red", closingMps: NaN };
  }

  const towardOperator = normalizeBearing(azFromOp + 180.0);
  const delta = angleDeltaDeg(bearing, towardOperator);
  const closing = Number.isFinite(delta) ? speed * Math.cos((delta * Math.PI) / 180.0) : NaN;
  if (!Number.isFinite(closing) || closing <= 1.0) {
    return { ttiSeconds: NaN, label: "Opening/Stable", closingMps: closing };
  }

  const tti = (distance - redRadius) / closing;
  if (!Number.isFinite(tti) || tti < 0) return { ttiSeconds: NaN, label: "-", closingMps: closing };
  return { ttiSeconds: tti, label: formatDuration(tti), closingMps: closing };
}

function headingFromV(vx, vy) {
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
  return normalizeBearing((Math.atan2(vx, vy) * 180) / Math.PI);
}

function optionalNumber(inputEl) {
  const raw = String(inputEl?.value ?? "").trim();
  if (!raw) return NaN;
  return Number(raw);
}

function timestampMs(v) {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

function verticalSpeedLabel(vsMps) {
  if (!Number.isFinite(vsMps)) return "-";
  if (unitsMode === "aero") {
    const fpm = vsMps * 196.850394;
    return `${fpm >= 0 ? "+" : ""}${fmtNum(fpm, 0)} ft/min`;
  }
  return `${vsMps >= 0 ? "+" : ""}${fmtNum(vsMps, 1)} m/s`;
}

function speedTrendFromAccel(accelMps2) {
  if (!Number.isFinite(accelMps2)) return { label: "Unknown", cls: "trend-unknown", delta: "-" };
  const perMinMps = accelMps2 * 60.0;
  const eps = 0.2;
  if (Math.abs(accelMps2) < eps) return { label: "Stable", cls: "trend-stable", delta: "~0" };
  const up = accelMps2 > 0;
  if (unitsMode === "aero") {
    const ktPerMin = perMinMps * 1.94384;
    return {
      label: up ? "Accelerating" : "Decelerating",
      cls: up ? "trend-up" : "trend-down",
      delta: `${up ? "+" : ""}${fmtNum(ktPerMin, 1)} kt/min`,
    };
  }
  const kmhPerMin = perMinMps * 3.6;
  return {
    label: up ? "Accelerating" : "Decelerating",
    cls: up ? "trend-up" : "trend-down",
    delta: `${up ? "+" : ""}${fmtNum(kmhPerMin, 1)} km/h/min`,
  };
}

function buildTrackKinematics(track, history) {
  const points = (history || []).filter((p) => p && Number.isFinite(timestampMs(p.ts)));
  if (points.length < 2) return { verticalSpeedMps: NaN, speedAccelMps2: NaN, trend: speedTrendFromAccel(NaN) };
  const latest = points[points.length - 1];
  const prev = points[points.length - 2];
  const dt = (timestampMs(latest.ts) - timestampMs(prev.ts)) / 1000.0;
  if (!Number.isFinite(dt) || dt <= 0) return { verticalSpeedMps: NaN, speedAccelMps2: NaN, trend: speedTrendFromAccel(NaN) };

  const altNow = Number(latest.altitude_m);
  const altPrev = Number(prev.altitude_m);
  const verticalSpeedMps = Number.isFinite(altNow) && Number.isFinite(altPrev) ? (altNow - altPrev) / dt : NaN;

  const speedNow = Number.isFinite(Number(latest.speed_mps)) ? Number(latest.speed_mps) : Number(track?.speed_mps);
  const speedPrev = Number(prev.speed_mps);
  const speedAccelMps2 = Number.isFinite(speedNow) && Number.isFinite(speedPrev) ? (speedNow - speedPrev) / dt : NaN;

  return { verticalSpeedMps, speedAccelMps2, trend: speedTrendFromAccel(speedAccelMps2) };
}

function centerMapOnTrack(track) {
  if (!track) return;
  const lat = Number(track.lat_deg);
  const lon = Number(track.lon_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const nextZoom = Math.max(map.getZoom(), 8);
  map.flyTo([lat, lon], nextZoom, { animate: true, duration: 0.5 });
}

function setRoeInputsFromStatus(status, force = false) {
  const cfg = status?.config || null;
  const op = status?.operator || null;
  const editing = !force && isRoeEditActive();
  if (cfg && !editing) {
    roeGreenMInput.value = fmtNum(cfg.green_m, 0);
    roeAmberMInput.value = fmtNum(cfg.amber_m, 0);
    roeRedMInput.value = fmtNum(cfg.red_m, 0);
    roeRedHorizonSInput.value = fmtNum(cfg.red_horizon_s, 0);
    roeAmberHorizonSInput.value = fmtNum(cfg.amber_horizon_s, 0);
    roeHysteresisSInput.value = fmtNum(cfg.hysteresis_s, 0);
    if (headingUncertaintyInput) {
      headingUncertaintyInput.value = fmtNum(cfg.heading_uncertainty_deg ?? 8, 0);
    }
  }
  if (op && Number.isFinite(Number(op.alt_msl_m)) && !editing) {
    operatorAltMslInput.value = fmtNum(op.alt_msl_m, 0);
  }
}

function ensureLocalRoeConfig() {
  if (roeConfig) return;
  roeConfig = {
    green_m: Number(roeGreenMInput.value || 30000),
    amber_m: Number(roeAmberMInput.value || 15000),
    red_m: Number(roeRedMInput.value || 5000),
    red_horizon_s: Number(roeRedHorizonSInput.value || 60),
    amber_horizon_s: Number(roeAmberHorizonSInput.value || 120),
    hysteresis_s: Number(roeHysteresisSInput.value || 5),
    heading_uncertainty_deg: headingUncertaintyDeg(),
  };
}

function renderRoeOnMap() {
  roeLayer.clearLayers();
  if (!roeOperator || !roeConfig) return;
  const lat = Number(roeOperator.lat_deg);
  const lon = Number(roeOperator.lon_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const opIcon = L.divIcon({
    className: "operator-pin-wrap",
    html: '<div class="operator-pin">OP</div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  const marker = L.marker([lat, lon], { draggable: true, icon: opIcon });
  marker.bindPopup(`Operator<br/>${fmtNum(lat, 5)}, ${fmtNum(lon, 5)}<br/>Alt ${fmtNum(roeOperator.alt_msl_m, 0)} m`);
  marker.on("dragend", async () => {
    const p = marker.getLatLng();
    await setOperatorPosition(p.lat, p.lng);
    await refresh();
  });
  marker.addTo(roeLayer);
  L.circleMarker([lat, lon], { radius: 6, color: "#ffffff", fillColor: "#38bdf8", fillOpacity: 0.9, weight: 2 }).addTo(roeLayer);

  L.circle([lat, lon], { radius: Number(roeConfig.green_m), color: "#22c55e", weight: 2.5, opacity: 0.95, fillOpacity: 0.08, dashArray: "8 6" }).addTo(roeLayer);
  L.circle([lat, lon], { radius: Number(roeConfig.amber_m), color: "#f59e0b", weight: 2.5, opacity: 0.95, fillOpacity: 0.1, dashArray: "7 5" }).addTo(roeLayer);
  L.circle([lat, lon], { radius: Number(roeConfig.red_m), color: "#ef4444", weight: 2.8, opacity: 1.0, fillOpacity: 0.12, dashArray: "6 4" }).addTo(roeLayer);
}

async function setOperatorPosition(latDeg, lonDeg) {
  const altM = Number(operatorAltMslInput.value || 0);
  if (!Number.isFinite(altM)) {
    throw new Error("Operator altitude is invalid.");
  }
  ensureLocalRoeConfig();
  roeOperator = {
    lat_deg: Number(latDeg),
    lon_deg: Number(lonDeg),
    alt_msl_m: altM,
    updated_at: new Date().toISOString(),
  };
  renderRoeOnMap();
  const res = await fetchJson("/api/roe/operator_position", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lat_deg: latDeg, lon_deg: lonDeg, alt_msl_m: altM }),
  });
  roeOperator = res?.status?.operator || res?.operator || null;
  roeConfig = res?.status?.config || roeConfig;
  renderRoeOnMap();
  setRoeStatus(`Operator set at ${fmtNum(latDeg, 4)}, ${fmtNum(lonDeg, 4)}.`);
  showToast(`Operator positioned at ${fmtNum(latDeg, 4)}, ${fmtNum(lonDeg, 4)}.`);
  map.flyTo([latDeg, lonDeg], Math.max(map.getZoom(), 9), { animate: true, duration: 0.45 });
}

async function handleOperatorPlacement(latDeg, lonDeg) {
  try {
    await setOperatorPosition(latDeg, lonDeg);
    setPlacementMode(false);
    await refresh();
  } catch (err) {
    setRoeStatus(`Operator placement error: ${err.message}`, true);
    showToast(`Operator placement error: ${err.message}`, true);
  }
}

function extractCore(record) {
  const items = record?.items || {};
  const track = items["I062/040"] ?? items["I021/161"] ?? "-";

  let pos = "-";
  if (items["I062/105"]) {
    const p = items["I062/105"];
    pos = `lat=${fmtNum(p.lat_deg, 5)} lon=${fmtNum(p.lon_deg, 5)}`;
  } else if (items["I021/131"]) {
    const p = items["I021/131"];
    pos = `lat=${fmtNum(p.lat_deg, 5)} lon=${fmtNum(p.lon_deg, 5)}`;
  } else if (items["I021/130"]) {
    const p = items["I021/130"];
    pos = `lat=${fmtNum(p.lat_deg, 5)} lon=${fmtNum(p.lon_deg, 5)}`;
  } else if (items["I062/100"]) {
    const p = items["I062/100"];
    pos = `x=${fmtNum(p.x_m, 0)}m y=${fmtNum(p.y_m, 0)}m`;
  }

  let attitude = "-";
  if (items["I062/185"]) {
    const v = items["I062/185"];
    const vx = Number(v.vx_mps);
    const vy = Number(v.vy_mps);
    const s = Number.isFinite(vx) && Number.isFinite(vy) ? Math.sqrt(vx * vx + vy * vy) : NaN;
    attitude = `${speedLabel(s)} | ${bearingLabel(headingFromV(vx, vy))}`;
  } else if (items["I021/160"]) {
    const v = items["I021/160"];
    attitude = `${speedLabel(Number(v.speed_mps))} | ${bearingLabel(Number(v.bearing_deg))}`;
  }

  let altitude = "-";
  if (items["I062/130"]) {
    const ft = Number(items["I062/130"].value_ft);
    altitude = altitudeLabel(Number.isFinite(ft) ? ft / 3.28084 : NaN, ft);
  } else if (items["I021/145"]) {
    const ft = Number(items["I021/145"].value_ft);
    altitude = altitudeLabel(Number.isFinite(ft) ? ft / 3.28084 : NaN, ft);
  }

  return { track, pos, attitude, altitude };
}

function triangleIcon(bearingDeg, selected, colorHex) {
  const fill = colorHex || "#22d3ee";
  const stroke = selected ? SELECT_OUTLINE : "rgba(15, 23, 42, 0.45)";
  const strokeWidth = selected ? 2.2 : 1.2;
  return L.divIcon({
    className: "track-triangle-icon",
    html: `<div class="track-triangle-wrap" style="transform: rotate(${fmtNum(bearingDeg, 1)}deg);">
      <svg class="track-triangle-svg" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <polygon points="9,1 17,17 1,17" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${fmtNum(strokeWidth, 1)}" stroke-linejoin="round" />
      </svg>
    </div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function predictPoint(latDeg, lonDeg, speedMps, bearingDeg, dtSeconds) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(speedMps) || !Number.isFinite(bearingDeg)) return null;
  const distance = speedMps * dtSeconds;
  const R = 6371000.0;
  const lat1 = (latDeg * Math.PI) / 180.0;
  const lon1 = (lonDeg * Math.PI) / 180.0;
  const brng = (bearingDeg * Math.PI) / 180.0;
  const ang = distance / R;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(ang) * Math.cos(lat1), Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: (lat2 * 180.0) / Math.PI, lon: ((lon2 * 180.0) / Math.PI + 540.0) % 360.0 - 180.0 };
}

function clampNumber(v, minV, maxV) {
  const n = Number(v);
  if (!Number.isFinite(n)) return minV;
  return Math.max(minV, Math.min(maxV, n));
}

function headingUncertaintyDeg() {
  if (!headingUncertaintyInput) return 8.0;
  return clampNumber(headingUncertaintyInput.value || 8, 0, 45);
}

function conePolygonPoints(track, horizonS, uncertaintyDeg, samples = 10) {
  const lat = Number(track?.lat_deg);
  const lon = Number(track?.lon_deg);
  const speed = Number(track?.speed_mps);
  const bearing = Number(track?.bearing_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(speed) || !Number.isFinite(bearing)) return null;
  const u = clampNumber(uncertaintyDeg, 0, 90);
  if (u <= 0 || horizonS <= 0) return null;

  const pts = [[lat, lon]];
  const count = Math.max(2, Number(samples) | 0);
  for (let i = 0; i <= count; i += 1) {
    const frac = i / count;
    const off = -u + frac * (2 * u);
    const p = predictPoint(lat, lon, speed, bearing + off, horizonS);
    if (!p) return null;
    pts.push([p.lat, p.lon]);
  }
  return pts;
}

function renderPackets(items) {
  rowsEl.innerHTML = items
    .map((p) => {
      const validClass = p.validation.ok ? "ok" : "bad";
      const core = extractCore((p.decoded_records || [])[0] || null);
      return `<tr>
        <td>${p.packet_id}</td>
        <td>${esc(p.received_at)}</td>
        <td>${esc(p.source)}</td>
        <td>${p.cat ?? "-"}</td>
        <td>${esc(core.track)}</td>
        <td>${esc(core.pos)}</td>
        <td>${esc(core.attitude)}</td>
        <td>${esc(core.altitude)}</td>
        <td class="${validClass}">${p.validation.ok ? "ok" : "bad"}</td>
      </tr>`;
    })
    .join("");
}

function renderTracks(items) {
  trackRowsEl.innerHTML = items
    .map((t) => {
      const selected = selectedTrackKey === t.key ? "selected" : "";
      const alertLevel = String((t.alert || {}).level || "none").toLowerCase();
      return `<tr class="clickable ${selected} alert-row-${esc(alertLevel)}" data-track-key="${esc(t.key)}" data-lat="${fmtNum(t.lat_deg, 8)}" data-lon="${fmtNum(t.lon_deg, 8)}">
        <td>${esc(t.key)}</td>
        <td>${levelBadge(alertLevel)}</td>
        <td>${stateBadge(t.lifecycle_state)}</td>
        <td>${qualityBadge(t.quality_score)}</td>
        <td>${fmtNum(t.age_seconds, 1)} s</td>
        <td>${fmtNum(t.lat_deg, 4)}</td>
        <td>${fmtNum(t.lon_deg, 4)}</td>
        <td>${speedLabel(t.speed_mps)}</td>
        <td>${bearingLabel(t.bearing_deg)}</td>
        <td>${altitudeLabel(t.altitude_m, t.altitude_ft)}</td>
        <td>${t.update_count}</td>
      </tr>`;
    })
    .join("");

  for (const row of trackRowsEl.querySelectorAll("tr[data-track-key]")) {
    row.addEventListener("click", async () => {
      selectedTrackKey = row.getAttribute("data-track-key");
      await loadTrackDetail();
      centerMapOnTrack({
        lat_deg: Number(row.getAttribute("data-lat")),
        lon_deg: Number(row.getAttribute("data-lon")),
      });
      await refresh();
    });
  }
}

function renderTrailOnMap(history) {
  trailLayer.clearLayers();
  const points = history.filter((p) => Number.isFinite(p.lat_deg) && Number.isFinite(p.lon_deg)).map((p) => [p.lat_deg, p.lon_deg]);
  if (points.length < 2) return;
  L.polyline(points, { color: SELECT_HIGHLIGHT, weight: 3, opacity: 0.92 }).addTo(trailLayer);
}

function renderAlerts(items) {
  alertRowsEl.innerHTML = items
    .map((t) => {
      const alert = t.alert || {};
      const cue = t.operator_cue || {};
      const impact = impactEstimate(t);
      const impactText = `${impact.label} ${impactDirectionArrow(impact.closingMps)}`.trim();
      const cueText = `az ${bearingLabel(cue.azimuth_deg_true)} el ${Number.isFinite(Number(cue.elevation_deg)) ? `${fmtNum(cue.elevation_deg, 1)} deg` : "-"}`;
      return `<tr class="clickable" data-track-key="${esc(t.key)}">
        <td>${esc(t.key)}</td>
        <td>${levelBadge(alert.level)}</td>
        <td>${esc(alert.reason || "-")}</td>
        <td>${distanceLabel(Number(alert.distance_m))}</td>
        <td>${esc(impactText)}</td>
        <td>${esc(cueText)}</td>
      </tr>`;
    })
    .join("");

  for (const row of alertRowsEl.querySelectorAll("tr[data-track-key]")) {
    row.addEventListener("click", async () => {
      selectedTrackKey = row.getAttribute("data-track-key");
      await loadTrackDetail();
      await refresh();
    });
  }
}

function renderMap(tracks) {
  trackLayer.clearLayers();
  predictionLayer.clearLayers();
  coneLayer.clearLayers();

  const horizon = Math.max(0, Number(predictionHorizonInput.value || 60));
  const uncertainty = headingUncertaintyDeg();
  const bounds = [];

  for (const t of tracks) {
    if (!Number.isFinite(t.lat_deg) || !Number.isFinite(t.lon_deg)) continue;
    const selected = selectedTrackKey === t.key;
    const bearing = normalizeBearing(t.bearing_deg);

    const alertLevel = String((t.alert || {}).level || "none").toLowerCase();
    const markerColor = alertLevel === "red" ? "#ef4444" : alertLevel === "amber" ? "#f59e0b" : alertLevel === "green" ? "#22c55e" : "#22d3ee";
    let marker;
    if (bearing != null) {
      marker = L.marker([t.lat_deg, t.lon_deg], { icon: triangleIcon(bearing, selected, markerColor) });
    } else {
      marker = L.circleMarker([t.lat_deg, t.lon_deg], {
        radius: selected ? 7 : 5,
        color: selected ? SELECT_HIGHLIGHT : markerColor,
        fillColor: markerColor,
        weight: 2,
        fillOpacity: 0.95,
      });
    }

    marker
      .bindPopup(`<b>${esc(t.key)}</b><br/>${levelBadge(alertLevel)} ${stateBadge(t.lifecycle_state)} q=${esc(String(t.quality_score ?? "-"))}<br/>${speedLabel(t.speed_mps)} | ${bearingLabel(t.bearing_deg)}<br/>${altitudeLabel(t.altitude_m, t.altitude_ft)}`)
      .on("click", async (ev) => {
        if (placeOperatorMode) {
          if (ev?.latlng) {
            await handleOperatorPlacement(ev.latlng.lat, ev.latlng.lng);
          } else {
            await handleOperatorPlacement(t.lat_deg, t.lon_deg);
          }
          return;
        }
        selectedTrackKey = t.key;
        await loadTrackDetail();
        centerMapOnTrack(t);
        await refresh();
      })
      .addTo(trackLayer);

    bounds.push([t.lat_deg, t.lon_deg]);

    const pred = predictPoint(t.lat_deg, t.lon_deg, Number(t.speed_mps), Number(t.bearing_deg), horizon);
    if (pred) {
      const lineColor = selected ? SELECT_HIGHLIGHT : "#94a3b8";
      L.polyline([[t.lat_deg, t.lon_deg], [pred.lat, pred.lon]], {
        color: lineColor,
        weight: selected ? 2.5 : 1.5,
        opacity: selected ? 0.85 : 0.45,
        dashArray: "5 5",
      }).addTo(predictionLayer);
      L.circleMarker([pred.lat, pred.lon], {
        radius: selected ? 4 : 3,
        color: lineColor,
        fillColor: lineColor,
        fillOpacity: selected ? 0.95 : 0.65,
        weight: 1,
      }).addTo(predictionLayer);
      bounds.push([pred.lat, pred.lon]);
    }

    const conePts = conePolygonPoints(t, horizon, uncertainty, 8);
    if (conePts) {
      const coneColor = selected ? SELECT_HIGHLIGHT : markerColor;
      L.polygon(conePts, {
        color: coneColor,
        weight: selected ? 1.8 : 1.0,
        opacity: selected ? 0.6 : 0.35,
        fillColor: coneColor,
        fillOpacity: selected ? 0.15 : 0.06,
      }).addTo(coneLayer);
      for (const p of conePts.slice(1)) {
        bounds.push(p);
      }
    }
  }

  if (bounds.length > 0 && !mapAutoFitDone) {
    map.fitBounds(bounds, { padding: [20, 20] });
    mapAutoFitDone = true;
  }

  renderTrailOnMap(selectedTrackHistory);
}

function renderTrackDetail(track, history) {
  if (!track) {
    trackDetailEl.innerHTML = '<div class="muted">No track selected.</div>';
    return;
  }

  const horizon = Math.max(0, Number(predictionHorizonInput.value || 60));
  const uncertainty = headingUncertaintyDeg();
  const pred = predictPoint(track.lat_deg, track.lon_deg, track.speed_mps, track.bearing_deg, horizon);
  const kin = buildTrackKinematics(track, history);
  const alert = track.alert || {};
  const cue = track.operator_cue || {};
  const impact = impactEstimate(track);

  trackDetailEl.innerHTML = `
    <div class="detail-grid">
      <div class="detail-card">
        <div class="label">Track ID</div>
        <div class="value mono">${esc(track.key)}</div>
        <div class="sub">Source ${esc(track.source_id)} | updates ${track.update_count}</div>
      </div>
      <div class="detail-card">
        <div class="label">Lifecycle</div>
        <div class="value">${stateBadge(track.lifecycle_state)} ${qualityBadge(track.quality_score)}</div>
        <div class="sub">${esc((track.quality_reasons || []).join(", ") || "No quality flags")}</div>
      </div>
      <div class="detail-card attitude">
        <div class="label">Attitude</div>
        <div class="attitude-grid">
          <div>
            <div class="metric-label">Speed</div>
            <div class="value">${speedLabel(track.speed_mps)}</div>
          </div>
          <div>
            <div class="metric-label">Bearing</div>
            <div class="value">${bearingLabel(track.bearing_deg)}</div>
          </div>
        </div>
        <div class="sub">Trend <span class="${kin.trend.cls}">${kin.trend.label}</span> (${kin.trend.delta})</div>
      </div>
      <div class="detail-card">
        <div class="label">Altitude</div>
        <div class="value">${altitudeLabel(track.altitude_m, track.altitude_ft)} <span class="inline-metric">| VS ${verticalSpeedLabel(kin.verticalSpeedMps)}</span></div>
        <div class="sub">Vertical trend from latest history points</div>
      </div>
      <div class="detail-card">
        <div class="label">ROE / Cue</div>
        <div class="value">${levelBadge(alert.level)}</div>
        <div class="sub">Reason ${esc(alert.reason || "-")} | Dist ${distanceLabel(Number(alert.distance_m))}</div>
        <div class="sub">Az ${bearingLabel(cue.azimuth_deg_true)} | El ${Number.isFinite(Number(cue.elevation_deg)) ? `${fmtNum(cue.elevation_deg, 1)} deg` : "-"}</div>
        <div class="sub">TTI (to red) ${esc(`${impact.label} ${impactDirectionArrow(impact.closingMps)}`.trim())} | Closing ${closingSpeedLabel(impact.closingMps)}</div>
      </div>
      <div class="detail-card">
        <div class="label">Timing</div>
        <div class="value">${fmtNum(track.age_seconds, 1)} s</div>
        <div class="sub">Age</div>
        <div class="value mono">${esc(track.last_update)}</div>
        <div class="sub">Last update (UTC)</div>
      </div>
      <div class="detail-card wide">
        <div class="label">Position</div>
        <div class="value">${fmtNum(track.lat_deg, 5)}, ${fmtNum(track.lon_deg, 5)}</div>
        <div class="sub">Status ${esc(track.status_raw ?? "-")} | ToD ${fmtNum(track.tod_seconds, 1)} s</div>
      </div>
      <div class="detail-card wide">
        <div class="label">Prediction (+${horizon}s, ±${fmtNum(uncertainty, 0)} deg)</div>
        <div class="value">${pred ? `${fmtNum(pred.lat, 5)}, ${fmtNum(pred.lon, 5)}` : "Unavailable"}</div>
        <div class="sub">Constant-speed projection with heading uncertainty cone</div>
      </div>
      <div class="detail-card wide">
        <div class="label">History</div>
        <div class="sub">${history.length} points</div>
      </div>
    </div>
  `;
}

async function loadTrackDetail() {
  if (!selectedTrackKey) {
    selectedTrackHistory = [];
    renderTrackDetail(null, []);
    return;
  }

  try {
    const [detail, history] = await Promise.all([
      fetchJson(`/api/track?key=${encodeURIComponent(selectedTrackKey)}`),
      fetchJson(`/api/track/history?key=${encodeURIComponent(selectedTrackKey)}&limit=500`),
    ]);
    selectedTrackHistory = history.items || [];
    renderTrackDetail(detail.item, selectedTrackHistory);
    renderTrailOnMap(selectedTrackHistory);
  } catch (err) {
    selectedTrackHistory = [];
    renderTrackDetail(null, []);
    statusMsgEl.textContent = `Track detail error: ${err.message}`;
  }
}

function parseFilterBbox() {
  const lamin = optionalNumber(bboxLamin);
  const lomin = optionalNumber(bboxLomin);
  const lamax = optionalNumber(bboxLamax);
  const lomax = optionalNumber(bboxLomax);
  const hasAny = [lamin, lomin, lamax, lomax].some((x) => Number.isFinite(x));
  if (!hasAny) return null;
  return { lamin, lomin, lamax, lomax };
}

function applyFilters(trackItems) {
  const altMin = optionalNumber(altMinMInput);
  const altMax = optionalNumber(altMaxMInput);
  const bbox = parseFilterBbox();

  return trackItems.filter((t) => {
    if (Number.isFinite(altMin)) {
      if (!Number.isFinite(t.altitude_m) || t.altitude_m < altMin) return false;
    }
    if (Number.isFinite(altMax)) {
      if (!Number.isFinite(t.altitude_m) || t.altitude_m > altMax) return false;
    }
    if (bbox) {
      if (!Number.isFinite(t.lat_deg) || !Number.isFinite(t.lon_deg)) return false;
      if (Number.isFinite(bbox.lamin) && t.lat_deg < bbox.lamin) return false;
      if (Number.isFinite(bbox.lamax) && t.lat_deg > bbox.lamax) return false;
      if (Number.isFinite(bbox.lomin) && t.lon_deg < bbox.lomin) return false;
      if (Number.isFinite(bbox.lomax) && t.lon_deg > bbox.lomax) return false;
    }
    return true;
  });
}

async function refresh() {
  const [health, packets, tracks, alerts, roeStatus] = await Promise.all([
    fetchJson("/api/health"),
    fetchJson("/api/packets?limit=150"),
    fetchJson("/api/tracks"),
    fetchJson("/api/alerts"),
    fetchJson("/api/roe"),
  ]);

  const allTracks = tracks.items || [];
  const visibleTracks = applyFilters(allTracks);
  const alertItems = alerts.items || [];
  roeConfig = roeStatus?.config || null;
  roeOperator = roeStatus?.operator || null;
  setRoeInputsFromStatus(roeStatus);
  renderRoeOnMap();

  replayRunning = Boolean(health.replay?.running);
  playPauseBtn.textContent = replayRunning ? "Pause" : "Play";
  setOperatorPointBtn.textContent = placeOperatorMode ? "Click Map to Reposition Operator..." : "Set Operator Point (Map Click)";
  setOperatorPointBtn.classList.toggle("active-mode", placeOperatorMode);
  if (placementModeBannerEl) {
    placementModeBannerEl.classList.toggle("hidden", !placeOperatorMode);
  }

  updateMissionStrip(health, alertItems, visibleTracks);
  statsEl.textContent = `Packets ${health.stats.total_packets} | malformed ${health.stats.malformed_packets} | CAT062 ${health.stats.cat062_packets} | decoded ${health.stats.decoded_packets} | visible tracks ${visibleTracks.length}`;
  replayStatsEl.textContent = `Replay frames ${health.replay.loaded_frames} | index ${health.replay.index} | remaining ${health.replay.remaining_frames} | speed ${health.replay.speed}x | loop ${health.replay.loop}`;

  if (selectedTrackKey && !visibleTracks.some((t) => t.key === selectedTrackKey)) {
    selectedTrackKey = null;
    selectedTrackHistory = [];
    renderTrackDetail(null, []);
  }

  renderPackets(packets.items || []);
  renderTracks(visibleTracks);
  renderAlerts(alertItems);
  renderMap(visibleTracks);

  if (selectedTrackKey) {
    await loadTrackDetail();
  }
}

async function loadReplayFile(path) {
  replayFileInput.value = path;
  selectedTrackKey = null;
  selectedTrackHistory = [];
  mapAutoFitDone = false;
  await fetchJson(`/api/replay/load_file?path=${encodeURIComponent(path)}`, { method: "POST" });
  await refresh();
  showToast(`Replay loaded: ${path}`);
}

loadFileBtn.addEventListener("click", async () => {
  const path = replayFileInput.value.trim();
  if (!path) {
    statusMsgEl.textContent = "Provide a replay file path.";
    return;
  }
  await loadReplayFile(path);
});

loadCat062Btn.addEventListener("click", async () => {
  await loadReplayFile("src/asterix_viz/data/external/cat062.hex");
});

loadCat062_5kBtn.addEventListener("click", async () => {
  await loadReplayFile("src/asterix_viz/data/external/cat062_multitrack_5k.hex");
});

loadAdsbSmallBtn.addEventListener("click", async () => {
  await loadReplayFile("src/asterix_viz/data/external/201002-lebl-080001_adsb_small.hex");
});

playPauseBtn.addEventListener("click", async () => {
  if (replayRunning) {
    await fetchJson("/api/replay/pause", { method: "POST" });
    showToast("Replay paused.");
  } else {
    const speed = Number(speedInput.value || 1.0);
    const loop = loopInput.checked;
    await fetchJson(`/api/replay/start?speed=${encodeURIComponent(speed)}&loop=${loop}`, { method: "POST" });
    showToast(`Replay started at ${fmtNum(speed, 1)}x.`);
  }
  await refresh();
});

step1Btn.addEventListener("click", async () => {
  await fetchJson("/api/replay/step?count=1", { method: "POST" });
  await refresh();
});

step10Btn.addEventListener("click", async () => {
  await fetchJson("/api/replay/step?count=10", { method: "POST" });
  await refresh();
});

resetBtn.addEventListener("click", async () => {
  await fetchJson("/api/replay/reset", { method: "POST" });
  mapAutoFitDone = false;
  await refresh();
  showToast("Replay reset.");
});

clearFiltersBtn.addEventListener("click", async () => {
  altMinMInput.value = "";
  altMaxMInput.value = "";
  bboxLamin.value = "";
  bboxLomin.value = "";
  bboxLamax.value = "";
  bboxLomax.value = "";
  await refresh();
  showToast("Filters cleared.");
});

function onSetOperatorPointClick() {
  const c = map.getCenter();
  setPlacementMode(true);
  setOperatorPosition(c.lat, c.lng)
    .then(() => {
      setRoeStatus("Operator placed at map center. Click map/track to reposition or drag OP marker.");
      return refresh();
    })
    .catch((err) => {
      setRoeStatus(`Operator placement warning: ${err.message}. You can still click map to place.`, true);
      showToast(`Operator placement warning: ${err.message}`, true);
    });
}

window.__onSetOperatorPointClick = onSetOperatorPointClick;
setOperatorPointBtn.onclick = onSetOperatorPointClick;

for (const inputEl of roeEditableInputs) {
  inputEl.addEventListener("input", markRoeEdited);
  inputEl.addEventListener("focus", markRoeEdited);
}

applyRoeConfigBtn.addEventListener("click", async () => {
  try {
    await fetchJson("/api/roe/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        green_m: Number(roeGreenMInput.value),
        amber_m: Number(roeAmberMInput.value),
        red_m: Number(roeRedMInput.value),
        red_horizon_s: Number(roeRedHorizonSInput.value),
        amber_horizon_s: Number(roeAmberHorizonSInput.value),
        hysteresis_s: Number(roeHysteresisSInput.value),
        heading_uncertainty_deg: headingUncertaintyDeg(),
      }),
    });
    setRoeStatus("ROE config applied.");
    showToast("ROE configuration applied.");
    roeLastEditMs = 0;
    await refresh();
  } catch (err) {
    setRoeStatus(`ROE config error: ${err.message}`, true);
    showToast(`ROE config error: ${err.message}`, true);
  }
});

map.on("click", async (ev) => {
  if (!placeOperatorMode) return;
  await handleOperatorPlacement(ev.latlng.lat, ev.latlng.lng);
});

unitsSelect.addEventListener("change", async () => {
  unitsMode = unitsSelect.value === "aero" ? "aero" : "metric";
  await refresh();
});

predictionHorizonInput.addEventListener("change", refresh);
if (headingUncertaintyInput) {
  headingUncertaintyInput.addEventListener("change", refresh);
  headingUncertaintyInput.addEventListener("input", refresh);
}
altMinMInput.addEventListener("change", refresh);
altMaxMInput.addEventListener("change", refresh);
bboxLamin.addEventListener("change", refresh);
bboxLomin.addEventListener("change", refresh);
bboxLamax.addEventListener("change", refresh);
bboxLomax.addEventListener("change", refresh);

setInterval(() => {
  refresh().catch((err) => {
    statusMsgEl.textContent = `refresh error: ${err.message}`;
  });
}, 1200);

refresh().catch((err) => {
  statusMsgEl.textContent = `startup error: ${err.message}`;
});

setRoeStatus("ROE controls ready.");
