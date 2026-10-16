import { Router } from 'express';
import mongoose from 'mongoose';
import { Market } from '../models/Market.js';
import { Result, buildDisplay } from '../models/Result.js';
import { todayStr } from '../services/marketClock.js';
import { lookupSchedule, to24h } from '../services/marketSchedule.js';
import { invalidateCustomMarkets } from '../services/marketService.js';

const router = Router();

// Validation patterns (mirror the Result model constraints).
const OPEN_PANA_RE = /^\d{3}$/;
const OPEN_DIGIT_RE = /^\d{1,2}$/;
const CLOSE_PANA_RE = /^\d{3}$/;
const CLOSE_DIGIT_RE = /^\d{1,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Maharashtra market result webhook (push).
 *
 * External providers POST a completed draw to this endpoint. The payload
 * follows the API documentation:
 *
 *   POST /api/maharashtra-market-callback
 *   Content-Type: application/json
 *
 *   {
 *     "marketName": "SITA MORNING",
 *     "resultDate": "2026-06-30",
 *     "apiOpenPana": "223",
 *     "apiOpenDigit": "7",
 *     "apiClosePana": "680",
 *     "apiCloseDigit": "6"
 *   }
 *
 * The webhook:
 *   1. Validates every field.
 *   2. Looks up the market by name (case-insensitive, must be active).
 *   3. Upserts the OPEN half and CLOSE half using the unique index
 *      (market, date, session) — re-pushing the same result updates it
 *      instead of duplicating.
 *   4. Derives the jodi + display string via buildDisplay() and returns it.
 *
 * Only Maharashtra markets are accepted. Any other market name returns 404.
 */
router.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    ready: true,
    message: 'Maharashtra market webhook is live. Send POST with JSON body to push results.',
    endpoint: 'POST /api/maharashtra-market-callback',
    example: {
      marketName: 'SITA MORNING',
      resultDate: '2026-06-30',
      apiOpenPana: '223',
      apiOpenDigit: '7',
      apiClosePana: '680',
      apiCloseDigit: '6',
    },
  });
});

router.head('/', (req, res) => {
  res.status(200).end();
});

