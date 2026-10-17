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

/* ------------------------------------------------------------------ *
 * Chart history - mirrors GET /api/chart.php on the Express API.
 * Deterministic weekly history per market slug, using the same matka
 * math as src/lib/fakeChart.js so the mock board and the real API
 * stay in sync and jodi/panel history loads without MongoDB.
 * ------------------------------------------------------------------ */

/** FNV-1a seed -> deterministic PRNG (port of fakeChart.js hashSeed). */
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** Mulberry32 PRNG (port of fakeChart.js mulberry32). */
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
const pad2 = (n) => String(n).padStart(2, '0');
const digitRank = (d) => (Number(d) === 0 ? 10 : Number(d));
function sortPanna(panna) {
  return String(panna)
    .split('')
    .sort((a, b) => digitRank(a) - digitRank(b))
    .join('');
}
function panna(rand) {
  return sortPanna([0, 1, 2].map(() => Math.floor(rand() * 10)).join(''));
}
function digitSum(num) {
  return String(num).split('').reduce((sum, d) => sum + (Number(d) || 0), 0);
}
/** Last digit of the sum of a panna's digits (the Ank). */
function ankOf(num) {
  return digitSum(num) % 10;
}
/** Jodi = Open Ank followed by Close Ank (derived, never random). */
function jodiOf(openPanna, closePanna) {
  return `${ankOf(openPanna)}${ankOf(closePanna)}`;
}
function prettyName(slug) {
  return (slug || 'market').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
const fmtDate = (d) =>
  `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;

/**
 * Deterministic fake weekly history for a market slug (oldest-first),
 * same response shape the Express /api/chart.php returns so ChartPage.jsx
 * renders jodi/panel history even when MongoDB is not available.
 * @returns { market, weeks: [{label, days:[{open,close,jodi,openAnk,closeAnk,missing,isFuture,offDay}]}], latest, storedDays, source, offDays }
 */
function mockChartHistory(slug, weekCount = 24) {
  const rand = mulberry32(hashSeed(`live-matka-fake:${slug}`));
  const today = new Date();
  const monday = new Date(today);
  const dow = (monday.getDay() + 6) % 7; // Mon=0
  monday.setDate(monday.getDate() - dow - (weekCount - 1) * 7);
  const weeks = [];
  let latest = null;
  let storedDays = 0;
  for (let w = 0; w < weekCount; w++) {
    const start = new Date(monday);
    start.setDate(start.getDate() + w * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + d);
      const isFuture = date > today;
      // ~5% historic gaps render ** like the real site.
      const missing = !isFuture && rand() < 0.05;
      const open = panna(rand);
      const close = panna(rand);
      const jodi = jodiOf(open, close);
      const day = { date: fmtDate(date), open, close, jodi, openAnk: ankOf(open), closeAnk: ankOf(close), missing: isFuture || missing, isFuture, offDay: false };
      days.push(day);
      if (!day.missing) {
        storedDays += 1;
        latest = day; // oldest-first walk, so this ends on the newest real day
      }
    }
    weeks.push({ label: `${fmtDate(start)} to ${fmtDate(end)}`, days });
  }
  return { market: prettyName(slug), weeks, latest, storedDays, source: 'mock', offDays: null };
}

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

  if (url.pathname === '/api/chart.php') {
    const slug = (url.searchParams.get('slug') ?? '').trim();
    const weeksN = Math.min(Math.max(Number(url.searchParams.get('weeks')) || 24, 1), 520);
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'slug is required' }));
    }
    return send(res, { ok: true, provider: 'mock', data: mockChartHistory(slug, weeksN) });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}).listen(8000, () => {
  console.log(`Mock API listening on http://localhost:8000 (${allMarkets.length} markets, board built from the clock)`);
});
