import test from "node:test";
import assert from "node:assert/strict";
import { refreshTripForCard } from "../src/trip-refresh.mjs";

const segmentIds = [21, 22];
const snapshot = { segment_ids: segmentIds, distance_km: 4.8, start_road: null, end_road: null };
const request = { segmentIds, trip: snapshot, budgetMs: 20_000, intervalMs: 15_000 };

// Let already-scheduled promise continuations run before the clock moves on.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a re-query that never answers releases the card exactly when the budget is spent", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const startedAt = Date.now();
  let querySignal;
  const pending = refreshTripForCard(request, {
    getTrip: (ids, { signal }) => { querySignal = signal; return new Promise(() => {}); }
  });
  await flush();
  assert.equal(querySignal.aborted, false);
  t.mock.timers.tick(19_999);
  await flush();
  // Still inside the budget: the query keeps its chance to answer.
  assert.equal(querySignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, snapshot);
  assert.equal(Date.now() - startedAt, 20_000);
  assert.equal(querySignal.aborted, true);
});

test("with both labels missing the card goes out at the budget, not after a fixed number of waits", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const startedAt = Date.now();
  const fresh = { ...snapshot };
  const logs = [];
  let queries = 0;
  const pending = refreshTripForCard(request, {
    getTrip: async () => { queries += 1; return fresh; },
    resolveLabels: async () => {},
    log: (line) => logs.push(line)
  });
  await flush();
  assert.equal(queries, 1);
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(queries, 2);
  // The budget ends during the second wait, so there is no third attempt.
  t.mock.timers.tick(5_000);
  assert.equal(await pending, fresh);
  assert.equal(queries, 2);
  assert.equal(Date.now() - startedAt, 20_000);
  // Spending the budget is the designed outcome, not a failure.
  assert.deepEqual(logs, []);
});

test("a complete trip is returned without waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const startedAt = Date.now();
  const fresh = { ...snapshot, start_road: "alpha-road", end_road: "beta-road" };
  let queries = 0;
  const trip = await refreshTripForCard(request, {
    getTrip: async () => { queries += 1; return fresh; },
    resolveLabels: async (candidate) => { candidate.start_road ||= "alpha-road"; candidate.end_road ||= "beta-road"; }
  });
  assert.equal(trip, fresh);
  assert.equal(queries, 1);
  assert.equal(Date.now() - startedAt, 0);
});

test("a slow label lookup is abandoned at the budget and the card keeps the labels found so far", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const startedAt = Date.now();
  const fresh = { ...snapshot };
  let queries = 0;
  let lookup;
  const pending = refreshTripForCard({ ...request, intervalMs: 19_000 }, {
    getTrip: async () => { queries += 1; return fresh; },
    resolveLabels: (candidate, { signal }) => {
      // The second lookup is still running when the budget ends.
      if (queries > 1) { lookup = { started: true, signal }; return new Promise(() => {}); }
      candidate.start_road = "alpha-road";
      return undefined;
    }
  });
  await flush();
  t.mock.timers.tick(19_000);
  await flush();
  assert.equal(lookup.started, true);
  t.mock.timers.tick(1_000);
  const trip = await pending;
  assert.equal(trip, fresh);
  assert.equal(trip.start_road, "alpha-road");
  assert.equal(trip.end_road, null);
  assert.equal(Date.now() - startedAt, 20_000);
  assert.equal(lookup.signal.aborted, true);
});

test("a trip with one road still missing is polled again instead of sent incomplete", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const startedAt = Date.now();
  const fresh = { ...snapshot };
  let queries = 0;
  const pending = refreshTripForCard(request, {
    getTrip: async () => { queries += 1; return fresh; },
    resolveLabels: async (candidate) => {
      candidate.start_road ||= "alpha-road";
      if (queries > 1) candidate.end_road = "beta-road";
    }
  });
  await flush();
  t.mock.timers.tick(15_000);
  const trip = await pending;
  assert.equal(trip, fresh);
  assert.equal(trip.end_road, "beta-road");
  assert.equal(queries, 2);
  assert.equal(Date.now() - startedAt, 15_000);
});

test("a query that answers only after the budget triggers no further work", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let answer;
  let lookups = 0;
  const pending = refreshTripForCard(request, {
    getTrip: () => new Promise((resolve) => { answer = resolve; }),
    resolveLabels: async () => { lookups += 1; }
  });
  await flush();
  t.mock.timers.tick(20_000);
  assert.equal(await pending, snapshot);
  answer({ ...snapshot, start_road: "late-road", end_road: "late-road" });
  await flush();
  assert.equal(lookups, 0);
});

test("a failing re-query never holds the card and logs a stable code only", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const startedAt = Date.now();
  const logs = [];
  const trip = await refreshTripForCard(request, {
    getTrip: async () => { throw Object.assign(new Error("psql: private detail 30.3,120.1"), { code: "DB_PROCESS_FAILED" }); },
    log: (line) => logs.push(line)
  });
  assert.equal(trip, snapshot);
  assert.equal(Date.now() - startedAt, 0);
  assert.deepEqual(logs, ["trip refresh failed (card continues) code=DB_PROCESS_FAILED"]);
});

test("nothing is queried without segment ids", async () => {
  let queries = 0;
  const trip = await refreshTripForCard({ segmentIds: [], trip: snapshot }, {
    getTrip: async () => { queries += 1; }
  });
  assert.equal(trip, snapshot);
  assert.equal(queries, 0);
});
