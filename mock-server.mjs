/**
 * Zero-dependency Node stand-in for the PHP API.
 *
 * Use this ONLY when PHP is not installed locally. It serves the exact
 * same JSON contract as php-api/*.php so the React app behaves identically.
 *
 *   node mock-server.mjs          -> listens on :8000
 *
 * In production the Express API (npm run api) serves these routes; the PHP
 * files under php-api/ are kept for reference / standalone PHP hosting.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The live board is derived from the clock rather than read off a frozen list,
// so the mock behaves like the live site. Shared with the Express server so
// both rank and reveal identically.
import { buildLiveBoard } from './server/services/liveBoard.js';
import { nowMinutes, toMinutes, windowStatus, publicStatus } from './server/services/marketClock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const php = readFileSync(join(__dirname, 'php-api/data/mock.php'), 'utf8');

// Parse the PHP fixture arrays without executing PHP.
function parseRows(fnName) {
  // Match the function name only - parameters/return types vary.
  const start = php.search(new RegExp(`function\\s+${fnName}\\s*\\(`));
  if (start === -1) return [];
  const open = php.indexOf('[', start);
  const close = php.indexOf('];', open);
  const body = php.slice(open + 1, close);
  const rows = [];

  // Split on "],[" boundaries rather than matching "[...]" - a value can
  // contain characters that break a naive character class.
  const chunks = body.split(/\]\s*,\s*\[/);
  for (const chunk of chunks) {
    const obj = {};
    // Keys are alphanumeric; values are null or single-quoted strings.
    const fre = /'([A-Za-z]+)'\s*=>\s*(null|'((?:[^'\\]|\\.)*)')/g;
    let f;
    while ((f = fre.exec(chunk)) !== null) {
      obj[f[1]] = f[2] === 'null' ? null : f[3].replace(/\\'/g, "'");
    }
    if (Object.keys(obj).length) rows.push(obj);
  }
  return rows;
}

const markets = parseRows('mockMarkets');
const starline = parseRows('mockStarline');

// Content sections live in a shared JSON file - identical payload to PHP.
const sections = JSON.parse(
  readFileSync(join(__dirname, 'php-api/data/sections.json'), 'utf8')
);
const {
  goldenAnk,
  finalAnk,
  starlineTables,
  weeklyCharts,
  freeGame,
  dayTables,
  passList,
  passListDate,
  linkZones,
} = sections;

/**
 * Winning ank = last digit of the JODI. A result is printed "open-jodi-close",
 * so with three parts the jodi is the MIDDLE one - "257-48-369" -> 8, not 9.
 * Mirrors deriveAnk() in php-api/_bootstrap.php.
 */
function deriveAnk(value) {
  if (!value) return null;
  const parts = String(value).split(/[^0-9]+/).filter(Boolean);
  if (!parts.length) return null;
  const part = parts.length >= 3 ? parts[1] : parts[parts.length - 1];
  const n = parseInt(part, 10);
  return Number.isNaN(n) ? null : n % 10;
}

const normMarket = (r) => {
  // Three-part "257-48-369"; two-part "357-5" when there is no jodi.
  const hasAll = r.open != null && r.close != null && r.jodi != null && r.jodi !== '';
  const hasPair = r.open != null && r.close != null && !hasAll;

  let result = null;
  if (hasAll) result = `${r.open}-${r.close}-${r.jodi}`;
  else if (hasPair) result = `${r.open}-${r.close}`;
  else if (r.jodi != null && r.jodi !== '') result = String(r.jodi);

  return {
    market: r.market,
    open: r.open ?? null,
    close: r.close ?? null,
    jodi: r.jodi ?? null,
    result,
    openTime: r.openTime ?? '',
    closeTime: r.closeTime ?? '',
    ank: deriveAnk(result),
    status: publicStatus(toMinutes(r.openTime), toMinutes(r.closeTime), nowMinutes(), result !== null),
    slug: r.slug,
    jodiUrl: `/jodi-chart-record/${r.slug}.php`,
    panelUrl: `/panel-chart-record/${r.slug}.php`,
  };
};

// Built per request, not once at startup, so the board tracks the clock as
// the server keeps running.
const buildLive = () => buildLiveBoard(markets);

// Public list ordered by OPEN time (earliest first) - the same chronology the
// homepage grid renders. Unparseable times sink to the end; ties break
// alphabetically so the order never flickers between loads.
const allMarkets = markets
  .map(normMarket)
  .sort((a, b) => {
    const av = toMinutes(a.openTime);
    const bv = toMinutes(b.openTime);
    if (av == null && bv == null) return String(a.market).localeCompare(String(b.market));
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return av - bv;
    return String(a.market).localeCompare(String(b.market));
  });

const send = (res, payload) => {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const now = new Date().toISOString();

  if (url.pathname === '/api/home.php') {
    return send(res, {
      ok: true,
      provider: 'mock',
      updatedAt: now,
      data: {
        todayLuckyNumber: { goldenAnk, finalAnk },
        liveResults: buildLive(),
        markets: allMarkets,
        starline: starlineTables.mainStarline,
        starlineTables,
        weeklyCharts,
        freeGame,
        dayTables,
        passList,
        passListDate,
        linkZones,
      },
    });
  }

  if (url.pathname === '/api/live-result.php') {
    return send(res, { ok: true, provider: 'mock', updatedAt: now, data: buildLive() });
  }

  if (url.pathname === '/api/markets.php') {
    const slug = url.searchParams.get('slug');
    if (slug) {
      const one = allMarkets.find((m) => m.slug === slug);
      if (!one) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: `Unknown market slug: ${slug}` }));
      }
      return send(res, { ok: true, provider: 'mock', data: one });
    }
    return send(res, { ok: true, provider: 'mock', count: allMarkets.length, data: allMarkets });
  }

  if (url.pathname === '/api/starline.php') {
    return send(res, { ok: true, provider: 'mock', slug: url.searchParams.get('slug') ?? '', count: starline.length, data: starline });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}).listen(8000, () => {
  console.log(`Mock API listening on http://localhost:8000 (${allMarkets.length} markets, board built from the clock)`);
});
