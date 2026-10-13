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
 */
export async function loadCustomMarkets() {
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

  let results = [];
  try {
    results = await Result.find({
      market: { $in: markets.map((m) => m._id) },
    })
      .sort({ date: -1, createdAt: -1 })
      .maxTimeMS(2500)
      .lean();
  } catch {
    return { markets, halvesByMarket: new Map() };
  }

  const halvesByMarket = new Map();
  for (const r of results) {
    const key = String(r.market);
    let entry = halvesByMarket.get(key);

    // The first row seen for this market fixes which draw we describe.
    if (!entry) {
      entry = { date: r.date, open: null, close: null };
      halvesByMarket.set(key, entry);
    }
    // Ignore older draws - only the most recent date is on the public page.
    if (r.date !== entry.date) continue;

    if (r.session === 'close') entry.close = r;
    else entry.open = r;
  }

  return { markets, halvesByMarket };
}

/**
 * The merged public market list: provider markets + custom markets,
 * interleaved by open time so custom ones blend into the flow.
 */
export async function getPublicMarkets(now = nowMinutes()) {
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
 * Live-result cards.
 *
 * All custom markets are clock-gated: the result only becomes visible during
 * the market's open/close window. Push/webhook markets (pushDriven) are the
 * exception - the provider pushes the draw, so the stored halves are the
 * source of truth and the result shows as soon as it is saved. No clock gate
 * anywhere.
 */
export async function getPublicLive(date = today(), now = nowMinutes()) {
  const [providerLive, { markets }] = await Promise.all([
    fetchProviderLive(),
    loadCustomMarkets(),
  ]);

  let declaredToday = [];
  if (markets.length && mongoose.connection.readyState === 1) {
    try {
      declaredToday = await Result.find({
        market: { $in: markets.map((m) => m._id) },
        date,
      })
        .maxTimeMS(2500)
        .lean();
    } catch {
      declaredToday = [];
    }
  }

  // A market has TWO rows per draw (session 'open' and 'close'), so they are
  // collected into one entry per market. Building the map with
  // `rows.map(r => [marketId, r])` would silently drop one half, because the
  // second row would overwrite the first.
  const byMarket = new Map();
  for (const r of declaredToday) {
    const key = String(r.market);
    let entry = byMarket.get(key);
    if (!entry) {
      entry = { open: null, close: null };
      byMarket.set(key, entry);
    }
    if (r.session === 'close') entry.close = r;
    else entry.open = r;
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
  for (const m of pushMarkets) {
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
  syncChartHistoryFromCards(providerLive, 'matka');

  // Drop the internal sort keys before responding.
  return ranked.slice(0, BOARD_SIZE).map(({ _open, _close, ...rest }) => rest);
}
