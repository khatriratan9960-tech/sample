import mongoose from 'mongoose';
import { ChartEntry } from '../models/ChartEntry.js';
import { Market } from '../models/Market.js';
import { Result } from '../models/Result.js';
import { todayStr as today } from './marketClock.js';
import { waitForDb } from './dbWait.js';

/**
 * DAILY CHART HISTORY FOR THE TRIAL API.
 *
 * The trial API is stateless: it only hands back today's draw. To show
 * charts in the future we store every completed draw in MongoDB as soon as
 * it appears:
 *
 *   GET /api/home.php and /api/live-result.php -> fetchMatkaMarkets() ->
 *     syncChartHistory(rows) -> upsert { slug, date } into ChartEntry
 *
 * A 5-minute throttle keeps the writes sane; upserts are keyed {slug, date}
 * so repeated syncs are no-ops. Chart pages read back {weeks, latest,
 * storedDays} from this collection plus the operator's own Result rows for
 * custom markets.
 */

const SYNC_INTERVAL_MS = Number(process.env.CHART_SYNC_MS ?? 5 * 60 * 1000);
const ANK_RE = /^\d+$/;

let lastSync = 0;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Day-of-week index for a YYYY-MM-DD date (0=Sun..6=Sat). */
function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** "2026-10-08" -> "08/10/2026" (chart week labels). */
function formatShort(dateStr) {
  const m = String(dateStr ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr ?? '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Add days to a YYYY-MM-DD date (server local timezone). */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** Monday of the week containing that date. */
export function mondayOf(dateStr) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, day);
  const dow = dt.getDay(); // 0 = Sunday .. 6 = Saturday
  const diff = dow === 0 ? -6 : 1 - dow; // back to Monday
  dt.setDate(dt.getDate() + diff);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** Last digit of a 3-digit panna (sum of digits mod 10). */
function ankOf(pana) {
  const s = String(pana ?? '').trim();
  if (!ANK_RE.test(s)) return null;
  let sum = 0;
  for (const ch of s) sum += Number(ch);
  return sum % 10;
}

/** One chart day: real stored data OR a marked-missing placeholder
 *  (mirrors the fakeChart week-cell shape so ChartPage.jsx never has to
 *  know where the data came from).
 *
 * offDaySlots: Set of day-of-week indices (0=Sun..6=Sat) that this market is
 * closed on. A day that is BOTH an off-day AND has no stored entry is marked
 * missing (renders **) instead of trying to show stale data from another day.
 */
function makeDay(entry, custom, date, offDaySlots) {
  const isFuture = date > today();
  const dow = dayOfWeek(date);
  const isOff = offDaySlots?.has(dow);

  if (entry) {
    return {
      open: entry.openPana,
      close: entry.closePana,
      jodi: entry.jodi,
      openAnk: ankOf(entry.openPana),
      closeAnk: ankOf(entry.closePana),
      missing: false,
      isFuture,
      offDay: isOff,
    };
  }
  if (custom) {
    return {
      open: custom.open,
      close: custom.close,
      jodi: custom.jodi,
      openAnk: custom.openAnk,
      closeAnk: custom.closeAnk,
      missing: false,
      isFuture: false,
      offDay: isOff,
    };
  }
  // No stored data and no custom half. If the day is an off-day (or empty),
  // show missing so the chart renders **. Future off-days show as empty
  // (matching the existing "day not yet started" behaviour).
  if (isOff || !isFuture) {
    return { missing: true, isFuture, offDay: isOff };
  }
  return { missing: true, isFuture };
}

/** Build a chart day from a normalized provider row. */
function entryToDay(entry) {
  return {
    open: entry.openPana,
    close: entry.closePana,
    jodi: entry.jodi,
    openAnk: ankOf(entry.openPana),
    closeAnk: ankOf(entry.closePana),
    missing: false,
    isFuture: false,
  };
}

/** Map a market slug -> set of closed day-of-week indices (0=Sun..6=Sat). */
async function getMarketOffDays(slugSlug) {
  try {
    const marketDoc = await Market.findOne({ slug: slugSlug }).lean();
    if (!marketDoc) return null;
    return marketDoc.offDaySet();
  } catch {
    return null;
  }
}

function marketName(slug, marketDoc, entries) {
  if (marketDoc?.name) return marketDoc.name;
  if (entries?.length) return entries[0].market ?? slug;
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A row only becomes a chart day once it carries a full open + jodi +
 *  close panna (3-part draw). Roster rows carry open/close/jodi as undefined
 *  (or partial), so they never pass. */
function isCompleteRow(row) {
  return Boolean(
    row &&
      /^\d{3}$/.test(String(row.open ?? '')) &&
      /^\d{2}$/.test(String(row.close ?? '')) &&
      /^\d{3}$/.test(String(row.jodi ?? ''))
  );
}

/** Store completed draws. 5-minute throttle, idempotent upserts keyed
 *  {slug, date}. NOTE: the field contract carries close=jodi and
 *  jodi=closePana (matches the fixture naming trap), so map accordingly. */
export async function syncChartHistory(rows, source = 'matka', opts = {}) {
  if (!rows?.length) return 0;
  // Sync-on-read forces every fresh upstream fetch through; the politeness
  // throttle only gates the opportunistic page-load callers.
  if (!opts.force && Date.now() - lastSync < SYNC_INTERVAL_MS) return 0;
  // Fast-fail on cold starts: without this Mongoose buffers the bulkWrite
  // until serverSelectionTimeoutMS expires, holding the HTTP response open
  // until Vercel times out (endless "Loading..." on the frontend).
  if (mongoose.connection.readyState !== 1) return 0;
  lastSync = Date.now();
  const ops = [];
  for (const row of rows) {
    if (!isCompleteRow(row)) continue;
    const slug = String(row.slug ?? row.name ?? row.market ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const date = String(row.date ?? today()).slice(0, 10);
    const market = row.market ?? row.name ?? slug;
    ops.push({
      updateOne: {
        filter: { slug, date },
        update: {
          $set: {
            slug,
            market,
            date,
            openPana: String(row.open ?? '').slice(0, 3),
            jodi: String(row.close ?? '').slice(0, 2),
            closePana: String(row.jodi ?? '').slice(0, 3),
            display: `${String(row.open ?? '')}-${String(row.close ?? '')}-${String(row.jodi ?? '')}`,
            source,
          },
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return 0;
  try {
    await ChartEntry.bulkWrite(ops, { ordered: false });
    return ops.length;
  } catch (err) {
    console.warn('[chartHistory] sync failed:', err.message);
    return 0;
  }
}

/** Fire-and-forget wrapper for the live path: the board must never wait on
 *  the chart write - the promise resolves in the background between polls.
 *  Errors are already swallowed inside syncChartHistory.
 *  NEVER awaited by request handlers: on a Vercel cold start the DB may
 *  still be warming and a buffered write would hold the response open
 *  until the function times out (endless "Loading..." on the frontend). */
export function syncChartHistoryFromCards(cards, source = 'matka') {
  if (!cards?.length) return;
  try {
    const p = syncChartHistory(
      cards.map((c) => ({ slug: c.slug, market: c.market, date: c.date, ...parseDisplay(c.result) })),
      source
    );
    // Swallow rejections; never let the write hold the HTTP response.
    if (p?.catch) p.catch(() => {});
  } catch {
    /* non-critical */
  }
}

/** "579-15-366" or "15" -> { open, close, jodi } row shape for the sync. */
function parseDisplay(result) {
  const parts = String(result ?? '').split('-');
  if (parts.length === 3) return { open: parts[0], close: parts[1], jodi: parts[2] };
  return {};
}
/** One public chart payload for a market: { market, weeks, latest, storedDays, source }. */
export async function getChartHistory(slug, weeks = 24) {
  const slugSlug = String(slug ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!slugSlug) {
    return { market: '', weeks: [], latest: null, storedDays: 0, source: 'empty' };
  }
  const todayD = today();
  const weekStart = mondayOf(todayD);
  const rangeStart = addDays(weekStart, -(weeks - 1) * 7);
  const rangeEnd = addDays(weekStart, weeks * 7 - 1);

  // Provider history (matka / mock) - the trial API stores every completed
  // draw, so the last 24 weeks of real data are at hand.
  // COLD START: public chart routes must not instantly fast-fail to empty
  // (it froze chart pages at zero data for minute at a time). Atlas typically
  // connects in <2s, so wait a bounded moment first. If the DB is genuinely
  // down beyond the budget, the guards below catch the resulting nulls and
  // degrade gracefully to an empty chart (never a hang).
  // LATENCY BUDGET: the chart page aborts at ~4.5s. Two parallel waves with
  // 1.5s caps keep the worst case near ~3s total, plus the bounded wait.
  const entriesPromise = waitForDb(1200)
    ? ChartEntry.find({ slug: slugSlug, date: { $gte: rangeStart, $lte: rangeEnd } })
        .sort({ date: 1 })
        .lean()
        .maxTimeMS(1500)
        .catch(() => [])
    : Promise.resolve([]);
  const [entries] = await Promise.all([entriesPromise]);
  const byDate = new Map();
  for (const e of entries) byDate.set(e.date, e);

  // Operator-declared custom markets: their halves live in Result (session
  // open/close). Those rows are the public API for custom draws.
  const custom = new Map();
  let customDays = 0;
  // Market off-days (0=Sun..6=Sat). Chart cells that fall on an off-day and
  // have no stored entry render ** instead of blank.
  // Single market lookup: fetch once and reuse for offDays and the Result
  // scan - the old code hit Market.findOne() TWICE per chart open (once
  // with entries, once with the halves), a pure waste of the latency budget.
  let marketDoc = null;
  let offDaySlots = null;
  if (waitForDb(1200)) {
    marketDoc = await Market.findOne({ slug: slugSlug }).lean().maxTimeMS(1500).catch(() => null);
    if (marketDoc) {
      const days = marketDoc.offDays ?? [];
      offDaySlots = days.length ? new Set(days) : null;
    }
  }

  const needCustom = Boolean(marketDoc && !marketDoc.pushDriven);
  const [results] = await Promise.all([
    needCustom && marketDoc
      ? Result.find({
          market: marketDoc._id,
          date: { $gte: rangeStart, $lte: rangeEnd },
          jodiComplete: true,
        })
          .sort({ date: 1 })
          .lean()
          .maxTimeMS(1500)
          .catch(() => [])
      : Promise.resolve([]),
  ]);
  if (marketDoc) {
    try {
      // Group the two session rows (open + close) per date. The old code
      // used one row's pana for BOTH open and close, so every webhook
      // market showed e.g. open=680 close=680 instead of 223 / 680.
      const halvesByDate = new Map();
      for (const r of results) {
        let entry = halvesByDate.get(r.date);
        if (!entry) {
          entry = { open: null, close: null };
          halvesByDate.set(r.date, entry);
        }
        if (r.session === 'close') entry.close = r;
        else entry.open = r;
      }
      for (const [date, halves] of halvesByDate) {
        const jodi = halves.open?.jodi ?? halves.close?.jodi ?? null;
        if (!halves.open?.pana || !halves.close?.pana || !jodi) continue;
        custom.set(date, {
          open: halves.open.pana,
          close: halves.close.pana,
          jodi,
          openAnk: ankOf(halves.open.pana),
          closeAnk: ankOf(halves.close.pana),
        });
        customDays++;
      }
    } catch {
      /* non-critical */
    }
  }

  const weeksArr = [];
  let latest = null;
  let storedDays = 0;
  // Latest real day, regardless of source — feeds the "latest" gold box on
  // the chart page. Provider entries and webhook (custom) days compete.
  const noteLatest = (open, close, jodi, date) => {
    if (!open || !close || !jodi) return;
    if (!latest || date > latest.date) latest = { open, close, jodi, date };
  };
  let cursor = rangeStart;
  for (let w = 0; w < weeks; w++) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(cursor, i);
      const entry = byDate.get(date);
      const cday = custom.get(date);
      days.push(makeDay(entry, cday, date, offDaySlots));
      if (entry) {
        storedDays++;
        noteLatest(entry.openPana, entry.closePana, entry.jodi, date);
      } else if (cday) {
        storedDays++;
        noteLatest(cday.open, cday.close, cday.jodi, date);
      }
    }
    weeksArr.push({ label: formatShort(cursor) + ' to ' + formatShort(addDays(cursor, 6)), days });
    cursor = addDays(cursor, 7);
  }

  const totalDays = storedDays + customDays;

  // Drop EVERY week that has no real draw at all - leading, trailing, or in
  // the middle. This means gaps in history (e.g. a market with no data for a
  // whole year) simply don't render, instead of showing a wall of ** rows.
  // The first/last week that carries any real day is kept whole (its
  // surrounding blank days still render **, matching the original site). A
  // market with no data at all keeps its weeks untouched (filter drops none).
  const weekHasData = (w) => w.days.some((d) => !d.missing);
  const weeksOut = weeksArr.filter(weekHasData);

  return {
    market: marketName(slugSlug, marketDoc, entries),
    weeks: weeksOut,
    latest,
    storedDays: totalDays,
    source: storedDays > 0 ? 'matka' : customDays > 0 ? 'custom' : 'empty',
    offDays: marketDoc ? marketDoc.offDays : null,
  };
}

