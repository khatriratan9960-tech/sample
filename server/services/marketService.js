import mongoose from 'mongoose';
import { Market } from '../models/Market.js';
import { Result } from '../models/Result.js';
import { fetchProviderMarkets, fetchProviderLive } from './provider.js';
import { syncChartHistory, syncChartHistoryFromCards } from './chartHistory.js';
import { mergeMarkets } from './mergeMarkets.js';
import { rankLiveCards, BOARD_SIZE } from './liveBoard.js';
import { revealCustom } from './customReveal.js';
import { toMinutes, to12Hour, nowMinutes, isImminent, todayStr } from './marketClock.js';
import { buildDisplay } from '../models/Result.js';
import { lookupSchedule } from './marketSchedule.js';
import { waitForDb } from './dbWait.js';

/**
 * Today's date in YYYY-MM-DD in the MARKET timezone (Asia/Kolkata).
 *
 * This must be the SAME "today" the webhook push and the chart history use
 * (marketClock.todayStr). The old version read the SERVER's local date, so on
 * a UTC host (Vercel) the admin panel declared a result under the UTC date
 * while the board looked for the IST date - the declaration was invisible and
 * the card sat on "Loading..." all day.
 */
export function today() {
  return todayStr();
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
  // On a Vercel cold start the public middleware does NOT wait for the DB
  // (by design), so instantly fast-failing here made every cold response
  // PROVIDER-ONLY: custom markets vanished from the grid and live board for
  // that request, and the frontend - polling every 15s across many
  // instances - saw them flicker in and out (and a single cold home.php
  // hit left the homepage lower list without customs for the whole
  // session). Wait a BOUNDED moment for Atlas first (typically <2s), then
  // fast-fail only when the DB is genuinely unreachable - never let
  // Mongoose buffer to serverSelectionTimeoutMS.
  if (mongoose.connection.readyState !== 1) {
    await waitForDb(2000);
  }
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

  // LOWER-PANEL FALLBACK: until today's draw is declared, show the latest
  // PAST result - never "Loading...". One bounded window query (today + last
  // 14 days), grouped per market in memory. halvesByMarket = today only
  // (live board untouched); fallbackByMarket = latest past draw per market
  // (lower grid only).
  const ids = markets.map((m) => m._id);
  const todayStr = today();
  const back = new Date();
  back.setDate(back.getDate() - 14);
  const pad2 = (n) => String(n).padStart(2, '0');
  const windowStart = `${back.getFullYear()}-${pad2(back.getMonth() + 1)}-${pad2(back.getDate())}`;
  let results = [];
  try {
    results = await Result.find({
      market: { $in: ids },
      date: { $gte: windowStart, $lte: todayStr },
    })
      .maxTimeMS(4000)
      .lean();
  } catch {
    return { markets, halvesByMarket: new Map(), fallbackByMarket: new Map() };
  }

  const halvesByMarket = new Map();
  const pastByMarket = new Map();
  for (const r of results) {
    const key = String(r.market);
    if (r.date === todayStr) {
      let entry = halvesByMarket.get(key);
      if (!entry) {
        entry = { date: r.date, open: null, close: null };
        halvesByMarket.set(key, entry);
      }
      if (r.session === 'close') entry.close = r;
      else entry.open = r;
    } else {
      let byDate = pastByMarket.get(key);
      if (!byDate) {
        byDate = new Map();
        pastByMarket.set(key, byDate);
      }
      let entry = byDate.get(r.date);
      if (!entry) {
        entry = { open: null, close: null };
        byDate.set(r.date, entry);
      }
      if (r.session === 'close') entry.close = r;
      else entry.open = r;
    }
  }
  const fallbackByMarket = new Map();
  for (const [key, byDate] of pastByMarket) {
    const latestPast = [...byDate.keys()].sort().pop();
    if (latestPast) fallbackByMarket.set(key, { ...byDate.get(latestPast), date: latestPast });
  }

  return { markets, halvesByMarket, fallbackByMarket };
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
      // A cold-start fast-fail returns an empty payload that would be cached as
      // "no custom markets" for the whole CUSTOM_TTL_MS window, silently hiding
      // custom markets from the grid on every new serverless instance. Only
      // cache when the DB is actually up; the DB warms through ensureReady()
      // and the next call will retry with fresh data.
      if (mongoose.connection.readyState === 1) {
        customCache.data = data;
        customCache.fetchedAt = Date.now();
      }
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
  const [{ markets, halvesByMarket, fallbackByMarket }, providerMarkets] = await Promise.all([
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

  return mergeMarkets(providerMarkets, markets, halvesByMarket, now, { fallbackByMarket });
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
    // Push markets are result-driven (show the open half the moment it lands),
    // but a partial (open only) must NOT be tagged "LIVE" after its declared
    // close window has passed - otherwise a missing close half leaves a stale
    // "257-4"/"890-7" mark at the top of the board for hours/days.
    const partialStillLive = ok && !ok.jodiComplete && now <= closeMin;
    customCards.push({
      market: m.name,
      slug: m.slug,
      result: ok?.display ?? null,
      ank: ok?.ank ?? null,
      isPending: !ok,
      status: ok ? (ok.jodiComplete ? 'closed' : (partialStillLive ? 'live' : 'closed')) : 'pending',
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
