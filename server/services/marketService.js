import mongoose from 'mongoose';
import { Market } from '../models/Market.js';
import { Result } from '../models/Result.js';
import { fetchProviderMarkets, fetchProviderLive } from './provider.js';
import { syncChartHistory, syncChartHistoryFromCards } from './chartHistory.js';
import { mergeMarkets } from './mergeMarkets.js';
import { rankLiveCards, BOARD_SIZE } from './liveBoard.js';
import { revealCustom } from './customReveal.js';
import { toMinutes, to12Hour, nowMinutes, isImminent } from './marketClock.js';
import { buildDisplay } from '../models/Result.js';
import { lookupSchedule } from './marketSchedule.js';

/** Today's date in YYYY-MM-DD using the server's local timezone. */
export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Load active custom markets plus their declared halves.
 *
 * Both halves of the draw are kept, keyed market -> { open, close }, taken
 * from the most recent DATE that has any row. Keeping a single "latest row"
 * per market would drop the other half, which would hide the open pana or the
 * close pana from the public page.
 *
 * Resilient: when the public middleware lets a request through without a DB
 * (cold start grace window), this returns empty instead of throwing - the
 * page renders provider-only rather than hanging.
 *
 * SHORT-LIVED SHARED CACHE (~8s): /api/home.php calls this TWICE (markets +
 * live boards) and the frontend polls /live-result.php every 15s - the
 * Atlas free-tier round trip (~1-2.5s) used to be paid on EVERY one of those
 * calls and ate the whole 5s page budget on its own. One shared result for
 * ~8s makes home.php ~2x faster and polling near-instant, while staying well
 * inside the frontend's own 15s refresh cadence (results are only declared
 * a few times per hour anyway).
 */
const CUSTOM_TTL_MS = Number(process.env.CUSTOM_MARKETS_TTL_MS || 8_000);
const customCache = { data: null, fetchedAt: 0 };
let customPending = null;

async function queryCustomMarkets() {
  // Fast-fail when the DB isn't connected: without this, Mongoose buffers
  // the query until serverSelectionTimeoutMS expires (~4.5s+) and the
  // Vercel function burns its whole ~10s budget on one cold start.
  if (mongoose.connection.readyState !== 1) {
    return { markets: [], halvesByMarket: new Map() };
  }
  let markets;
  try {
    markets = await Market.find({ active: true }).lean().maxTimeMS(2500);
  } catch {
    return { markets: [], halvesByMarket: new Map() };
  }

  if (markets.length === 0) return { markets: [], halvesByMarket: new Map() };

  // TWO cheap indexed steps instead of one giant scan. The old single query
  // (find ALL ~14.6k result rows, sort by date+createdAt) took ~38s on Atlas
  // free tier - it blew past the maxTimeMS cap below and intermittently
  // returned an EMPTY map, which hid every webhook result from the public
  // page (the "result not showing" bug). Step 1 uses $group/$max (no sort
  // needed, ~250ms); step 2 fetches only the ~2 rows per market (~1s).
  let latestPairs = [];
  try {
    // NOTE: Mongoose Aggregate has no .maxTimeMS() helper (Query does) - the
    // cap goes through .option({ maxTimeMS }).
    latestPairs = await Result.aggregate([
      { $match: { market: { $in: markets.map((m) => m._id) } } },
      { $group: { _id: '$market', date: { $max: '$date' } } },
    ]).option({ maxTimeMS: 2500 });
  } catch {
    return { markets, halvesByMarket: new Map() };
  }
  if (latestPairs.length === 0) return { markets, halvesByMarket: new Map() };

  // One date per market, but markets usually all drew on the same day, so
  // this is a small set of dates to match on.
  const latestDateOf = new Map(latestPairs.map((p) => [String(p._id), p.date]));
  const dates = [...new Set(latestPairs.map((p) => p.date))];

  let results = [];
  try {
    results = await Result.find({
      market: { $in: markets.map((m) => m._id) },
      date: { $in: dates },
    })
      .maxTimeMS(2500)
      .lean();
  } catch {
    return { markets, halvesByMarket: new Map() };
  }

  const halvesByMarket = new Map();
  for (const r of results) {
    const key = String(r.market);
    // The date filter above also matches markets whose LATEST draw is older
    // than another market's - keep only each market's own latest date.
    if (r.date !== latestDateOf.get(key)) continue;

    let entry = halvesByMarket.get(key);
    if (!entry) {
      entry = { date: r.date, open: null, close: null };
      halvesByMarket.set(key, entry);
    }
    if (r.session === 'close') entry.close = r;
    else entry.open = r;
  }

  return { markets, halvesByMarket };
}

