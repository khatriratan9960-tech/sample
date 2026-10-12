/**
 * WHEN A CUSTOM MARKET'S DECLARED RESULT BECOMES VISIBLE.
 *
 * The operator is allowed to declare a result long before the draw happens -
 * that is how the admin panel stays useful - but the PUBLIC page must never
 * show it early. Declaring at 09:00 for a market that opens at 09:15 must not
 * publish anything at 09:00.
 *
 * So the clock, not the declaration, decides what is visible:
 *
 *   upcoming  nothing at all, even if both halves are already stored
 *   live      the OPEN half only ("127-0") - it is being drawn right now,
 *             and the close half is still in the future
 *   closed    everything declared for that draw ("190-08-369")
 *
 * This mirrors how a provider market reveals itself in liveBoard.js, so a
 * custom market is indistinguishable from one the provider supplies.
 *
 * Provider markets are untouched: their result data is whatever the upstream
 * API returns, gated by its own logic in liveBoard.js.
 */

import { buildDisplay } from '../models/Result.js';
import { toMinutes, windowStatus } from './marketClock.js';

/**
 * @param {object} market       { openTime, closeTime } in HH:mm 24h form
 * @param {object|null} openRow  declared open half  (session: 'open')
 * @param {object|null} closeRow declared close half (session: 'close')
 * @param {number} now          minutes since midnight in the market timezone
 * @returns {{status, result, ank, isPending, openRow, closeRow, jodi}}
 */
export function revealCustom(market, openRow, closeRow, now) {
  const openMin = toMinutes(market.openTime);
  const closeMin = toMinutes(market.closeTime);
  const status = windowStatus(openMin, closeMin, now);

  if (status === 'unknown') {
    return {
      status,
      result: null,
      ank: null,
      jodi: null,
      isPending: true,
      openRow: null,
      closeRow: null,
    };
  }

  // Which halves the clock has unlocked. Declared-but-not-yet-due rows are
  // deliberately dropped here rather than trusted from the database.
  let visibleOpen = null;
  let visibleClose = null;

  if (status === 'live') {
    // The window is open, so only the open half has been drawn. A close half
    // sitting in the database (declared ahead of time) stays hidden until the
    // window shuts - that is the entire point of this gate.
    visibleOpen = openRow ?? null;
  } else if (status === 'closed') {
    // The draw finished: publish everything declared for it.
    visibleOpen = openRow ?? null;
    visibleClose = closeRow ?? null;
  }
  // 'upcoming' -> today has not opened yet. If the halves passed in are
  // TODAY's early declaration they must stay hidden (that is the whole
  // point of the gate). But when the caller passes YESTERDAY's (or older)
  // completed draw as the fallback, it is shown as the last result so the
  // card never says Loading... while past history exists. Callers decide
  // which case this is via `opts.allowLast` + date check, never here alone.
  // 'upcoming' -> neither half is visible yet (unless opts.allowLast says
  // these rows are a PAST draw shown as the last result).

  const built =
    visibleOpen || visibleClose ? buildDisplay(visibleOpen, visibleClose) : null;
  const ok = built && !built.error ? built : null;

  return {
    status,
    result: ok?.display ?? null,
    ank: ok?.ank ?? null,
    jodi: ok?.jodi ?? null,
    isPending: !ok,
    // The halves that were actually visible, so callers can publish the
    // matching open pana / jodi alongside the display string.
    openRow: visibleOpen,
    closeRow: visibleClose,
  };
}