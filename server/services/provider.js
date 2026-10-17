import { config } from '../config.js';
import { readFileSync } from 'node:fs';
import { buildLiveBoard } from './liveBoard.js';
import { fetchSattaApi, isSattaApiConfigured, slugify } from './sattaApi.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(__dirname, '..', '..', 'php-api');

/** Read the seeded fixtures so mock mode has real-looking markets.
 *  LAZY: files are only read if mock mode is actually used. On Vercel an
 *  import-time readFileSync throws when the data files are not bundled into
 *  the serverless function, which would crash EVERY /api/* route at import. */
let fixturesCache = null;
function fixtures() {
  if (!fixturesCache) {
    const mockPhp = readFileSync(join(API_DIR, 'data', 'mock.php'), 'utf8');
    const sections = JSON.parse(readFileSync(join(API_DIR, 'data', 'sections.json'), 'utf8'));

    const rows = [];
    const start = mockPhp.search(/function\s+mockMarkets\s*\(/);
    const body = mockPhp.slice(mockPhp.indexOf('[', start), mockPhp.indexOf('];', start));

    for (const chunk of body.split(/\]\s*,\s*\[/)) {
      const obj = {};
      const re = /'([A-Za-z]+)'\s*=>\s*(null|'((?:[^'\\]|\\.)*)')/g;
      let m;
      while ((m = re.exec(chunk)) !== null) {
        obj[m[1]] = m[2] === 'null' ? null : m[3].replace(/\\'/g, "'");
      }
      if (obj.market) rows.push(obj);
    }

    fixturesCache = { rows, sections };
  }
  return fixturesCache;
}

/** Static content sections (golden ank, starlines, charts, game zones).
 *  NEVER read from disk here: on Vercel the fixture files may not be bundled
 *  into the serverless function, and a throw would crash every /api/* route.
 *  These sections are editorial content identical for every visitor; an empty
 *  shape keeps the homepage rendering while markets come from the trial API.
 *  If mock mode is active and the files exist, fixtures() enriches this. */
const EMPTY_SECTIONS = {
  goldenAnk: null,
  finalAnk: null,
  starlineTables: { mainStarline: [] },
  weeklyCharts: [],
  freeGame: [],
  dayTables: [],
  passList: [],
  passListDate: null,
  linkZones: [],
};
/** Which upstream are we actually talking to? */
export function providerName() {
  if (isSattaApiConfigured()) return 'sattaapi';
  if (process.env.WEBHOOK_ONLY === '1' || process.env.DISABLE_MOCK_MARKETS === '1') return 'webhook';
  return config.provider.baseUrl ? 'paid' : 'mock';
}

function sattaApiMode() {
  return isSattaApiConfigured();
}

/**
 * Webhook-only mode: the operator uses ONLY the matka-result-api.com push
 * webhook (Maharashtra callback) and no pull API at all. Explicitly enabled
 * with WEBHOOK_ONLY=1 (or DISABLE_MOCK_MARKETS=1). It is ALSO the default in
 * production when no pull credentials are configured (no trial key, no paid
 * base URL): the provider side stays empty and the public board is built
 * purely from MongoDB markets (webhook pushes + admin declares). In local
 * dev with no keys, mock fixtures still load so the stack stays testable.
 */
function webhookOnly() {
  if (process.env.WEBHOOK_ONLY === '1' || process.env.DISABLE_MOCK_MARKETS === '1') return true;
  if (config.provider.baseUrl) return false;
  return config.isProd;
}

/**
 * Fetch markets from the upstream provider.
 *
 * When no credentials are configured this returns the seeded fixtures, so the
 * whole stack (admin, custom markets, merge, frontend) is fully testable
 * before the paid API is purchased. Point PROVIDER_BASE_URL at the real
 * service and this transparently switches over - no other file changes.
 */
