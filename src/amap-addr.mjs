// AMap-backed address backfill for freshly completed drives.
//
// On mainland-China home networks nominatim.openstreetmap.org is
// unreachable (DNS pollution + IP blocks), so TeslaMate cannot geocode
// drives and start_address_id/end_address_id stay NULL, leaving trip
// cards with 起点/终点未知. Before announcing a completed trip, the
// worker calls backfillDriveAddresses() to reverse-geocode the missing
// endpoints via AMap (reachable directly from CN), upsert them into the
// addresses table (osm_type='shim', coordinate-derived osm_id so
// re-runs are idempotent) and link them to the drives. Best-effort by
// design: callers must swallow failures so a broken AMap key never
// blocks the trip card itself.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config, projectPath } from "./config.mjs";
import { runFile } from "./lib/process.mjs";

const composeArgs = [
  "compose",
  "--env-file", projectPath("infra", "teslamate", ".env"),
  "-f", projectPath("infra", "teslamate", "compose.yaml")
];

async function db(sql) {
  const { stdout } = await runFile(config.dockerCli, [
    ...composeArgs, "exec", "-T", "database",
    "psql", "-X", "-q", "-t", "-A", "-F", "|", "-U", "teslamate", "-d", "teslamate",
    "-c", sql
  ], { timeout: 30_000 });
  return stdout.trim();
}

async function amapRegeo(lat, lng) {
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${config.amapKey}&location=${lng},${lat}&radius=200&extensions=base`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const payload = await response.json();
  if (String(payload.status) !== "1") throw new Error(`amap status ${payload.status}: ${payload.info}`);
  const component = payload.regeocode?.addressComponent || {};
  const arrayOr = (value, fallback) => Array.isArray(value) ? fallback : (value || fallback);
  if (!payload.regeocode.formatted_address) return null;
  return {
    display_name: payload.regeocode.formatted_address,
    road: component.street || component.township || null,
    neighbourhood: component.township || null,
    city: arrayOr(component.city, component.province),
    county: arrayOr(component.district, null),
    state: component.province || null,
    country: component.country || "中国"
  };
}

const esc = (value) => String(value).replace(/'/g, "''");

async function upsertAddress(coord, address) {
  const [lat, lng] = coord.split(",").map(Number);
  const shimId = 90000000 + (Math.abs(Math.round(lat * 1e5) * 31 + Math.round(lng * 1e5)) % 1000000);
  const values = [
    `'${esc(address.display_name)}'`, lat, lng,
    address.road ? `'${esc(address.road)}'` : "NULL",
    address.neighbourhood ? `'${esc(address.neighbourhood)}'` : "NULL",
    address.city ? `'${esc(address.city)}'` : "NULL",
    address.county ? `'${esc(address.county)}'` : "NULL",
    address.state ? `'${esc(address.state)}'` : "NULL",
    address.country ? `'${esc(address.country)}'` : "NULL",
    `'${esc(JSON.stringify(address))}'`
  ];
  const sql = "WITH upsert AS (INSERT INTO addresses (display_name, latitude, longitude, road, neighbourhood, city, county, state, country, raw, inserted_at, updated_at, osm_id, osm_type) "
    + `VALUES (${values.join(", ")}, now(), now(), ${shimId}, 'shim') `
    + "ON CONFLICT (osm_id, osm_type) DO UPDATE SET updated_at = now() RETURNING id) SELECT id FROM upsert";
  const result = await db(sql);
  const id = parseInt(result.split("\n").pop(), 10);
  return Number.isFinite(id) ? id : null;
}

/**
 * Backfill missing start/end addresses for the given drives (or for all
 * drives that lack them when driveIds is omitted). Returns the number of
 * address slots filled.
 */
export async function backfillDriveAddresses(driveIds = []) {
  const idFilter = Array.isArray(driveIds) && driveIds.length
    ? `AND d.id IN (${driveIds.map((id) => parseInt(id, 10)).filter(Number.isFinite).join(",") || "0"})`
    : "";
  const rows = await db(`
    SELECT d.id AS id,
           round(sp.latitude::numeric, 6) || ',' || round(sp.longitude::numeric, 6) AS sll,
           round(ep.latitude::numeric, 6) || ',' || round(ep.longitude::numeric, 6) AS ell
    FROM drives d
    LEFT JOIN positions sp ON sp.id = d.start_position_id
    LEFT JOIN positions ep ON ep.id = d.end_position_id
    WHERE (d.start_address_id IS NULL OR d.end_address_id IS NULL) ${idFilter}
    ORDER BY d.id`);
  if (!rows) return 0;
  const drives = rows.split("\n").filter(Boolean).map((line) => {
    const [id, sll, ell] = line.split("|");
    return { id: parseInt(id, 10), sll, ell };
  });

  const coordCache = new Map();
  const addrCache = new Map();
  let filled = 0;
  for (const drive of drives) {
    for (const [coord, column] of [[drive.sll, "start_address_id"], [drive.ell, "end_address_id"]]) {
      // TeslaMate may not have written the end position yet right after
      // parking; skip that endpoint (a later pass picks it up).
      if (!coord || !coord.includes(",") || coord.startsWith("NULL")) continue;
      let addressId = addrCache.get(coord);
      if (addressId === undefined) {
        const [lat, lng] = coord.split(",").map(Number);
        let address = null;
        try {
          address = await amapRegeo(lat, lng);
        } catch (error) {
          address = null;
          console.warn(`[${new Date().toISOString()}] amap regeo failed for ${coord}: ${error.message}`);
        }
        if (!address) {
          addrCache.set(coord, null);
          continue;
        }
        addressId = await upsertAddress(coord, address);
        addrCache.set(coord, addressId);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (!addressId) continue;
      await db(`UPDATE drives SET ${column} = ${addressId} WHERE id = ${drive.id} AND ${column} IS NULL`);
      filled += 1;
    }
  }
  return filled;
}
