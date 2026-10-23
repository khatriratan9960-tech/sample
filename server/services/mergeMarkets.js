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

/** Headline ank from a result string: its LAST '-' part. A 3-digit tail is a
 *  panna -> ank = digit-sum mod 10 ("359" -> 7); a shorter tail is already an
 *  ank digit or a jodi half (take its final digit). The panna's last DIGIT
 *  ("359" -> 9) is wrong. */
function ankOf(display) {
  if (!display) return null;
  const parts = String(display).split('-').filter(Boolean);
  const tail = parts[parts.length - 1] ?? '';
  if (!/^\d+$/.test(tail)) return null;
  if (tail.length === 3) return panaAnk(tail);
  return Number(tail.slice(-1));
}

/**
 * Ank of a panna = sum of its digits mod 10 ("269" -> 7, "389" -> 0).
 * Same convention as liveBoard.panaAnk / chartHistory.ankOf - the last
 * DIGIT of the panna ("269" -> 9) is wrong and must never be used.
 */
function panaAnk(pana) {
  const s = String(pana ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  let sum = 0;
  for (const ch of s) sum += Number(ch);
  return sum % 10;
}

/** Shape a provider market to the same contract custom markets use. */
function normalizeProvider(raw, now) {
  const name = raw.market ?? raw.name ?? '';
  const open = raw.open ?? null;
  const close = raw.close ?? null;
  const jodi = raw.jodi ?? null;

  const hasAll = open != null && close != null && jodi != null && jodi !== '';
  const hasPair = open != null && close != null && close !== '' && !hasAll;

  let display = null;
  // Prefer the provider's own precomputed result string when present - it is
  // already in open-jodi-close order and handles partials ("269-9") without
  // reassembling stale field pairs ("269-07").
  if (typeof raw.result === 'string' && raw.result.includes('-')) display = raw.result;
  else if (hasAll) display = `${open}-${close}-${jodi}`;
  else if (hasPair) display = `${open}-${close}`;
  else if (jodi != null && jodi !== '') display = String(jodi);
  // Partial draw (open declared, close still pending): show open panna +
  // digit-sum ank, exactly like the live board ("269-7", "389-0") - never a
  // padded "269-00"/"389-00" stub and never a silent Loading... during the
  // window. Full results only ever arrive with their own result string, so
  // this branch cannot override one.
  else if (open != null && open !== '') {
    const ank = panaAnk(open);
    display = ank != null ? `${open}-${ank}` : String(open);
  }

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
function normalizeCustom(market, halves, now, opts = {}) {
  const openM = toMinutes(market.openTime);
  const closeM = toMinutes(market.closeTime);

  // LOWER-PANEL FALLBACK: showing the latest PAST draw until today declares.
  // Render it as a closed past result straight away - the clock gate must not
  // hide it as "upcoming" (that is what caused Loading...). Live board never
  // takes this path.

  // Push/webhook markets (pushDriven) show the result as soon as the provider
  // pushes the draw: the stored halves are the source of truth and there is no
  // clock to wait for. Manually-declared markets are clock-gated: a result the
  // operator declared early must not appear until the market's open/close
  // window opens.
  // LOWER-PANEL FALLBACK (opts.fallbackDate): halves are a PAST draw, so
  // render them as the closed last result straight away - before open time
  // this reads as yesterday's result, never Loading.... The live board never
  // passes fallbackDate, so its gating is untouched. The fallback ALSO covers
  // a TODAY row hidden by the upcoming gate (declared early): until the
  // window opens, the reader sees the past result rather than Loading....
  // Applies to BOTH manual and pushDriven markets.
  if (opts?.fallbackDate) {
    const fbBuilt = halves?.open || halves?.close ? buildDisplay(halves?.open ?? null, halves?.close ?? null) : null;
    const fbOk = fbBuilt && !fbBuilt.error ? fbBuilt : null;
    if (fbOk) {
      return {
        market: market.name,
        slug: market.slug,
        open: halves?.open?.pana ?? null,
        close: halves?.close?.pana ?? null,
        jodi: fbOk?.jodi ?? null,
        result: fbOk?.display ?? null,
        openTime: to12Hour(openM),
        closeTime: to12Hour(closeM),
        ank: fbOk?.ank ?? null,
        status: 'closed',
        isPending: false,
        source: 'custom',
        _sort: openM,
        _marketId: String(market._id),
        jodiUrl: `/jodi-chart-record/${market.slug}.php`,
        panelUrl: `/panel-chart-record/${market.slug}.php`,
      };
    }
  }
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
      // Push webhooks may deliver only the open half; do not flag 'live'
      // before the declared close window. Mirrors buildCustomLiveCards in
      // marketService.js so the grid and live board agree on partials.
      status: ok && !ok.jodiComplete && now <= closeM2 ? 'live' : (ok ? 'closed' : 'pending'),
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

  // THE CLOCK GATE HID TODAY'S DRAW (declared early, before the window
  // opened). Today's numbers must NOT leak early, but the panel must not
  // say "Loading..." either - show the latest PAST draw instead.
  if (isPending && opts?.fallback && (opts.fallback.open || opts.fallback.close)) {
    const f = opts.fallback;
    const fbBuilt = buildDisplay(f.open ?? null, f.close ?? null);
    const fbOk = fbBuilt && !fbBuilt.error ? fbBuilt : null;
    if (fbOk) {
      return {
        market: market.name,
        slug: market.slug,
        open: f.open?.pana ?? null,
        close: f.close?.pana ?? null,
        jodi: fbOk.jodi ?? null,
        result: fbOk.display ?? null,
        openTime: to12Hour(openM),
        closeTime: to12Hour(closeM),
        ank: fbOk.ank ?? null,
        status: 'closed',
        isPending: false,
        source: 'custom',
        _sort: openM,
        _marketId: String(market._id),
        jodiUrl: `/jodi-chart-record/${market.slug}.php`,
        panelUrl: `/panel-chart-record/${market.slug}.php`,
      };
    }
  }

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
/** Slug a provider row the same way normalizeProvider does. */
function providerSlug(raw) {
  if (raw.slug) return raw.slug;
  const name = raw.market ?? raw.name ?? '';
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** True when a provider row carries a fresh, complete 3-part result. */
function providerFresh(raw) {
  if (!raw) return false;
  if (/^\d{3}-\d{2}-\d{3}$/.test(String(raw.result ?? ''))) return true;
  return Boolean(raw.open && raw.close && raw.jodi);
}

export function mergeMarkets(providerMarkets, customMarkets, halvesByMarket, now = nowMinutes(), opts = {}) {
  // The provider is the source of truth for ITS OWN markets: a pushDriven
  // custom doc only mirrors a provider draw, so when the provider carries a
  // fresh complete result the stored (possibly stale or partial) halves must
  // not shadow it - otherwise a stale "579-1" hides today's "579-11-146".
  // Manually-declared markets are operator-authored and always win.
  const freshSlugs = new Set(
    (providerMarkets ?? []).filter(providerFresh).map(providerSlug).filter(Boolean)
  );
  const liveCustoms = (customMarkets ?? []).filter(
    (m) => !(m?.pushDriven && m.slug && freshSlugs.has(m.slug))
  );
  // LOWER-PANEL FALLBACK: a custom market with NO halves for its latest draw
  // (today undeclared) shows its latest PAST draw until today's lands - the
  // same carry-forward provider rows already have. The live board never sees
  // this (it reads halvesByMarket directly), and revealCustom's upcoming gate
  // still hides a TODAY early declaration.
  const fallbackByMarket = opts?.fallbackByMarket;
  const custom = liveCustoms.map((m) => {
    const key = String(m._id);
    const todayHalves = halvesByMarket?.get(key);
    const fb = fallbackByMarket?.get(key);
    const useFb = (!todayHalves || (!todayHalves.open && !todayHalves.close)) && fb && (fb.open || fb.close);
    return normalizeCustom(m, useFb ? fb : todayHalves, now, {
      fallbackDate: useFb ? fb.date : undefined,
      // Always hand the latest past draw through so normalizeCustom can show
      // it when the clock gate hides today's early declaration (the case
      // useFb above misses, because today's halves DO exist).
      fallback: fb && (fb.open || fb.close) ? fb : undefined,
    });
  });

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

