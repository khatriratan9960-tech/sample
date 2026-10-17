/**
 * THE LIVE BOARD.
 *
 * The old implementation returned a frozen 14-row list from the fixture
 * file, so the top of the page never changed no matter what time it was -
 * night markets sat there at 9am, morning markets were missing at 11pm.
 *
 * This module builds that same board from ALL markets, using the real
 * clock against each market's real open/close time. The result is that the
 * mock data behaves like the live site:
 *
 *   - a market whose open time has not arrived yet  -> "Loading..."
 *   - a market inside its draw window               -> open pana only
 *   - a market whose close time has passed          -> full result
 *
 * and the board reorders itself so whatever is drawing right now is first.
 * Swap in the paid provider and only the *source* of the rows changes -
 * the ranking and reveal rules stay identical.
 */

import { toMinutes, to12Hour, nowMinutes, windowStatus, isImminent } from './marketClock.js';
import { lookupSchedule } from './marketSchedule.js';

/** Keep the board the same size as the original site's card list. */
const BOARD_SIZE = 14;

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
 * Ank of a 3-digit panna = sum of its digits mod 10.
 * e.g. "578" -> 5+7+8=20 -> 0, so the live card shows "578-0".
 * This matches the original site (369-8, 330-6, 256-3, ...).
 */
function panaAnk(pana) {
  const s = String(pana ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  let sum = 0;
  for (const ch of s) sum += Number(ch);
  return sum % 10;
}

/**
 * What a market should show RIGHT NOW, given where the clock is in its
 * window. Mirrors how results are actually published: nothing before the
 * open, the open half while the window is open, the full result after.
 */
function revealFor(raw, status) {
  const open = raw.open ?? null;
  const close = raw.close ?? null;
  const jodi = raw.jodi ?? null;

  if (status === 'upcoming') return { result: null, ank: null };

  // Inside the window: only the open half has been drawn.
  // Show it the way the original site does: open pana + its ank,
  // e.g. "578-0", "369-8" - never the bare pana ("578").
  if (status === 'live') {
    if (open == null || open === '') return { result: null, ank: null };
    const ank = panaAnk(open);
    if (ank == null) return { result: String(open), ank: ankOf(String(open)) };
    return { result: `${open}-${ank}`, ank };
  }

  if (status === 'closed') {
    const hasAll = open != null && close != null && jodi != null && jodi !== '';
    const hasPair = open != null && close != null;

    // NOTE ON FIELD NAMES: the upstream feed names its two-digit number
    // "close" and its three-digit panna "jodi" - the opposite of this
    // project's own vocabulary, where `jodi` is the two-digit join of the
    // two halves. So `close` here holds the JODI and `jodi` holds the CLOSE
    // PANA. Interpolating them in this order therefore produces
    // "openPana-jodi-closePana" (e.g. 257-48-369), which is the same
    // "open-jodi-close" order buildDisplay() produces for custom markets.
    // The names are misleading; the output is correct. Do not "fix" this
    // by swapping the variables - swap the fixture field names instead.
    if (hasAll) return { result: `${open}-${close}-${jodi}`, ank: ankOf(`${jodi}`) };
    if (hasPair) return { result: `${open}-${close}`, ank: ankOf(`${close}`) };
    if (jodi != null && jodi !== '') return { result: String(jodi), ank: ankOf(String(jodi)) };
    return { result: null, ank: null };
  }

  return { result: null, ank: null };
}

/** Turn one market row into a live-board card. */
export function toLiveCard(raw, now = nowMinutes()) {
  const sched = lookupSchedule(raw.market ?? raw.name);
  const openMin = toMinutes(raw.openTime ?? raw.open_time ?? sched?.open);
  const closeMin = toMinutes(raw.closeTime ?? raw.close_time ?? sched?.close);
  const status = windowStatus(openMin, closeMin, now);

  const { result, ank } = revealFor(raw, status);

  return {
    market: raw.market ?? raw.name ?? '',
    slug: raw.slug ?? '',
    result,
    ank,
    // "Loading..." is what the original prints for a market that has not
    // drawn yet - anything not yet revealed renders exactly like that.
    isPending: result === null,
    status,
    // About to declare: promoted onto the board just before its draw so a
    // reader can see it coming rather than finding it after the fact.
    isImminent: status === 'upcoming' && isImminent(openMin, closeMin, now),
    openTime: to12Hour(openMin),
    closeTime: to12Hour(closeMin),
    // Internal sort keys, stripped before the API responds.
    _open: openMin,
    _close: closeMin,
  };
}

/**
 * Rank the board the way a reader expects:
 *   1. markets drawing right now, soonest to close first
 *   1b. markets about to draw (within the imminent window) - these would
 *       otherwise be buried under every other upcoming market
 *   2. markets that closed most recently (newest results on top)
 *   3. markets still to open, soonest first (so the list is never empty)
 */
export function rankLiveCards(cards) {
  // A card is ranked "live" if it is drawing OR about to start drawing, so an
  // imminent market sits directly under the one currently drawing rather than
  // below every closed result on the page.
  const tier = (c) => (c.status === 'live' || c.isImminent ? 'live' : c.status);
  const rank = { live: 0, closed: 1, upcoming: 2 };

  return [...cards].sort((a, b) => {
    const ra = rank[tier(a)] ?? 3;
    const rb = rank[tier(b)] ?? 3;
    if (ra !== rb) return ra - rb;

    if (tier(a) === 'live') {
      // Drawing now: the one closing soonest is the most urgent.
      const av = a._close ?? Number.MAX_SAFE_INTEGER;
      const bv = b._close ?? Number.MAX_SAFE_INTEGER;
      if (av !== bv) return av - bv;
    } else if (tier(a) === 'closed') {
      // Just finished: the most recent close wins.
      const av = a._close ?? Number.MAX_SAFE_INTEGER;
      const bv = b._close ?? Number.MAX_SAFE_INTEGER;
      if (av !== bv) return bv - av;
    } else {
      // Still to come: soonest first.
      const av = a._open ?? Number.MAX_SAFE_INTEGER;
      const bv = b._open ?? Number.MAX_SAFE_INTEGER;
      if (av !== bv) return av - bv;
    }

    // Stable tiebreak so the order never flickers between polls.
    return String(a.market).localeCompare(String(b.market));
  });
}

/** Drop the internal sort keys before the payload leaves the server. */
function strip(cards) {
  return cards.map(({ _open, _close, ...rest }) => rest);
}

/**
 * Build the whole live board from a list of raw market rows.
 *
 * @param {Array}  rows   provider or fixture markets, any shape that has
 *                        openTime / closeTime (12h or 24h)
 * @param {object} opts
 * @param {number} opts.now     minutes since midnight; defaults to the clock
 * @param {number} opts.limit   max cards; defaults to the original board size
 */
export function buildLiveBoard(rows, { now = nowMinutes(), limit = BOARD_SIZE } = {}) {
  const cards = (rows ?? [])
    .map((r) => toLiveCard(r, now))
    // A market with no parseable times cannot be scheduled, so it is not
    // something the live board should pretend to know about.
    .filter((c) => c.status !== 'unknown' && c.market);

  return strip(rankLiveCards(cards).slice(0, limit));
}

export { BOARD_SIZE };