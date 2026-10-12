import mongoose from 'mongoose';

/**
 * A market YOU created and maintain yourself.
 *
 * These are merged into the public market list alongside the markets
 * returned by the paid provider, sorted by open time so they sit in the
 * same flow as everything else (see server/services/mergeMarkets.js).
 *
 * The result is NOT stored here - results live in the Result model so a
 * market can accumulate history day by day.
 */
const marketSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },

    // Draw times as HH:mm in 24h form. Stored canonically so sorting and
    // "is it draw time yet" checks are trivial.
    openTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    closeTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },

    active: { type: Boolean, default: true },

    // Day-of-week indices the market is closed on. 0 = Sunday, 1 = Monday,
    // ... 6 = Saturday. Default [0, 6] = closed Sun + Sat (traditional matka
    // schedule). Set by the admin UI; the chart API uses it to render ** for
    // off-day cells instead of blank data.
    offDays: {
      type: [Number],
      default: () => [0, 6],
      validate: {
        validator: (v) =>
          Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 6),
        message: 'offDays must be integers 0..6',
      },
    },

    // True for markets fed by an external push provider (Maharashtra webhook).
    // Push-driven markets reveal by RESULT, not by clock: open-only shows
    // "223-7" until the close half lands, then the full "223-76-680" at once.
    // Manually-declared markets keep the clock gate so early declares stay hidden.
    pushDriven: { type: Boolean, default: false },

    // Optional grouping shown in the admin list.
    category: { type: String, default: 'Custom', trim: true, maxlength: 40 },

    note: { type: String, default: '', maxlength: 500 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

marketSchema.index({ active: 1, closeTime: 1 });
marketSchema.index({ createdBy: 1 });

/** Minutes since midnight, used for chronological sorting. */
marketSchema.methods.minutesOfDay = function (hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Build a Set of 0..6 day indices for fast O(1) lookups. */
marketSchema.methods.offDaySet = function () {
  const days = this.offDays ?? [];
  return days.length ? new Set(days) : null;
};

/**
 * Hide/unhide every market owned by a user.
 * Used when a super admin deactivates that admin, so their markets leave
 * the public site immediately.
 */
marketSchema.statics.setOwnerActive = async function (ownerId, active) {
  return this.updateMany({ createdBy: ownerId }, { $set: { active } });
};

/** Build a Set of 0..6 day indices for fast O(1) lookups. */
marketSchema.statics.ownerCounts = async function (ownerIds) {
  const rows = await this.aggregate([
    { $match: { createdBy: { $in: ownerIds } } },
    {
      $group: {
        _id: '$createdBy',
        total: { $sum: 1 },
        active: { $sum: { $cond: ['$active', 1, 0] } },
      },
    },
  ]);

  const map = new Map();
  for (const r of rows) {
    map.set(String(r._id), { total: r.total, active: r.active });
  }
  return map;
};

export const Market = mongoose.model('Market', marketSchema);