/**
 * Cached front door for queryCustomMarkets(): concurrent callers (the two
 * Promise.all branches of home.php) share ONE in-flight query, and repeat
 * calls inside the TTL window are answered from memory - so the Atlas round
 * trip is paid at most once per ~8s instead of 2-3x per request.
 */
export async function loadCustomMarkets() {
  const now = Date.now();
  if (customCache.data && now - customCache.fetchedAt < CUSTOM_TTL_MS) {
    return customCache.data;
  }
  if (customPending) return customPending;
  customPending = queryCustomMarkets()
    .then((data) => {
      customCache.data = data;
      customCache.fetchedAt = Date.now();
      return data;
    })
    .catch((err) => {
      // queryCustomMarkets already fast-fails into empty payloads; this is a
      // last-resort guard so a surprise throw (e.g. model registration race)
      // never rejects the public page.
      console.warn('[marketService] loadCustomMarkets failed: ' + err.message);
      const empty = { markets: [], halvesByMarket: new Map() };
      customCache.data = empty;
      customCache.fetchedAt = Date.now();
      return empty;
    })
    .finally(() => {
      customPending = null;
    });
  return customPending;
}

/**
 * Drop the cached custom-markets payload so the NEXT public read queries
 * MongoDB fresh. Called by the push webhook and the admin result routes the
 * moment a draw is written - a newly pushed result must appear on the live
 * board immediately, never after the TTL window.
 */
export function invalidateCustomMarkets() {
  customCache.data = null;
  customCache.fetchedAt = 0;
}

/**
 * The merged public market list: provider markets + custom markets,
 * interleaved by open time so custom ones blend into the flow.
 */
export async function getPublicMarkets(now = nowMinutes()) {
  // ONE upstream hit per cooldown window: without this outer check the two
  // No upstream pull exists anymore (webhook-only), so the Promise.all
  // branches below never hit a dead external API.
  const [{ markets, halvesByMarket }, providerMarkets] = await Promise.all([
    loadCustomMarkets(),
    fetchProviderMarkets(),
  ]);

  // The trial API is stateless - it only hands back today's draw. Keep the
  // chart collection growing: every completed draw becomes one ChartEntry.
  // The 5-minute throttle keeps the writes sane; upserts are keyed
  // {slug, date} so repeats are no-ops.
  // Fire-and-forget (NOT awaited): on a cold start the DB isn't connected
  // and an awaited write would buffer until Mongoose times out, holding the
  // HTTP response open until Vercel kills it (endless "Loading...").
  try {
    const p = syncChartHistory(providerMarkets);
    if (p?.catch) p.catch(() => {});
  } catch {
    /* non-critical */
  }

  return mergeMarkets(providerMarkets, markets, halvesByMarket, now);
}

/**
 * Build the custom-markets half of the live board from already-loaded data.
 * Shared by the fast path (upstream known-dead: no provider fetch at all)
 * and the normal path (providerLive fetched). Keeping one function means the
 * two paths can never drift apart.
 */
