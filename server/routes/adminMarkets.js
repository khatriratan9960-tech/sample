import { Router } from 'express';
import mongoose from 'mongoose';
import { Market } from '../models/Market.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/** Turn "Kalyan Night 24x7!" into a URL-safe slug. */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** "19:30" -> "07:30 PM" */
function to12Hour(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * Normalise the closed-days list the admin sends.
 *
 * `offDays` is the set of days the market is CLOSED on (0=Sun..6=Sat). Any
 * day NOT in the list is open. Passing an EMPTY array therefore means the
 * market runs all 7 days - this MUST be preserved, not replaced by the
 * [0, 6] default. We only drop non-integers / out-of-range values, de-dup,
 * and sort. When the field is missing entirely (non-array), fall back to the
 * traditional Sun+Sat schedule.
 */
function sanitizeOffDays(offDays) {
  if (!Array.isArray(offDays)) return [0, 6];
  const cleaned = offDays
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(cleaned)].sort((a, b) => a - b);
}

/** GET /api/admin/markets - list custom markets, newest first. */
router.get('/markets', async (req, res) => {
  // A normal admin manages their OWN markets, but must ALSO see the
  // operator's webhook/push markets. Those are created by the external
  // provider push and carry no owner (createdBy: null), so a strict
  // "createdBy: me" filter hides every one of them - the result dropdown
  // would then show only the handful of markets this admin typed in by hand.
  // We therefore include unowned markets too. They stay UN-editable by a
  // normal admin (canManage() still requires ownership), so this only widens
  // what is visible, never what is mutable - and it matches adminResults.js,
  // which already lets any admin declare a result on an unowned push market.
  // A super admin sees everything. (Markets adopted from a deleted user are
  // reassigned to a super admin, so they never end up ownerless.)
  const filter =
    req.user.role === 'super_admin'
      ? {}
      : { $or: [{ createdBy: req.user._id }, { createdBy: null }] };

  const markets = await Market.find(filter).sort({ createdAt: -1 }).lean();

  res.json({
    ok: true,
    count: markets.length,
    scope: req.user.role === 'super_admin' ? 'all' : 'own',
    data: markets.map((m) => ({
      id: String(m._id),
      name: m.name,
      slug: m.slug,
      openTime: m.openTime,
      closeTime: m.closeTime,
      openTimeLabel: to12Hour(m.openTime),
      closeTimeLabel: to12Hour(m.closeTime),
      active: m.active,
      category: m.category,
      note: m.note,
      offDays: m.offDays,
      // Lets a super admin see who owns what.
      owner: m.createdBy ? String(m.createdBy) : null,
      createdAt: m.createdAt,
    })),
  });
});

/** POST /api/admin/markets - create a market. */
router.post('/markets', async (req, res) => {
  const { name, openTime, closeTime, category, note, active, offDays } = req.body ?? {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ ok: false, error: 'Market name is required' });
  }

  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timeRe.test(openTime ?? '') || !timeRe.test(closeTime ?? '')) {
    return res.status(400).json({ ok: false, error: 'Times must be in 24h HH:mm format' });
  }

  // Uniqueness: reject a duplicate name with a clear message rather than
  // letting Mongo throw a duplicate-key error the admin can't interpret.
  const existing = await Market.findOne({ name: new RegExp(`^${escapeRegex(String(name).trim())}$`, 'i') });
  if (existing) {
    return res.status(409).json({ ok: false, error: `A market named "${name}" already exists` });
  }

  try {
    const market = await Market.create({
      name: String(name).trim(),
      slug: slugify(name),
      openTime,
      closeTime,
      category: category?.trim() || 'Custom',
      note: note?.trim() || '',
      active: active !== false,
      offDays: sanitizeOffDays(offDays),
      createdBy: req.user._id,
    });

    res.status(201).json({
      ok: true,
      data: {
        id: String(market._id),
        name: market.name,
        slug: market.slug,
        openTime: market.openTime,
        closeTime: market.closeTime,
        openTimeLabel: to12Hour(market.openTime),
        closeTimeLabel: to12Hour(market.closeTime),
        active: market.active,
        offDays: market.offDays,
      },
    });
  } catch (e) {
    // Unique index on slug (e.g. two names that slugify identically).
    if (e?.code === 11000) {
      return res.status(409).json({ ok: false, error: 'That market name is already in use' });
    }
    throw e;
  }
});

