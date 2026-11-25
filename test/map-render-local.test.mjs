import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Rendering mode is frozen into config at import time, so local mode gets a
// process of its own; the project root is redirected so no test output lands
// in the real data directory.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "tesla-butler-map-local-"));
process.env.TICKET_PROJECT_ROOT = sandbox;
process.env.TICKET_CHROME_PROFILE_DIR = path.join(sandbox, "chrome-profile");
delete process.env.TICKET_MAP_RENDER_URL;
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

test("a local render warms the Chrome profile before its first real launch", async () => {
  const timeline = [];
  const result = await renderRoutePreview(route, "test-map-render-local", { start: "A", end: "B" }, {
    runFile: async (file, args) => {
      const isWarmup = args.includes("--window-size=256,256");
      timeline.push(isWarmup ? "warmup" : "render");
      // Stand in for Chrome: land a screenshot where the flags say to.
      await fs.writeFile(args.find((arg) => arg.startsWith("--screenshot=")).slice("--screenshot=".length), fakePng);
    },
    fetch: async () => {
      timeline.push("tile_fetch");
      return new Response(fakePng, { headers: { "content-type": "image/png" } });
    }
  });
  try {
    assert.equal(result.hasBasemap, true);
    // Exactly one warmup, and nothing else touches Chrome before it is done.
    assert.deepEqual(timeline, ["warmup", "tile_fetch", "render"]);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
