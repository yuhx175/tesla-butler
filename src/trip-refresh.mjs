// Refresh a freshly closed drive for its notification within a hard time
// budget. Drive close races the address/position writes in TeslaMate, so the
// monitor's snapshot often lacks them and a later re-query picks them up —
// but nothing may hold the card back: once the budget is spent, pending work
// is abandoned through the signal and the best trip known so far is returned.

import { abortableSleep, withQueryDeadline } from "./query-runtime.mjs";
import { safeErrorCode } from "./worker-runtime.mjs";

/**
 * Re-query the drive group and complete its endpoint labels until both roads
 * are known or the budget is spent. Never throws and never runs past the
 * budget: the result is the freshest trip seen, labelled as far as resolved
 * by then, so the card can always go out.
 */
export async function refreshTripForCard(
  { segmentIds, trip, budgetMs = 20_000, intervalMs = 15_000 } = {},
  { getTrip, resolveLabels, log = () => {} } = {}
) {
  if (typeof getTrip !== "function" || !segmentIds?.length) return trip;
  let latest = trip;
  try {
    await withQueryDeadline(async ({ signal }) => {
      for (;;) {
        const fresh = await getTrip(segmentIds, { signal });
        // An answer that lands after the card has gone out starts no new work.
        if (signal.aborted) return;
        latest = fresh || latest;
        if (!latest) return;
        if (resolveLabels) await resolveLabels(latest, { signal });
        // One road can already be known while the other endpoint is still
        // being written: only a complete trip ends the refresh early.
        if (latest.start_road && latest.end_road) return;
        await abortableSleep(intervalMs, signal);
      }
    }, budgetMs, "trip refresh");
  } catch (error) {
    // A spent budget is the designed way out, not a failure.
    if (error?.code !== "DB_DEADLINE") log(`trip refresh failed (card continues) code=${safeErrorCode(error)}`);
  }
  return latest;
}
