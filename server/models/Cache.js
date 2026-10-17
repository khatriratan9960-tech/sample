import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Fleet-wide key/value cache for pull-provider payloads.
 *
 * Vercel runs N isolated instances (cold starts plus concurrent traffic), so
 * a module-level in-memory cache cannot cap the upstream rate on its own -
 * every upstream fetch is funneled through this single document instead:
 * whoever holds the refresh lease calls the provider, everyone else serves
 * the stored payload. Fleet-wide the upstream is therefore hit at most once
 * per TTL window no matter how traffic scales.
 */
const cacheSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    // The cached payload (sattaapi rows). Mixed so the shape can evolve
    // without a migration.
    data: { type: Schema.Types.Mixed, required: true },
    // When the payload was fetched from the upstream.
    fetchedAt: { type: Date, required: true },
    // Refresh ownership: set while an instance is calling the upstream so
    // concurrent instances serve the stored payload instead of stampeding.
    leaseUntil: { type: Date, default: null, index: true },
    // Who wrote this row (debugging provenance).
    fetchedBy: { type: String, default: 'sattaapi' },
  },
  { timestamps: true }
);

// Housekeeping: a doc untouched for a day is dropped automatically. In
// practice fetchedAt refreshes every TTL window, so live docs never expire.
cacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 86400 });

export const Cache = mongoose.models.Cache || mongoose.model('Cache', cacheSchema);