export async function fetchProviderMarkets() {
  // SattaAPI pull mode - discover markets from the API response.
  if (sattaApiMode()) {
    try {
      const results = await fetchSattaApi();
      const seen = new Set();
      return results
        .filter((r) => {
          if (!r.name || seen.has(r.name)) return false;
          seen.add(r.name);
          return true;
        })
        .map((r) => ({
          market: r.name,
          slug: slugify(r.name),
          source: 'provider',
          pushDriven: true,
          active: true,
          openTime: '00:00',
          closeTime: '23:59',
          provider: 'sattaapi',
        }));
    } catch (err) {
      console.error('[sattaapi] fetchProviderMarkets failed:', err.message);
      return [];
    }
  }

  // Webhook-only: no pull API at all - the provider side stays empty and the
  // operator's MongoDB markets (webhook pushes + admin declares) fill the board.
  if (webhookOnly()) return [];

  // Mock/dev: seeded fixtures.
  return fixtures().rows.map((r) => ({ ...r }));
}

export async function fetchProviderLive() {
  // SattaAPI pull mode - fetch today's results and build live cards.
  if (sattaApiMode()) {
    try {
      const results = await fetchSattaApi();
      return results.map((r) => {
        const openPana = r.open;
        const closePana = r.close;
        const jodi = r.jodi.padStart(2, '0');
        const openAnk = String(openPana).slice(-1);
        const closeAnk = String(closePana).slice(-1);
        const result = `${openPana}-${jodi}-${closePana}`;

        // Use the API's real 12h times so the live board can rank cards by
        // their actual draw window (e.g. Kalyan 4:35-6:35 PM). The old
        // 00:00/23:59 placeholder made every market look "live" all day.
        const to24h = (t12) => {
          if (!t12) return null;
          const m = String(t12).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
          if (!m) return null;
          let h = Number(m[1]) % 12;
          if (m[3].toUpperCase() === 'PM') h += 12;
          return `${String(h).padStart(2, '0')}:${m[2]}`;
        };

        return {
          market: r.name,
          slug: slugify(r.name),
          result,
          ank: Number(closeAnk),
          source: 'provider',
          pushDriven: true,
          openTime: to24h(r.open_time) || '00:00',
          closeTime: to24h(r.close_time) || '23:59',
          isPending: false,
          status: 'closed',
          isImminent: false,
          open: openPana,
          close: closePana,
          jodi,
          resultDate: r.result_date || null,
        };
      });
    } catch (err) {
      console.error('[sattaapi] fetchProviderLive failed:', err.message);
      return [];
    }
  }

  // Webhook-only: no pull feed at all - the operator's real MongoDB markets
  // fill the live board.
  if (webhookOnly()) return [];

  // Paid provider: fetch live results from the commercial API.
  if (config.provider.baseUrl) {
    try {
      const res = await fetch(`${config.provider.baseUrl}/live-result`, {
        headers: { 'X-API-Key': config.provider.apiKey, Accept: 'application/json' },
      });
      const body = await res.json();
      return Array.isArray(body?.data) ? body.data : [];
    } catch {
      // Never let an upstream outage break the public page.
      return [];
    }
  }

  // Mock/dev: seeded fixtures.
  return buildLiveBoard(fixtures().rows);
}

/**
 * Sync today's sattaapi results into MongoDB (Result + ChartEntry).
 * Called by the cron endpoint. Returns { synced, skipped, total, date }.
 */
