// AMap-backed address label resolution for freshly completed drives.
//
// On mainland-China home networks nominatim.openstreetmap.org is
// unreachable (DNS pollution + IP blocks), so TeslaMate cannot geocode
// drives and trip cards would show 起点/终点未知. When explicitly
// enabled (TICKET_ADDR_BACKFILL_ENABLED=1 + AMAP_KEY), this module
// reverse-geocodes missing endpoints via AMap — reachable directly
// from CN — and caches results in this tool's OWN storage
// (data/processed/amap-addresses.json).
//
// Boundary: read-only towards TeslaMate. Nothing here writes the
// addresses or drives tables; resolved labels are returned to the
// caller for display only. Coordinates are converted WGS-84 → GCJ-02
// before hitting AMap. Failures never carry coordinates or addresses —
// error messages use stable codes only.
// A caller's signal bounds the work: once it is aborted no further
// request is started and the one on the wire is dropped.

import fs from "node:fs/promises";
import path from "node:path";
import { config, projectPath } from "./config.mjs";
import { wgs84ToGcj02 } from "./map.mjs";
import { abortableSleep } from "./query-runtime.mjs";

const STORAGE_PATH = projectPath("data", "processed", "amap-addresses-v2.json");
const RESOLVE_TIMEOUT_MS = 8_000;
const ROAD_MAX_DISTANCE_M = 400;
// Non-vehicular paths (greenways, boardwalks, fitness trails). A drive
// endpoint can never genuinely be on one; AMap still returns them in
// roads[] and they are often geometrically nearest to a garage-exit GPS
// fix, so they must be skipped in favour of the next-nearest real road.
const NON_VEHICULAR_PATH_RE = /(绿道|步道|绿廊|栈道|健身|跑道)/;

const state = {
  cache: null,          // Map<coordKey, label|null>
  cacheLoaded: false
};
let cacheWrite = Promise.resolve();

function coordKey(lat, lng) {
  return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
}

export function addressBackfillActive() {
  return Boolean(config.addressBackfillEnabled && config.amapKey);
}

async function loadCache() {
  if (state.cacheLoaded) return state.cache;
  state.cache = new Map();
  try {
    const raw = JSON.parse(await fs.readFile(STORAGE_PATH, "utf8"));
    for (const [key, value] of Object.entries(raw || {})) state.cache.set(key, value);
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      console.warn(`[${new Date().toISOString()}] amap address cache read failed code=${cause.code || "UNKNOWN"}`);
    }
  }
  state.cacheLoaded = true;
  return state.cache;
}

function persistCache() {
  // Writes are chained: concurrent endpoint resolutions must never interleave
  // their writes to the same file. Each write snapshots the cache as it starts.
  cacheWrite = cacheWrite.then(() => writeCache()).catch((cause) => {
    console.warn(`[${new Date().toISOString()}] amap address cache write failed code=${cause?.code || "UNKNOWN"}`);
  });
}

async function writeCache() {
  await fs.mkdir(path.dirname(STORAGE_PATH), { recursive: true, mode: 0o700 });
  const payload = {};
  for (const [key, value] of state.cache || new Map()) {
    if (value) payload[key] = value;
  }
  await fs.writeFile(STORAGE_PATH, JSON.stringify(payload, null, 1), { mode: 0o600 });
}

