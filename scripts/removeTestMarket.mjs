/**
 * One-off: remove the admin-created TEST market (12:00 AM - 11:59 PM window,
 * i.e. the admin form's 00:00-23:59 default) from the public site.
 *
 * Dry run (default) only REPORTS what would be removed:
 *   node scripts/removeTestMarket.mjs
 *
 * Actually delete the market AND its declared results (same cascade as
 * DELETE /api/admin/markets/:id):
 *   node scripts/removeTestMarket.mjs --yes
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const apply = process.argv.includes('--yes');

const mongoUrl = process.env.MONGO_URL;
const dbName = process.env.DB_NAME || 'dpboss';
if (!mongoUrl) throw new Error('MONGO_URL is not set (.env). Aborting.');

await mongoose.connect(mongoUrl, { dbName, serverSelectionTimeoutMS: 8000 });
try {
  const { Market } = await import('../server/models/Market.js');
  const { Result } = await import('../server/models/Result.js');
  const { User } = await import('../server/models/User.js');

  // Exact matches only - never touch a market whose name merely contains
  // "test" (e.g. "LATEST") - plus a fuzzy list purely for the report.
  const exact = await Market.find({
    $or: [{ slug: 'test' }, { name: /^test$/i }],
  }).lean();
  const fuzzy = await Market.find({ name: /test/i, _id: { $nin: exact.map((m) => m._id) } })
    .select('name slug openTime closeTime active')
    .lean();

  if (fuzzy.length) {
    console.log('Other markets whose name contains "test" (NOT touched):');
    for (const m of fuzzy) console.log(`  - ${m.name} (${m.slug}) ${m.openTime}-${m.closeTime}`);
  }

  if (!exact.length) {
    console.log('No market named TEST / slug test found. Nothing to do.');
    process.exit(0);
  }

  let resultsDeleted = 0;
  for (const m of exact) {
    const owner = m.createdBy ? await User.findById(m.createdBy).select('username role').lean() : null;
    const resultCount = await Result.countDocuments({ market: m._id });
    const latest = await Result.findOne({ market: m._id }).sort({ date: -1 }).select('date display').lean();

    console.log(`\nMarket:     ${m.name} (slug: ${m.slug})`);
    console.log(`  id:         ${m._id}`);
    console.log(`  window:     ${m.openTime} -> ${m.closeTime}  (12h: 12:00 AM -> 11:59 PM)`);
    console.log(`  active:     ${m.active}   pushDriven: ${m.pushDriven}   category: ${m.category ?? ''}`);
    console.log(`  created:    ${m.createdAt} by ${owner ? `${owner.username} (${owner.role})` : 'UNKNOWN/seeded'}`);
    console.log(`  results:    ${resultCount} declared half(s)${latest ? `, latest ${latest.date} = ${latest.display}` : ''}`);
    console.log(`  note:       ${m.note || '(none)'}`);

    if (apply) {
      const del = await Result.deleteMany({ market: m._id });
      resultsDeleted += del.deletedCount ?? 0;
      await Market.deleteOne({ _id: m._id });
      console.log(`  DELETED market + ${del.deletedCount ?? 0} result row(s)`);
    }
  }

  if (!apply) {
    console.log('\nDRY RUN - nothing was deleted. Re-run with --yes to remove.');
  } else {
    const left = await Market.countDocuments({ $or: [{ slug: 'test' }, { name: /^test$/i }] });
    console.log(`\nDONE. markets deleted: ${exact.length}, results deleted: ${resultsDeleted}, still present: ${left}`);
  }
} finally {
  await mongoose.disconnect();
}