function buildCustomLiveCards(markets, halvesByMarket, date, now, providerLive) {
  // Each halves entry holds a market's LATEST draw, so keeping only entries
  // dated `date` is exactly the "declared today" set - without a second
  // full-collection query (the old dedicated query had no usable sort path
  // and intermittently exceeded its own cap, hiding today's halves from the
  // LIVE cards).
  const byMarket = new Map();
  for (const m of markets) {
    const halves = halvesByMarket.get(String(m._id));
    if (!halves || halves.date !== date) continue;
    const key = String(m._id);
    let entry = byMarket.get(key);
    if (!entry) {
      entry = { open: null, close: null };
      byMarket.set(key, entry);
    }
    if (halves.open) entry.open = halves.open;
    if (halves.close) entry.close = halves.close;
  }

  // Split custom markets into push/webhook markets and manually-declared
  // custom markets. Push/webhook markets are driven by the provider, so the
  // stored halves are the source of truth and the result shows as soon as it
  // is saved. Manually-declared custom markets are clock-gated: the result
  // only becomes visible during the market's open/close window.
  const pushMarkets = [];
  const manualMarkets = [];
  for (const m of markets) {
    if (m.pushDriven) pushMarkets.push(m);
    else manualMarkets.push(m);
  }

  // Fresh complete provider results outrank stored halves for the same
  // provider-derived market (see mergeMarkets): without this a stale
  // partial sorts as "live" above today's full "closed" result.
  const providerFreshSlugs = new Set(
    (providerLive ?? [])
      .filter((c) => c?.slug && /^\d{3}-\d{2}-\d{3}$/.test(String(c?.result ?? '')))
      .map((c) => c.slug)
  );
  const livePushMarkets = pushMarkets.filter((m) => !(m.slug && providerFreshSlugs.has(m.slug)));

  const customCards = [];

  // Manual custom markets: gate the result by the clock.
  for (const m of manualMarkets) {
    const openMin = toMinutes(m.openTime);
    const closeMin = toMinutes(m.closeTime);

    const halves = byMarket.get(String(m._id)) ?? { open: null, close: null };
    const reveal = revealCustom(m, halves.open ?? null, halves.close ?? null, now);
    customCards.push({
      market: m.name,
      slug: m.slug,
      result: reveal.result,
      ank: reveal.ank,
      isPending: reveal.isPending,
      status: reveal.status === 'unknown' ? 'pending' : reveal.status,
      isImminent: isImminent(openMin, closeMin, now),
      openTime: to12Hour(openMin),
      closeTime: to12Hour(closeMin),
      _open: openMin,
      _close: closeMin,
    });
  }

  // Push/webhook markets: the provider pushed the draw, so the stored halves
  // are the source of truth and the result shows as soon as it is saved.
  for (const m of livePushMarkets) {
    const sched = (m.openTime === '00:00' && m.closeTime === '23:59') ? lookupSchedule(m.name) : null;
    const openMin = toMinutes(sched?.open ?? m.openTime);
    const closeMin = toMinutes(sched?.close ?? m.closeTime);

    const halves = byMarket.get(String(m._id)) ?? { open: null, close: null };
    const disp = halves.open || halves.close ? buildDisplay(halves.open, halves.close) : null;
    const ok = disp && !disp.error ? disp : null;
    customCards.push({
      market: m.name,
      slug: m.slug,
      result: ok?.display ?? null,
      ank: ok?.ank ?? null,
      isPending: !ok,
      status: ok ? (ok.jodiComplete ? 'closed' : 'live') : 'pending',
      isImminent: false,
      openTime: to12Hour(openMin),
      closeTime: to12Hour(closeMin),
      _open: openMin,
      _close: closeMin,
    });
  }

  // One board, one ranking: provider cards and custom cards compete for
  // the same top slots on equal terms. Provider draws are stored as chart
  // history the moment their 3-part result is published (the sync throttle
  // keeps the writes sane; a market is only stored when its full draw is
  // out). Custom markets write themselves: each declared Result row is
  // picked up by getChartHistory() on the chart pages.
  const ranked = rankLiveCards([...providerLive, ...customCards]);
  syncChartHistoryFromCards(providerLive);

  // Drop the internal sort keys before responding.
  return ranked.slice(0, BOARD_SIZE).map(({ _open, _close, ...rest }) => rest);
}

/**
 * Live-result cards.
 *
 * All custom markets are clock-gated: the result only becomes visible during
 * the market's open/close window. Push/webhook markets (pushDriven) are the
 * exception - the provider pushes the draw, so the stored halves are the
 * source of truth and the result shows as soon as it is saved. No clock gate
 * anywhere.
 */
export async function getPublicLive(date = today(), now = nowMinutes()) {
  // No upstream pull exists anymore (webhook-only), so there is no dead
  // upstream to guard against.
  const [providerLive, { markets, halvesByMarket }] = await Promise.all([
    fetchProviderLive(),
    loadCustomMarkets(),
  ]);

  return buildCustomLiveCards(markets, halvesByMarket, date, now, providerLive);
}
