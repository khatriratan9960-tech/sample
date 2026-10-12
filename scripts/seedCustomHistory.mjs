/**
 * One-off backfill: seed past chart history for EXISTING custom markets
 * that still have no Result history. New markets no longer need this -
 * POST /api/admin/markets seeds them automatically.
 *
 *   node scripts/seedCustomHistory.mjs --dry-run
 *   node scripts/seedCustomHistory.mjs
 *   node scripts/seedCustomHistory.mjs --slug my-market
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const slugIdx = args.indexOf('--slug');
const onlySlug = slugIdx >= 0 ? String(args[slugIdx + 1] ?? '').toLowerCase() : null;

const mongoUrl = process.env.MONGO_URL;
const dbName = process.env.DB_NAME || 'dpboss';
if (!mongoUrl) throw new Error('MONGO_URL is not set (.env). Aborting.');

await mongoose.connect(mongoUrl, { dbName, serverSelectionTimeoutMS: 8000 });
try {
  const { Market } = await import('../server/models/Market.js');
  const { Result } = await import('../server/models/Result.js');
  const { seedCustomMarketHistory } = await import('../server/services/customHistorySeed.js');

  const filter = { pushDriven: { $ne: true } };
  if (onlySlug) filter.slug = onlySlug;
  const markets = await Market.find(filter).sort({ name: 1 }).lean();
  console.log(`custom markets=${markets.length} dryRun=${dryRun}`);
  for (const m of markets) {
    const count = await Result.countDocuments({ market: m._id });
    if (count > 0) {
      console.log(`  - ${m.slug}: skip (already has ${count} halves)`);
      continue;
    }
    if (dryRun) {
      console.log(`  - ${m.slug}: would seed`);
      continue;
    }
    const r = await seedCustomMarketHistory(m);
    console.log(`  - ${m.slug}: seeded ${r.seeded} days`);
  }
  console.log('done.');
} finally {
  await mongoose.disconnect();
}
