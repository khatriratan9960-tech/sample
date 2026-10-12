/**
 * AUTO-SEED PAST CHART HISTORY FOR NEW CUSTOM MARKETS (ONLY).
 *
 * When an admin creates a manual custom market (pushDriven !== true) it used
 * to open with an empty chart - the operator then had to declare every past
 * day by hand. This seeder runs ONCE right after Market.create() and fills
 * past Jodi + Panel draws as Result halves, so both chart pages work at once.
 *
 * Scope guard:
 *   - Custom (manual) markets ONLY. Provider markets live in ChartEntry and
 *     push/webhook markets (pushDriven === true) are NEVER touched here.
 *
 * Validity (so verify-chart.mjs can never fail on a seeded market):
 *   - Panna digits printed ascending in 1..9,0 order (0 sorts LAST, e.g. 370).
 *   - Open Ank  = (d1+d2+d3 of open panna) % 10  (sum mod 10, NOT last digit).
 *   - Close Ank = (d1+d2+d3 of close panna) % 10.
 *   - number field for each half = its own ank (single digit string).
 *   - Jodi = openAnk followed by closeAnk (two chars, e.g. "15").
 *   - display built ONLY via buildDisplay() from Result.js, so the stored
 *     string is byte-identical to what adminResults.js would have stored.
 *   - Off-days (market.offDays) are SKIPPED so the chart renders ** there.
 *   - Only PAST dates are seeded (up to yesterday) - today stays empty for
 *     the operator's live declare, and future cells stay blank.
 *   - Deterministic per market slug (hash + mulberry32, same idea as
 *     fakeChart) so each custom market gets its OWN unique history, and a
 *     retry produces the same draws (upsert key market+date+session).
 */
import { Result, buildDisplay } from '../models/Result.js';
import { todayStr } from './marketClock.js';

const SEED_DAYS = Number(process.env.CUSTOM_HISTORY_DAYS ?? 730); // ~2 years of past draws

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const digitRank = (d) => (Number(d) === 0 ? 10 : Number(d));
const sortPanna = (p) =>
  String(p).split('').sort((a, b) => digitRank(a) - digitRank(b)).join('');
const digitSum = (s) => String(s).split('').reduce((a, d) => a + Number(d), 0);
const panaAnk = (p) => digitSum(p) % 10;

function randomPanna(rand) {
  const raw = [0, 1, 2].map(() => Math.floor(rand() * 10)).join('');
  return sortPanna(raw);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymdOf(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function parseYMD(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Seed past Result halves for ONE newly created custom market.
 * No-op for push/webhook markets and for markets that already have history.
 * @returns {Promise<{seeded: number, skipped: boolean, reason?: string}>}
 */
export async function seedCustomMarketHistory(marketDoc) {
  if (!marketDoc || marketDoc.pushDriven === true) {
    return { seeded: 0, skipped: true, reason: 'not-custom' };
  }
  const already = await Result.countDocuments({ market: marketDoc._id });
  if (already > 0) return { seeded: 0, skipped: true, reason: 'has-history' };

  const offSet = new Set(Array.isArray(marketDoc.offDays) ? marketDoc.offDays : []);
  const todayS = todayStr();
  const todayD = parseYMD(todayS);
  const rand = mulberry32(hashSeed(`custom-history:${marketDoc.slug}`));

  const ops = [];
  for (let back = 1; back <= SEED_DAYS; back++) {
    const dt = new Date(todayD);
    dt.setDate(dt.getDate() - back);
    const date = ymdOf(dt);
    if (offSet.has(dt.getDay())) continue; // closed day -> chart shows **

    const openPana = randomPanna(rand);
    const closePana = randomPanna(rand);
    const openNum = String(panaAnk(openPana));
    const closeNum = String(panaAnk(closePana));
    const built = buildDisplay(
      { number: openNum, pana: openPana },
      { number: closeNum, pana: closePana }
    );
    if (built.error) continue; // never store an invalid draw
    // Cross-check the maths before queuing (defensive: fail silent, skip day).
    const expectJodi = `${panaAnk(openPana)}${panaAnk(closePana)}`;
    if (built.jodi !== expectJodi) continue;

    for (const session of ['open', 'close']) {
      const half = session === 'open'
        ? { number: openNum, pana: openPana }
        : { number: closeNum, pana: closePana };
      ops.push({
        updateOne: {
          filter: { market: marketDoc._id, date, session },
          update: {
            $setOnInsert: {
              market: marketDoc._id,
              date,
              session,
              number: half.number,
              pana: half.pana,
              ank: Number(half.number),
              display: built.display,
              jodi: built.jodi,
              jodiComplete: true,
            },
            $set: {
              // Keep display/jodi/ank correct even if the half somehow exists.
              display: built.display,
              jodi: built.jodi,
              jodiComplete: true,
              ank: Number(half.number),
              number: half.number,
              pana: half.pana,
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (!ops.length) return { seeded: 0, skipped: true, reason: 'no-days' };
  let written = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const res = await Result.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    written += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0) + (res.matchedCount ?? 0);
  }
  return { seeded: ops.length / 2, skipped: false };
}
