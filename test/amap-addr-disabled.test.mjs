import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The switch is frozen into config at import time, so this process runs with
// the feature left off — the state every deployment starts from.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "tesla-butler-amap-off-"));
process.env.TICKET_PROJECT_ROOT = sandbox;
delete process.env.TICKET_ADDR_BACKFILL_ENABLED;
delete process.env.AMAP_KEY;
const { applyAddressLabels } = await import("../src/amap-addr.mjs");

test("no request is made and no label is written while the feature is off", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not be called"); });
  const trip = {
    start_lat: 30.3, start_lng: 120.09, end_lat: 30.31, end_lng: 120.1,
    start_road: null, end_road: null, start_area: null, end_area: null
  };
  assert.equal(await applyAddressLabels(trip, { signal: new AbortController().signal }), trip);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(trip.start_road, null);
  await fs.rm(sandbox, { recursive: true, force: true });
});
