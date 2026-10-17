import { config } from '../config.js';

/**
 * SattaAPI (sattaapi.com) client.
 *
 * POST https://matkaapi.sattaapi.com/wp-json/satta/v1/results
 * Body: { api_key, domain_key, domain }
 * Response: { results: { data: [{ name, open, close, jodi }] } }
 *
 * This is a PULL provider - we call it on a cron schedule, store results
 * in MongoDB, and the public API reads from the database.
 */

const API_URL = process.env.SATTAAPI_BASE_URL || 'https://matkaapi.sattaapi.com/wp-json/satta/v1/results';

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
 * Fetch today's results from sattaapi.com.
 * Returns [{ name, open, close, jodi, date }].
 * Throws on failure - caller decides fallback.
 */
export async function fetchSattaApi() {
  if (!isSattaApiConfigured()) {
    throw new Error('SattaAPI credentials not configured');
  }

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
  return data.map((r) => ({
    name: String(r.name ?? '').trim(),
    open: String(r.open ?? '').trim(),
    close: String(r.close ?? '').trim(),
    jodi: String(r.jodi ?? '').trim(),
    date,
  }));
}

/** Simple URL slug from a market name. */
export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    || 'market';
}