/** True when the caller may modify this market (owner, or any super admin). */
function canManage(req, market) {
  if (req.user.role === 'super_admin') return true;
  return market.createdBy && String(market.createdBy) === String(req.user._id);
}

/** PUT /api/admin/markets/:id - update a market. */
router.put('/markets/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ ok: false, error: 'Invalid market id' });
  }

  const market = await Market.findById(req.params.id);
  if (!market) return res.status(404).json({ ok: false, error: 'Market not found' });
  if (!canManage(req, market)) {
    return res.status(403).json({ ok: false, error: 'You can only edit markets you created' });
  }

  const { name, openTime, closeTime, category, note, active, offDays } = req.body ?? {};

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ ok: false, error: 'Market name cannot be empty' });

    const clash = await Market.findOne({
      _id: { $ne: market._id },
      name: new RegExp(`^${escapeRegex(trimmed)}$`, 'i'),
    });
    if (clash) {
      return res.status(409).json({ ok: false, error: `A market named "${trimmed}" already exists` });
    }
    market.name = trimmed;
    // Keep the slug in step with the name so links stay correct.
    market.slug = slugify(trimmed);
  }

  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (openTime !== undefined) {
    if (!timeRe.test(openTime)) {
      return res.status(400).json({ ok: false, error: 'Open time must be HH:mm (24h)' });
    }
    market.openTime = openTime;
  }
  if (closeTime !== undefined) {
    if (!timeRe.test(closeTime)) {
      return res.status(400).json({ ok: false, error: 'Close time must be HH:mm (24h)' });
    }
    market.closeTime = closeTime;
  }

  if (category !== undefined) market.category = String(category).trim() || 'Custom';
  if (note !== undefined) market.note = String(note).trim();
  if (active !== undefined) market.active = Boolean(active);

  // Off-days: 0 = Sunday, 1 = Monday, ... 6 = Saturday. Any day NOT listed is
  // open, so an empty array = open all 7 days. Values outside 0..6 (or
  // non-integers) are dropped, duplicates removed, and the list sorted.
  // sanitizeOffDays preserves [] (all-days-on) and only falls back to [0, 6]
  // when the field is absent/non-array.
  if (offDays !== undefined) {
    market.offDays = sanitizeOffDays(offDays);
  }

  await market.save();

  res.json({
    ok: true,
    data: {
      id: String(market._id),
      name: market.name,
      slug: market.slug,
      openTime: market.openTime,
      closeTime: market.closeTime,
      openTimeLabel: to12Hour(market.openTime),
      closeTimeLabel: to12Hour(market.closeTime),
      active: market.active,
      offDays: market.offDays,
    },
  });
});

/** DELETE /api/admin/markets/:id - remove a market and its results. */
router.delete('/markets/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ ok: false, error: 'Invalid market id' });
  }

  // Load first, authorise, then delete - findByIdAndDelete would remove the
  // document before the ownership check could run.
  const market = await Market.findById(req.params.id);
  if (!market) return res.status(404).json({ ok: false, error: 'Market not found' });
  if (!canManage(req, market)) {
    return res.status(403).json({ ok: false, error: 'You can only delete markets you created' });
  }

  await market.deleteOne();

  // Results are useless without their market.
  const { Result } = await import('../models/Result.js');
  const { deletedCount } = await Result.deleteMany({ market: market._id });

  res.json({ ok: true, deletedResults: deletedCount });
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default router;

