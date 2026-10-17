import { config } from '../config.js';

/**
 * SattaAPI (sattaapi.com) client.
 *
 * POST https://matkaapi.sattaapi.com/wp-json/satta/v1/results
 * Body: { api_key, domain_key, domain }
 * Response: { results: { data: [{ name, open, close, jodi, result_date, ... }] } }
 *
 * This is a PULL provider - we call it on a cron schedule, store results
 * in MongoDB, and the public API reads from the database.
 *
 * SHORT-LIVED CACHE (~45s): the frontend polls /live-result.php every 15s
 * per visitor, and /home.php also calls fetchSattaApi via fetchProviderLive.
 * Without a cache every single page view / poll hits the upstream API,
 * which is slow (1-3s round trip) and can hit rate limits. 45s keeps the
 * board fresh enough (results are declared a few times per hour) while
 * cutting upstream calls by ~90%.
 */

const API_URL = process.env.SATTAAPI_BASE_URL || 'https://matkaapi.sattaapi.com/wp-json/satta/v1/results';
const CACHE_TTL_MS = Number(process.env.SATTAAPI_CACHE_TTL_MS || 45_000);
let cache = { data: null, fetchedAt: 0 };
let inflight = null;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Today's date in Asia/Kolkata (UTC+5:30), YYYY-MM-DD. */
export function todayKolkata() {
  const d = new Date();
  const offsetMs = 5.5 * 60 * 60 * 1000; // IST offset
  const local = new Date(d.getTime() + offsetMs);
  return `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
}

/** True when sattaapi credentials are configured. */
export function isSattaApiConfigured() {
  return !!(process.env.SATTAAPI_API_KEY && process.env.SATTAAPI_DOMAIN_KEY && process.env.SATTAAPI_DOMAIN);
}

/**
 * Fetch today's results from sattaapi.com (with 45s cache).
 * Returns [{ name, open, close, jodi, result_date, date }].
 * Throws on failure - caller decides fallback.
 */
export async function fetchSattaApi() {
  if (!isSattaApiConfigured()) {
    throw new Error('SattaAPI credentials not configured');
  }

  // Serve from cache if fresh enough.
  if (cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  // Deduplicate concurrent calls: when multiple visitors hit the board at
  // the same moment, only ONE upstream request goes out; the rest await it.
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.SATTAAPI_API_KEY,
        domain_key: process.env.SATTAAPI_DOMAIN_KEY,
        domain: process.env.SATTAAPI_DOMAIN,
      }),
    });

    if (!res.ok) {
      throw new Error(`SattaAPI HTTP ${res.status}`);
    }

    const body = await res.json();
    const data = body?.results?.data ?? [];

    const date = todayKolkata();
    const mapped = data.map((r) => ({
      name: String(r.name ?? '').trim(),
      open: String(r.open ?? '').trim(),
      close: String(r.close ?? '').trim(),
      jodi: String(r.jodi ?? '').trim(),
      // Night markets carry yesterday's date - pass it through so the
      // cron sync stores the result under the correct chart day.
      result_date: String(r.result_date ?? '').trim(),
      open_time: String(r.open_time ?? '').trim(),
      close_time: String(r.close_time ?? '').trim(),
      date,
    }));

    cache = { data: mapped, fetchedAt: Date.now() };
    return mapped;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Simple URL slug from a market name. */
export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    || 'market';
}