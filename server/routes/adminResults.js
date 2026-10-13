import { Router } from 'express';
import mongoose from 'mongoose';
import { Market } from '../models/Market.js';
import { Result, buildDisplay, ankOf } from '../models/Result.js';
import { requireAuth } from '../middleware/auth.js';
import { today } from '../services/marketService.js';

const router = Router();
router.use(requireAuth);

/**
 * Recompute the cached display/jodi for BOTH halves of a market-day.
 * Saving the close half changes what the open half shows, so both rows are
 * rewritten every time. The computed values are in code rather than derived
 * at read time, so the public page stays a single cheap query.
 */
async function recompute(marketId, date) {
  const [openRow, closeRow] = await Promise.all([
    Result.findOne({ market: marketId, date, session: 'open' }).lean(),
    Result.findOne({ market: marketId, date, session: 'close' }).lean(),
  ]);

  const built = buildDisplay(openRow, closeRow);
  if (built.error) return null;

  await Promise.all(
    [openRow, closeRow]
      .filter(Boolean)
      .map((row) =>
        Result.updateOne(
          { _id: row._id },
          {
            $set: {
              display: built.display,
              jodi: built.jodi,
              jodiComplete: built.jodiComplete,
              ank: built.ank,
            },
          }
        )
      )
  );

  return built;
}

/**
 * POST /api/admin/results
 *
 * Declare ONE half of a draw: either the open (number + panna) or the
 * close (number + panna). The jodi is never accepted from the client - it is
 * computed from the two pannas once both halves exist.
 */
router.post('/results', async (req, res) => {
  const { marketId, date, session, number, pana, note } = req.body ?? {};

  if (!mongoose.isValidObjectId(marketId)) {
    return res.status(400).json({ ok: false, error: 'Invalid market id' });
  }

  const market = await Market.findById(marketId);
  if (!market) return res.status(404).json({ ok: false, error: 'Market not found' });

  // Owner, super admin, or any admin for push-driven (webhook) markets —
  // those have no owner (created by the provider push), so without this no
  // normal admin would ever see them in their result dropdown.
  const isOwner = market.createdBy && String(market.createdBy) === String(req.user._id);
  const isPushMarket = market.pushDriven === true;
  if (!isOwner && !isPushMarket && req.user.role !== 'super_admin') {
    return res
      .status(403)
      .json({ ok: false, error: 'You can only declare results for your own markets' });
  }

  const drawDate = (date ?? today()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) {
    return res.status(400).json({ ok: false, error: 'Date must be YYYY-MM-DD' });
  }

  if (!['open', 'close'].includes(session)) {
    return res.status(400).json({ ok: false, error: 'Session must be open or close' });
  }

  const num = String(number ?? '').trim();
  const pan = String(pana ?? '').trim();

  if (!/^\d{1,2}$/.test(num)) {
    return res.status(400).json({ ok: false, error: 'Number must be 1-2 digits (e.g. 7)' });
  }
  if (!/^\d{3}$/.test(pan)) {
    return res.status(400).json({ ok: false, error: 'Panna must be exactly 3 digits (e.g. 257)' });
  }

  // Upsert this half only.
  await Result.findOneAndUpdate(
    { market: market._id, date: drawDate, session },
    {
      $set: {
        number: num,
        pana: pan,
        ank: Number(ankOf(pan)),
        note: note?.trim() || '',
        declaredBy: req.user._id,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  // Now rebuild both halves from scratch so the jodi appears automatically.
  const built = await recompute(market._id, drawDate);

  const openSaved = await Result.exists({ market: market._id, date: drawDate, session: 'open' });
  const closeSaved = await Result.exists({ market: market._id, date: drawDate, session: 'close' });

  res.status(201).json({
    ok: true,
    data: {
      market: market.name,
      date: drawDate,
      session,
      number: num,
      pana: pan,
      display: built?.display ?? null,
      jodi: built?.jodi ?? null,
      jodiComplete: Boolean(built?.jodiComplete),
      ank: built?.ank ?? null,
      // Which halves exist yet, so the UI can prompt for the next one.
      openDeclared: Boolean(openSaved),
      closeDeclared: Boolean(closeSaved),
    },
  });
});

/** GET /api/admin/results - history, newest first. */
router.get('/results', async (req, res) => {
  const { marketId, date, limit } = req.query ?? {};

  const filter = {};
  if (marketId && mongoose.isValidObjectId(marketId)) filter.market = marketId;
  if (date) filter.date = date;

  const results = await Result.find(filter)
    .sort({ date: -1, createdAt: -1 })
    .limit(Math.min(Number(limit) || 100, 500))
    .populate('market', 'name slug')
    .lean();

  res.json({
    ok: true,
    count: results.length,
    data: results.map((r) => ({
      id: String(r._id),
      marketId: String(r.market?._id ?? r.market),
      market: r.market?.name ?? '(deleted market)',
      slug: r.market?.slug ?? '',
      date: r.date,
      session: r.session,
      number: r.number,
      pana: r.pana,
      display: r.display,
      jodi: r.jodi,
      jodiComplete: r.jodiComplete,
      ank: r.ank,
      note: r.note,
      createdAt: r.createdAt,
    })),
  });
});

/** DELETE /api/admin/results/:id - remove one half of a draw. */
router.delete('/results/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ ok: false, error: 'Invalid result id' });
  }

  const result = await Result.findByIdAndDelete(req.params.id);
  if (!result) return res.status(404).json({ ok: false, error: 'Result not found' });

  // Deleting one half changes the other's display (e.g. jodi disappears).
  const built = await recompute(result.market, result.date);

  res.json({ ok: true, display: built?.display ?? null });
});

export default router;