export async function syncSattaApiResults() {
  if (!sattaApiMode()) {
    return { synced: 0, skipped: 0, total: 0, error: 'sattaapi not configured' };
  }

  const { Market } = await import('../models/Market.js');
  const { Result } = await import('../models/Result.js');
  const { ChartEntry } = await import('../models/ChartEntry.js');
  const { buildDisplay } = await import('../models/Result.js');
  const { todayStr: todayFn } = await import('./marketClock.js');

  const results = await fetchSattaApi();
  const fallbackDate = todayFn();
  let synced = 0;
  let skipped = 0;

  for (const r of results) {
    if (!r.name || !r.open || !r.close || !r.jodi) {
      skipped++;
      continue;
    }

    // Use the API's result_date when available: night markets (Kalyan Night,
    // Milan Night, etc.) carry YESTERDAY's date because their draw closes
    // after midnight IST. Storing them under today would overwrite today's
    // pending row and hide the result from the correct chart day.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.result_date || '') ? r.result_date : fallbackDate;

    // Find or create market by name (case-insensitive).
    const safeName = r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let market = await Market.findOne({ name: { $regex: new RegExp(`^${safeName}$`, 'i') } });

    // The API provides real 12h times ("11:40 AM") - store them in 24h so the
    // live board / market clock can gate results by open/close window instead
    // of the placeholder 00:00-23:59 that made everything look "live" all day.
    const to24h = (t12) => {
      if (!t12) return null;
      const m = String(t12).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) return null;
      let h = Number(m[1]) % 12;
      if (m[3].toUpperCase() === 'PM') h += 12;
      return `${String(h).padStart(2, '0')}:${m[2]}`;
    };
    const openTime24 = to24h(r.open_time) || '00:00';
    const closeTime24 = to24h(r.close_time) || '23:59';

    if (!market) {
      market = await Market.create({
        name: r.name,
        slug: slugify(r.name),
        openTime: openTime24,
        closeTime: closeTime24,
        active: true,
        pushDriven: true,
        source: 'sattaapi',
      });
    } else if (market.openTime === '00:00' && market.closeTime === '23:59' && (r.open_time || r.close_time)) {
      // Backfill real times on markets created before the API times were stored.
      await Market.updateOne({ _id: market._id }, { $set: { openTime: openTime24, closeTime: closeTime24 } });
      market.openTime = openTime24;
      market.closeTime = closeTime24;
    }

    const openPana = r.open;
    const closePana = r.close;
    const openAnk = String(openPana).slice(-1);
    const closeAnk = String(closePana).slice(-1);
    const jodi = r.jodi.padStart(2, '0');

    // Upsert open half
    await Result.findOneAndUpdate(
      { market: market._id, date, session: 'open' },
      {
        $set: {
          number: openAnk,
          pana: openPana,
          ank: Number(openAnk),
          jodi: null,
          jodiComplete: false,
          display: `${openPana}-${openAnk}`,
        },
      },
      { upsert: true, new: true }
    );

    // Upsert close half - completes the draw
    const disp = buildDisplay({ pana: openPana, number: openAnk }, { pana: closePana, number: closeAnk });
    await Result.findOneAndUpdate(
      { market: market._id, date, session: 'close' },
      {
        $set: {
          number: closeAnk,
          pana: closePana,
          ank: Number(closeAnk),
          jodi: disp.jodi ?? jodi,
          jodiComplete: true,
          display: disp.display,
        },
      },
      { upsert: true, new: true }
    );

    // Upsert chart entry for chart pages
    await ChartEntry.findOneAndUpdate(
      { slug: market.slug, date },
      {
        $set: {
          openPana,
          closePana,
          jodi: disp.jodi ?? jodi,
          date,
        },
      },
      { upsert: true, new: true }
    );

    synced++;
  }

  return { synced, skipped, total: results.length, date: fallbackDate };
}

export const getSections = () => {
  // Editorial sections (Golden Ank, Final Ank, Starline tables, weekly charts,
  // free game, day tables, pass list, link zones) are static content identical
  // for every visitor - the bundled sections.json is the operator's source of
  // truth for them. Prefer it in EVERY provider mode (mock, trial, paid): only
  // the market *rows* come from the upstream. Previously trial/paid mode forced
  // EMPTY_SECTIONS here, which blanked Final Ank, Golden Ank and the starline
  // tables even though sections.json was bundled. Only if the file is missing
  // (e.g. not bundled into the function) do we fall back to the empty shape.
  try {
    return fixtures().sections;
  } catch {
    /* fixtures unavailable - never throw, never touch disk */
  }
  return EMPTY_SECTIONS;
};