function bodyOf(req) {
  let body = req.body;
  // Provider may POST as text/plain or form-encoded: try to recover JSON.
  if (typeof body === 'string') {
    const s = body.trim();
    if (!s) return {};
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }
  if (!body || typeof body !== 'object') return {};
  // express.urlencoded() nests JSON under a single key when the checker
  // sends the sample as a form field — unwrap it.
  const keys = Object.keys(body);
  if (keys.length === 1 && typeof body[keys[0]] === 'string') {
    try {
      const parsed = JSON.parse(body[keys[0]]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* not JSON — treat as probe below */
    }
  }
  return body;
}

/**
 * Provider "Check Now" buttons typically ping the URL with an empty body
 * (or a GET, or form-encoded junk) just to see if it is reachable. Answer
 * those probes with 200 so the dashboard shows success — real pushes with
 * fields still go through strict validation below.
 *
 * IMPORTANT: once saved, this URL must NEVER answer non-2xx to the
 * provider's checker, or it disables the webhook. So validation failures
 * also answer HTTP 200 (with saved:false + error explaining which field
 * tripped) — only a real server crash answers 5xx.
 */
function isVerificationProbe(body) {
  if (!body || typeof body !== 'object') return true;
  if (Object.keys(body).length === 0) return true;
  // A ping that carries no result fields at all is a checker, not a push.
  const hasAnyField =
    body.marketName != null ||
    body.resultDate != null ||
    body.date != null ||
    body.apiOpenPana != null ||
    body.openPana != null ||
    body.openPanna != null ||
    body.apiOpenDigit != null ||
    body.openDigit != null ||
    body.apiClosePana != null ||
    body.closePana != null ||
    body.closePanna != null ||
    body.apiCloseDigit != null ||
    body.closeDigit != null;
  return !hasAnyField;
}

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

router.post('/', async (req, res) => {
  try {
  const raw = bodyOf(req);
  if (isVerificationProbe(raw)) {
    return res.status(200).json({
      ok: true,
      ready: true,
      message: 'Maharashtra market webhook is live. Send result JSON to push.',
    });
  }

  // DB unreachable (cold start still warming, Atlas outage): never let the
  // queries buffer into a hang/5xx - a non-2xx here can get this webhook
  // URL auto-disabled by the provider. Answer 200 with saved:false so the
  // checker stays green and the operator sees the push did NOT store.
  if (mongoose.connection.readyState !== 1) {
    return res.status(200).json({
      ok: false,
      saved: false,
      error: 'Database not ready - resend this result in a minute',
    });
  }

  let marketName = str(raw.marketName);
  let resultDate = str(raw.resultDate || raw.date);
  let apiOpenPana = str(raw.apiOpenPana ?? raw.openPana ?? raw.openPanna);
  let apiOpenDigit = str(raw.apiOpenDigit ?? raw.openDigit ?? raw.openNumber);
  let apiClosePana = str(raw.apiClosePana ?? raw.closePana ?? raw.closePanna);
  let apiCloseDigit = str(raw.apiCloseDigit ?? raw.closeDigit ?? raw.closeNumber);

  // LENIENT mode: validation removed per operator request.
  const clean = (v) => String(v == null ? "" : v).trim();
  marketName = clean(marketName) || "MAHARASHTRA MARKET";
  resultDate = clean(resultDate);
  apiOpenPana = clean(apiOpenPana);
  apiOpenDigit = clean(apiOpenDigit);
  apiClosePana = clean(apiClosePana);
  apiCloseDigit = clean(apiCloseDigit);

  // Default the date so a push without resultDate still saves + lists today.
  // Partial pushes stay partial: OPEN-only shows as "223-7" until close lands.
  if (!DATE_RE.test(resultDate)) resultDate = todayStr();

  const hasOpen = Boolean(apiOpenPana) && Boolean(apiOpenDigit);
  const hasClose = Boolean(apiClosePana) && Boolean(apiCloseDigit);

  // Nothing usable at all -> checker probe.
  if (!hasOpen && !hasClose) {
    return res.status(200).json({
      ok: true,
      ready: true,
      saved: false,
      message: 'Maharashtra market webhook is live. Send result fields to save.',
    });
  }

  // Validate only the halves that were actually sent, so an OPEN-only push
  // (before the close is drawn) still saves and shows as "223-7".
  if (hasOpen && (!OPEN_PANA_RE.test(apiOpenPana) || !OPEN_DIGIT_RE.test(apiOpenDigit))) {
    return res.status(200).json({
      ok: false,
      saved: false,
      error: 'apiOpenPana must be 3 digits and apiOpenDigit 1-2 digits',
    });
  }
  if (hasClose && (!CLOSE_PANA_RE.test(apiClosePana) || !CLOSE_DIGIT_RE.test(apiCloseDigit))) {
    return res.status(200).json({
      ok: false,
      saved: false,
      error: 'apiClosePana must be 3 digits and apiCloseDigit 1-2 digits',
    });
  }

  const trimmedMarketName = marketName;
  const escaped = trimmedMarketName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let market = await Market.findOne({
    name: { $regex: `^${escaped}$`, $options: 'i' },
    active: true,
  });

  // --- Auto-create the market if it doesn't exist ---
  if (!market) {
    const baseSlug = String(trimmedMarketName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    // Ensure the slug is unique by appending a counter if needed.
    let slug = baseSlug;
    let counter = 1;
    while (await Market.findOne({ slug }).lean()) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    const created = await Market.create({
      name: trimmedMarketName,
      slug,
      // Full-day window: push markets reveal by RESULT (mergeMarkets), but a
      // sane window still sorts them into the public flow correctly.
      openTime: to24h(lookupSchedule(trimmedMarketName)?.open) ?? '00:00',
      closeTime: to24h(lookupSchedule(trimmedMarketName)?.close) ?? '23:59',
      category: 'Custom',
      note: 'Created via webhook push',
      active: true,
      pushDriven: true,
    });

    market = created;
  } else if (!market.pushDriven) {
    // A manual market that the provider now feeds becomes push-driven, so
    // open-only "223-7" shows immediately instead of waiting for the clock.
    market.pushDriven = true;
    await market.save();
  }

  // --- Upsert ONLY the halves that were actually sent ---
  // display/jodi/ank are required on the model, so compute them up-front.
  // OPEN-only stays "223-7" until close lands; CLOSE-only stays "680-6".
  let open = await Result.findOne({ market: market._id, date: resultDate, session: 'open' }).lean();
  let close = await Result.findOne({ market: market._id, date: resultDate, session: 'close' }).lean();

  if (hasOpen) {
    const built = buildDisplay(
      { number: apiOpenDigit, pana: apiOpenPana },
      close ? { number: close.number, pana: close.pana } : null
    );
    open = await Result.findOneAndUpdate(
      { market: market._id, date: resultDate, session: 'open' },
      {
        $set: {
          number: apiOpenDigit,
          pana: apiOpenPana,
          ank: built.ank,
          display: built.display,
          jodi: built.jodi,
          jodiComplete: built.jodiComplete,
        },
      },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }
    );
  }

  if (hasClose) {
    const built = buildDisplay(
      open ? { number: open.number, pana: open.pana } : null,
      { number: apiCloseDigit, pana: apiClosePana }
    );
    close = await Result.findOneAndUpdate(
      { market: market._id, date: resultDate, session: 'close' },
      {
        $set: {
          number: apiCloseDigit,
          pana: apiClosePana,
          ank: built.ank,
          display: built.display,
          jodi: built.jodi,
          jodiComplete: built.jodiComplete,
        },
      },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }
    );
  }

  // Refresh both halves, then rebuild BOTH rows so open + close always share
  // the same display/jodi (open-only "223-7" -> full "223-76-680").
  [open, close] = await Promise.all([
    Result.findOne({ market: market._id, date: resultDate, session: 'open' }),
    Result.findOne({ market: market._id, date: resultDate, session: 'close' }),
  ]);
  const built = buildDisplay(open, close);
  if (!built.error) {
    await Promise.all(
      [open, close]
        .filter(Boolean)
        .map((row) =>
          Result.updateOne(
            { _id: row._id },
            { $set: { display: built.display, jodi: built.jodi, jodiComplete: built.jodiComplete, ank: built.ank } }
          )
        )
    );
    if (open) open = await Result.findById(open._id);
    if (close) close = await Result.findById(close._id);
  }

  // The public board caches loadCustomMarkets() for a few seconds - drop it
  // so this pushed draw is visible on the very next page read.
  invalidateCustomMarkets();

  return res.status(200).json({
    ok: true,
    data: {
      market: market.name,
      marketId: market._id,
      date: resultDate,
      open: open ? {
        pana: open.pana,
        number: open.number,
        display: open.display,
      } : null,
      close: close ? {
        pana: close.pana,
        number: close.number,
        display: close.display,
      } : null,
      // Derived from apiOpenDigit + apiCloseDigit.
      jodi: built.jodi ?? null,
      jodiComplete: built.jodiComplete ?? false,
      ank: built.ank ?? null,
    },
  });
  } catch (err) {
    // A provider's "check" counts any non-2xx as failure — log the real
    // error server-side, but report which field tripped when it is ours.
    // Answer 200 even on DB errors so a saved URL is never auto-disabled.
    console.error('[maharashtra-webhook]', err);
    return res.status(200).json({ ok: false, saved: false, error: err?.message || 'Failed to save result' });
  }
});

export default router;
