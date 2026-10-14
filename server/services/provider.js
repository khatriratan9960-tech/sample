import { config } from '../config.js';
import { readFileSync } from 'node:fs';
import { buildLiveBoard } from './liveBoard.js';
import { fetchMatkaMarkets } from './matkaApi.js';
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
  if (config.matka.domainKey) return 'matka';
  return config.provider.baseUrl ? 'paid' : 'mock';
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
  if (config.matka.domainKey) {
    // Trial: cached copy of all markets + today's draws, never throws the
    // public page, rate-limit friendly (45s cache, 10s gap honoured).
    const rows = await fetchMatkaMarkets();
    // The trial plan is capped (matkaapi.com returns
    // "Trial request limit reached" once total_req hits plan_limit). When the
    // feed is empty for ANY reason (limit reached, network blip, domain lock),
    // fall back to the bundled fixtures so the market board keeps rendering a
    // full list instead of an endless "Loading...". Real draws resume the
    // moment a working key/plan is available again.
    if (Array.isArray(rows) && rows.length) return rows;
    return fixtures().rows.map((r) => ({ ...r }));
  }
  if (!config.provider.baseUrl) {
    return fixtures().rows.map((r) => ({ ...r }));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.provider.timeoutMs);

  try {
    const res = await fetch(`${config.provider.baseUrl}/live-result`, {
      headers: {
        'X-API-Key': config.provider.apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Upstream returned HTTP ${res.status}`);
    }

    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];

    // TODO(paid): map the vendor's field names onto our contract here.
    // Expected: [{ market/name, open, close, jodi, openTime, closeTime, slug }]
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProviderLive() {
  if (config.matka.domainKey) {
    // Trial: all markets + today's draws -> the live board builds the
    // time-driven cards exactly like the fixture path.
    const rows = await fetchMatkaMarkets();
    // Same fallback as fetchProviderMarkets: when the trial feed is empty
    // (request cap reached, outage, domain lock), build the live board from the
    // bundled fixtures so the LIVE RESULT cards keep populating instead of
    // sitting on "Loading...".
    return buildLiveBoard(Array.isArray(rows) && rows.length ? rows : fixtures().rows);
  }
  if (!config.provider.baseUrl) {
    return buildLiveBoard(fixtures().rows);
  }

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