async function amapRegeo(gcjLat, gcjLng, signal) {
  const location = `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)}`; // AMap: lng first
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${config.amapKey}&location=${location}&radius=200&extensions=all`;
  // One lookup never takes longer than RESOLVE_TIMEOUT_MS; the caller's
  // budget can end it sooner.
  const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) {
    const error = new Error(`amap http ${response.status}`);
    error.code = "AMAP_HTTP";
    throw error;
  }
  const payload = await response.json();
  if (String(payload.status) !== "1") {
    // Auth/quota rejections carry no location data; keep stable codes only.
    const error = new Error(`amap request rejected (${payload.info || "unknown"})`);
    error.code = String(payload.infocode) === "10001" ? "AMAP_KEY_INVALID" : "AMAP_REJECTED";
    throw error;
  }
  return payload;
}

function extractLabel(regeocode) {
  const component = regeocode?.addressComponent || {};
  let nearestRoad = null;
  for (const road of Array.isArray(regeocode?.roads) ? regeocode.roads : []) {
    if (NON_VEHICULAR_PATH_RE.test(road.name || "")) continue;
    const distance = Number(road.distance);
    if (!Number.isFinite(distance) || distance > ROAD_MAX_DISTANCE_M) continue;
    if (!nearestRoad || distance < Number(nearestRoad.distance)) nearestRoad = road;
  }
  // addressComponent.street is township/subdistrict level; the roads list
  // carries actual road names (extensions=all).
  return {
    road: nearestRoad?.name || component.street || null,
    area: Array.isArray(component.city) ? component.province : (component.city || null)
  };
}

async function resolveLabel(coordKeyString, { signal } = {}) {
  const cache = await loadCache();
  const cached = cache.get(coordKeyString);
  if (cached !== undefined) return cached; // may be null (known-unresolvable)
  const [lat, lng] = coordKeyString.split(",").map(Number);
  const gcj = wgs84ToGcj02(lat, lng);
  let lastError = null;
  // Transient network/timeout failures were observed in production; retry
  // with backoff before giving up on a coordinate.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // Out of budget: neither a backoff nor another request is started.
    if (signal?.aborted) throw signal.reason;
    if (attempt > 1) await abortableSleep(2_000 * (attempt - 1), signal);
    try {
      const payload = await amapRegeo(gcj.lat, gcj.lng, signal);
      const label = extractLabel(payload.regeocode || {});
      cache.set(coordKeyString, label);
      persistCache();
      return label;
    } catch (cause) {
      lastError = cause;
    }
  }
  if (signal?.aborted) throw signal.reason;
  const error = new Error(`amap resolve failed code=${lastError?.code || lastError?.name || "UNKNOWN"}`);
  error.code = "AMAP_RESOLVE_FAILED";
  throw error;
}

/**
 * Fill in missing start_road / end_road labels on a trip object using the
 * AMap resolver. Read-only towards TeslaMate — resolved labels live in the
 * returned trip object and this tool's own cache, never in TeslaMate
 * tables. Never throws; resolution problems surface as console warnings.
 * An optional signal bounds the work: once it is aborted the labels that
 * are still missing stay missing, so a caller can always send the card.
 */
export async function applyAddressLabels(trip, { signal } = {}) {
  if (!config.addressBackfillEnabled || !config.amapKey || !trip) return trip;
  const endpoints = [
    { roadField: "start_road", areaField: "start_area", lat: trip.start_lat, lng: trip.start_lng },
    { roadField: "end_road", areaField: "end_area", lat: trip.end_lat, lng: trip.end_lng }
  ];
  // Both endpoints are looked up together under the same budget, so a slow
  // one cannot use up the time the other still needs.
  await Promise.all(endpoints.map((endpoint) => resolveEndpoint(trip, endpoint, signal)));
  return trip;
}

async function resolveEndpoint(trip, endpoint, signal) {
  if (trip[endpoint.roadField]) return;
  const lat = Number(endpoint.lat);
  const lng = Number(endpoint.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  try {
    const label = await resolveLabel(coordKey(lat, lng), { signal });
    if (!label) return;
    if (!trip[endpoint.roadField] && label.road) trip[endpoint.roadField] = label.road;
    if (!trip[endpoint.areaField] && label.area) trip[endpoint.areaField] = label.area;
  } catch (cause) {
    // A spent budget leaves this label to a later query; that is not a failure.
    const outcome = signal?.aborted ? "aborted" : "failed";
    const code = signal?.aborted ? (cause.name || "ABORTED") : (cause.code || "UNKNOWN");
    console.warn(`[${new Date().toISOString()}] address label resolve ${outcome} code=${code}`);
  }
}
