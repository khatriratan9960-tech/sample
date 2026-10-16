import { config } from '../config.js';
import { readFileSync } from 'node:fs';
import { buildLiveBoard } from './liveBoard.js';
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
  if (process.env.WEBHOOK_ONLY === '1' || process.env.DISABLE_MOCK_MARKETS === '1') return 'webhook';
  return config.provider.baseUrl ? 'paid' : 'mock';
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
  // Webhook-only: no pull API at all - the provider side stays empty and the
  // operator's MongoDB markets (webhook pushes + admin declares) fill the board.
  if (webhookOnly()) return [];

  // Mock/dev: seeded fixtures.
  return fixtures().rows.map((r) => ({ ...r }));
}

export async function fetchProviderLive() {
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
