/**
 * Merge provider markets with the operator's own markets into one list.
 *
 * The goal is that a custom market is INDISTINGUISHABLE from a provider one:
 * same field names, same ordering, same result format. It is interleaved by
 * draw time rather than appended, so it slots into the natural flow of the
 * page instead of looking bolted on at the bottom.
 */

import { toMinutes, to12Hour, nowMinutes, publicStatus } from './marketClock.js';
import { buildDisplay } from '../models/Result.js';
import { revealCustom } from './customReveal.js';
import { lookupSchedule } from './marketSchedule.js';

// Re-exported so existing callers keep working from this module.
export { toMinutes, to12Hour };

/** Last digit of a result tail, or null. */
function ankOf(display) {
  if (!display) return null;
  const parts = String(display).split('-').filter(Boolean);
  const tail = parts[parts.length - 1] ?? '';
  return /^\d+$/.test(tail) ? Number(tail.slice(-1)) : null;
}

/** Shape a provider market to the same contract custom markets use. */
function normalizeProvider(raw, now) {
  const name = raw.market ?? raw.name ?? '';
  const open = raw.open ?? null;
  const close = raw.close ?? null;
  const jodi = raw.jodi ?? null;

  const hasAll = open != null && close != null && jodi != null && jodi !== '';
  const hasPair = open != null && close != null && !hasAll;

  let display = null;
  if (hasAll) display = `${open}-${close}-${jodi}`;
  else if (hasPair) display = `${open}-${close}`;
  else if (jodi != null && jodi !== '') display = String(jodi);

  const sched = lookupSchedule(name);
  const openTimeShown = raw.openTime ?? sched?.open ?? '';
  const closeTimeShown = raw.closeTime ?? sched?.close ?? '';
  const slug = raw.slug ?? String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return {
    market: name,
    slug,
    open,
    close,
    jodi: hasAll ? jodi : null,
    result: display,
    openTime: openTimeShown,
    closeTime: closeTimeShown,
    ank: raw.ank ?? ankOf(display),
    // Clock-driven, not result-driven: a market inside its draw window is
    // "live" even before anything has been published for it.
    status: publicStatus(
      toMinutes(raw.openTime ?? raw.open_time ?? sched?.open),
      toMinutes(raw.closeTime ?? raw.close_time ?? sched?.close),
      now,
      display !== null
    ),
    source: 'provider',
    jodiUrl: `/jodi-chart-record/${slug}.php`,
    panelUrl: `/panel-chart-record/${slug}.php`,
    _sort: toMinutes(raw.openTime ?? raw.open_time ?? sched?.open),
  };
}

/**
 * Shape one of the operator's markets + its declared halves.
 *
 * ALL custom markets (manual + webhook) are RESULT-driven for push/webhook
 * markets: the stored halves decide what shows, not the clock. Manually-
 * declared markets are clock-gated below, so a result the operator declared
 * early must not appear until the market's open/close window opens.
 *   - push/webhook: open only   -> "223-7" the moment the open half is saved
 *                  -> "223-76-680" the moment the close half is saved
 *                  -> nothing yet -> pending (Loading...)
 *   - manual:       upcoming    -> nothing at all, even if both halves are stored
 *                  -> live      -> the OPEN half only (e.g. "257-7")
 *                  -> closed    -> everything declared for that draw (e.g. "257-72-369")
 */
function normalizeCustom(market, halves, now) {
  const openM = toMinutes(market.openTime);
  const closeM = toMinutes(market.closeTime);

  // Push/webhook markets (pushDriven) show the result as soon as the provider
  // pushes the draw: the stored halves are the source of truth and there is no
  // clock to wait for. Manually-declared markets are clock-gated: a result the
  // operator declared early must not appear until the market's open/close
  // window opens.
  if (market.pushDriven) {
    const sched2 = (market.openTime === '00:00' && market.closeTime === '23:59') ? lookupSchedule(market.name) : null;
    const openM2 = toMinutes(sched2?.open ?? market.openTime);
    const closeM2 = toMinutes(sched2?.close ?? market.closeTime);
    const built = halves?.open || halves?.close ? buildDisplay(halves?.open ?? null, halves?.close ?? null) : null;
    const ok = built && !built.error ? built : null;
    return {
      market: market.name,
      slug: market.slug,
      open: halves?.open?.pana ?? null,
      close: halves?.close?.pana ?? null,
      jodi: ok?.jodi ?? null,
      result: ok?.display ?? null,
      openTime: to12Hour(openM2 ?? openM),
      closeTime: to12Hour(closeM2 ?? closeM),
      ank: ok?.ank ?? null,
      status: ok ? (ok.jodiComplete ? 'closed' : 'live') : 'pending',
      source: 'custom',
      // Internal only - stripped before the API responds.
      _sort: openM2 ?? openM,
      _marketId: String(market._id),
      jodiUrl: `/jodi-chart-record/${market.slug}.php`,
      panelUrl: `/panel-chart-record/${market.slug}.php`,
    };
  }

  // Manually-declared custom market: gate the result by the clock.
  const { status, result, jodi, ank, isPending, openRow, closeRow } = revealCustom(
    market,
    halves?.open ?? null,
    halves?.close ?? null,
    now
  );

  return {
    market: market.name,
    slug: market.slug,
    open: openRow?.pana ?? null,
    close: closeRow?.pana ?? null,
    jodi,
    result,
    openTime: to12Hour(openM),
    closeTime: to12Hour(closeM),
    ank,
    status: status === 'unknown' ? 'pending' : status,
    isPending,
    source: 'custom',
    // Internal only - stripped before the API responds.
    _sort: openM,
    _marketId: String(market._id),
    jodiUrl: `/jodi-chart-record/${market.slug}.php`,
    panelUrl: `/panel-chart-record/${market.slug}.php`,
  };
}

/**
 * @param {Array} providerMarkets  normalized-by-provider markets
 * @param {Array} customMarkets    Mongo Market docs
 * @param {Map}   halvesByMarket   marketId -> { open, close } Result docs
 * @param {number} now             minutes since midnight in the market
 *                                 timezone; defaults to the real clock.
 *                                 Injectable so the schedule can be tested.
 */
export function mergeMarkets(providerMarkets, customMarkets, halvesByMarket, now = nowMinutes()) {
  const custom = (customMarkets ?? []).map((m) =>
    normalizeCustom(m, halvesByMarket?.get(String(m._id)), now)
  );

  // Dedupe by slug: a market the operator runs himself (webhook push or
  // admin-declared) is the source of truth for that market. A provider row
  // with the same slug is a stale duplicate (demo fixture or an upstream
  // copy of the same draw) and would render a SECOND card with DIFFERENT
  // numbers - e.g. real SITA MORNING 255-24-699 next to demo 140-56-556.
  // The custom card always wins; provider-only markets pass through.
  const customSlugs = new Set(custom.map((c) => c.slug).filter(Boolean));
  const provider = (providerMarkets ?? [])
    .map((r) => normalizeProvider(r, now))
    .filter((p) => !customSlugs.has(p.slug));

  const all = [...provider, ...custom];

  // Interleave by OPEN time (earliest first), matching what the public page
  // renders. Anything without a parseable time sinks to the
  // end rather than scrambling the ordering.
  all.sort((a, b) => {
    const av = a._sort ?? Number.MAX_SAFE_INTEGER;
    const bv = b._sort ?? Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
    // Stable tiebreak: alphabetical, so the order never flickers between loads.
    return String(a.market).localeCompare(String(b.market));
  });

  // Drop the internal sort key before it reaches the client.
  return all.map(({ _sort, _marketId, ...rest }) => rest);
}

