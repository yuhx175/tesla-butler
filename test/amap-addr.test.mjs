import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The switch, the key and the cache location are frozen into config at
// import time, and the cache must not touch the real data directory.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "tesla-butler-amap-addr-"));
process.env.TICKET_PROJECT_ROOT = sandbox;
process.env.AMAP_KEY = "test-key";
process.env.TICKET_ADDR_BACKFILL_ENABLED = "1";
const { applyAddressLabels } = await import("../src/amap-addr.mjs");

// Let already-scheduled promise continuations run before the clock moves on.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const regeo = (roads) => ({ status: "1", regeocode: { addressComponent: { province: "P", city: "C" }, roads } });
const road = (name, distance) => ({ name, distance: String(distance) });
const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" }
});

// Labels are cached by coordinate, so every trip needs its own points.
let sequence = 0;
const point = () => ({ lat: 30 + (sequence += 1) / 1000, lng: 120 });
const tripBetween = (start, end = point()) => ({
  start_lat: start.lat, start_lng: start.lng, end_lat: end.lat, end_lng: end.lng,
  start_road: null, end_road: null, start_area: null, end_area: null
});
// A trip whose end has no position yet, so only the start can be looked up.
const startOnly = () => ({ ...tripBetween(point()), end_lat: null, end_lng: null });

// Stands in for a request that is on the wire when the budget ends.
const onTheWire = () => (url, { signal }) => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test.after(async () => {
  await flush();
  // A cache write queued by the last lookup can still be in flight here.
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test("fills both missing endpoints", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; return jsonResponse(regeo([road("alpha-road", 12)])); });
  const trip = tripBetween(point());
  assert.equal(await applyAddressLabels(trip), trip);
  assert.equal(trip.start_road, "alpha-road");
  assert.equal(trip.end_road, "alpha-road");
  assert.equal(trip.start_area, "C");
  assert.equal(requests, 2);
});

test("the nearest vehicular road within 400m names the endpoint", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(regeo([
    road("滨河健身绿道", 5), road("alpha-road", 40), road("far-road", 800)
  ])));
  const trip = startOnly();
  await applyAddressLabels(trip);
  assert.equal(trip.start_road, "alpha-road");
});

test("resolved labels are reused from the cache without another request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; return jsonResponse(regeo([road("alpha-road", 12)])); });
  const trip = startOnly();
  await applyAddressLabels(trip);
  const again = { ...trip, start_road: null };
  await applyAddressLabels(again);
  assert.equal(again.start_road, "alpha-road");
  assert.equal(requests, 1);
});

test("a transient failure is retried with backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    if (requests === 1) throw new TypeError("fetch failed");
    return jsonResponse(regeo([road("alpha-road", 12)]));
  });
  const trip = startOnly();
  const pending = applyAddressLabels(trip);
  await flush();
  t.mock.timers.tick(2_000);
  assert.equal((await pending).start_road, "alpha-road");
  assert.equal(requests, 2);
});

test("gives up after three attempts and logs a stable code without coordinates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(line));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; throw new TypeError("fetch failed at 30.1,120.0"); });
  const trip = startOnly();
  const pending = applyAddressLabels(trip);
  await flush();
  t.mock.timers.tick(2_000);
  await flush();
  t.mock.timers.tick(4_000);
  await pending;
  assert.equal(requests, 3);
  assert.equal(trip.start_road, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /address label resolve failed code=AMAP_RESOLVE_FAILED$/);
  assert.doesNotMatch(warnings[0], /30\.|120\.|test-key/);
});

test("a lookup still on the wire when the budget ends is dropped and not retried", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(line));
  const fetch = t.mock.method(globalThis, "fetch", onTheWire());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20_000);
  const trip = startOnly();
  const pending = applyAddressLabels(trip, { signal: controller.signal });
  await flush();
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.timers.tick(20_000);
  assert.equal(await pending, trip);
  assert.equal(trip.start_road, null);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(warnings.map((line) => line.replace(/^\[[^\]]+\] /, "")), ["address label resolve aborted code=AbortError"]);
});

test("a slow endpoint cannot use up the time the other endpoint needs", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  // Endpoints are looked up in trip order: the start never answers, the end does.
  let requests = 0;
  t.mock.method(globalThis, "fetch", (url, options) => {
    requests += 1;
    return requests === 1 ? onTheWire()(url, options) : Promise.resolve(jsonResponse(regeo([road("beta-road", 12)])));
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20_000);
  const trip = tripBetween(point());
  const pending = applyAddressLabels(trip, { signal: controller.signal });
  await flush();
  assert.equal(trip.end_road, "beta-road");
  t.mock.timers.tick(20_000);
  assert.equal(await pending, trip);
  assert.equal(trip.start_road, null);
  assert.equal(requests, 2);
});

test("no request is made once the budget is already spent", async (t) => {
  t.mock.method(console, "warn", () => {});
  const fetch = t.mock.method(globalThis, "fetch", onTheWire());
  const controller = new AbortController();
  controller.abort();
  const trip = tripBetween(point());
  assert.equal(await applyAddressLabels(trip, { signal: controller.signal }), trip);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(trip.start_road, null);
});
