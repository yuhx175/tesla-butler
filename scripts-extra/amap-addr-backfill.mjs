// AMap-backed address backfill for TeslaMate drives.
//
// On mainland-China home networks nominatim.openstreetmap.org is
// unreachable (DNS pollution + IP blocks), so TeslaMate cannot geocode
// drives and start_address_id/end_address_id stay NULL — trip cards then
// show 起点/终点未知. This script finds such drives, reverse-geocodes
// their endpoints via the AMap regeo API (reachable directly from CN),
// inserts the result into the addresses table (osm_type='shim', osm_id
// derived from coordinates so re-runs are idempotent) and links it back
// to the drives. Run it on a loop (e.g. every 5 minutes) next to the
// worker; AMAP_KEY must be set in the environment.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const DOCKER = "/usr/local/bin/docker";
const DB = (sql) => run(DOCKER, ["exec", "tesla-saving-ticket-database-1", "psql", "-U", "teslamate", "-d", "teslamate", "-t", "-A", "-F", "|", "-c", sql], { timeout: 30000 }).then(r => r.stdout.trim());

async function amapRegeo(lat, lng) {
  const KEY = process.env.AMAP_KEY || "";
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${KEY}&location=${lng},${lat}&radius=200&extensions=base`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (String(j.status) !== "1") throw new Error("amap status " + j.status);
  const c = j.regeocode.addressComponent || {};
  if (!j.regeocode.formatted_address) return null;
  return {
    display: j.regeocode.formatted_address,
    road: c.street || c.township || null,
    neighbourhood: c.township || null,
    city: Array.isArray(c.city) ? (c.province || null) : (c.city || null),
    county: Array.isArray(c.district) ? null : (c.district || null),
    state: c.province || null,
    country: c.country || "中国"
  };
}

async function main() {
  const drives = (await DB(`
    SELECT d.id AS id,
           round(sp.latitude::numeric, 6) || ',' || round(sp.longitude::numeric, 6) AS sll,
           round(ep.latitude::numeric, 6) || ',' || round(ep.longitude::numeric, 6) AS ell
    FROM drives d
    JOIN positions sp ON sp.id = d.start_position_id
    JOIN positions ep ON ep.id = d.end_position_id
    WHERE d.start_address_id IS NULL OR d.end_address_id IS NULL
    ORDER BY d.id`)).split("\n").filter(Boolean).map(l => {
    const parts = l.split("|");
    return { id: parseInt(parts[0], 10), sll: parts[1], ell: parts[2] };
  });
  console.log("待补全行程数:", drives.length);

  const cache = new Map();
  async function addrFor(coord) {
    if (cache.has(coord)) return cache.get(coord);
    const [lat, lng] = coord.split(",").map(Number);
    const a = await amapRegeo(lat, lng);
    cache.set(coord, a);
    await new Promise(r => setTimeout(r, 300));
    return a;
  }
  async function upsertAddress(coord, a) {
    if (!a) return null;
    const [lat, lng] = coord.split(",").map(Number);
    const esc = (s) => (s || "").replace(/'/g, "''");
    const shimId = 90000000 + (Math.abs(Math.round(lat * 1e5) * 31 + Math.round(lng * 1e5)) % 1000000);
    const v = [
      "'" + esc(a.display) + "'", lat, lng,
      a.road ? "'" + esc(a.road) + "'" : "NULL",
      a.neighbourhood ? "'" + esc(a.neighbourhood) + "'" : "NULL",
      a.city ? "'" + esc(a.city) + "'" : "NULL",
      a.county ? "'" + esc(a.county) + "'" : "NULL",
      a.state ? "'" + esc(a.state) + "'" : "NULL",
      a.country ? "'" + esc(a.country) + "'" : "NULL",
      "'" + JSON.stringify(a).replace(/'/g, "''") + "'"
    ];
    const sql = "WITH upsert AS (INSERT INTO addresses (display_name, latitude, longitude, road, neighbourhood, city, county, state, country, raw, inserted_at, updated_at, osm_id, osm_type) VALUES (" + v.join(",") + ", now(), now(), " + shimId + ", 'shim') ON CONFLICT (osm_id, osm_type) DO UPDATE SET updated_at = now() RETURNING id) SELECT id FROM upsert";
    const r = await DB(sql);
    const id = parseInt(r.split("\n").pop(), 10);
    return Number.isFinite(id) ? id : null;
  }

  let fixed = 0;
  for (const d of drives) {
    for (const [coord, col] of [[d.sll, "start_address_id"], [d.ell, "end_address_id"]]) {
      const a = await addrFor(coord);
      if (!a) continue;
      const aid = await upsertAddress(coord, a);
      if (aid) {
        await DB(`UPDATE drives SET ${col} = ${aid} WHERE id = ${d.id} AND ${col} IS NULL`);
        fixed += 1;
      }
    }
  }
  console.log("回填完成:", fixed, "个地址槽位");
}
main().catch(e => { console.error("失败:", e.message); process.exit(1); });
