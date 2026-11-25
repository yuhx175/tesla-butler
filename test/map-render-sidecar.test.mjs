import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The sidecar switch is frozen into config at import time, so it has to be
// set beforehand; the project root is redirected so no test output lands in
// the real data directory.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "tesla-butler-map-sidecar-"));
process.env.TICKET_PROJECT_ROOT = sandbox;
process.env.TICKET_CHROME_PROFILE_DIR = path.join(sandbox, "chrome-profile");
process.env.TICKET_MAP_RENDER_URL = "http://maprender.test:9102/";
const { renderRoutePreview } = await import("../src/map.mjs");

const route = [
  { lat: 30.3, lng: 120.09, drive_id: 1 },
  { lat: 30.31, lng: 120.1, drive_id: 1 }
];
// Only the signature and the minimum size are checked on this path.
const fakePng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(10_000)
]);

test("sidecar rendering never launches a local Chrome, so a hung one cannot stall the render queue", async () => {
  let localLaunches = 0;
  const sidecarRequests = [];
  const result = await renderRoutePreview(route, "test-map-render-sidecar", { start: "A", end: "B" }, {
    runFile: () => { localLaunches += 1; throw new Error("local Chrome must not be launched in sidecar mode"); },
    fetch: async (url, options) => {
      sidecarRequests.push({ url, hasSignal: Boolean(options?.signal) });
      return new Response(fakePng, { status: 200 });
    }
  });
  try {
    assert.equal(localLaunches, 0);
    assert.deepEqual(sidecarRequests, [{ url: "http://maprender.test:9102/render", hasSignal: true }]);
    assert.equal(result.hasBasemap, true);
    assert.equal((await fs.readFile(result.path)).length, fakePng.length);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
