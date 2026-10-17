import { config } from '../config.js';
import mongoose from 'mongoose';
import { Cache } from '../models/Cache.js';

/**
 * SattaAPI (sattaapi.com) client.
 *
 * POST https://matkaapi.sattaapi.com/wp-json/satta/v1/results
 * Body: { api_key, domain_key, domain }
 * Response: { results: { data: [{ name, open, close, jodi, result_date,
 *   open_time, close_time, fetch_datetime }] } }
 *
 * This is a PULL provider: we call it on a TTL, store results in MongoDB,
 * and the public API reads from the database.
 *
 * TWO-LEVEL CACHE. Vercel runs N isolated instances (cold starts plus
 * concurrent traffic), so a module-level in-memory cache alone cannot cap
 * the upstream rate - every fetch funnels through ONE MongoDB document:
 *
 *   L1  per-instance memory (instant; absorbs the 15s frontend polling)
 *   L2  global MongoDB doc  (shared; whoever holds the refresh lease calls
 *       the upstream, everyone else serves the stored payload)
 *
 * Fleet-wide the upstream is hit at most ONCE per SATTAAPI_CACHE_TTL_MS
 * (default 60s -> ~1,440 calls/day) however many instances serve traffic -
 * inside the provider's 2,000/day quota.
 */

const API_URL = process.env.SATTAAPI_BASE_URL || 'https://matkaapi.sattaapi.com/wp-json/satta/v1/results';
const CACHE_TTL_MS = Number(process.env.SATTAAPI_CACHE_TTL_MS || 60_000);
const CACHE_KEY = 'sattaapi:results';
// How long the refresh owner holds the upstream lock. Longer than any
// realistic fetch + chart write so a slow call cannot stampede.
const LEASE_MS = 120_000;
let mem = { data: null, fetchedAt: 0 };
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
 * Sync-on-read hook: registered once (by provider.js), invoked with the
 * just-fetched rows every time THIS process calls the upstream. Lets the
 * fresh payload persist chart history without a cron and without a second
 * upstream call. A rejection never breaks the fetch itself.
 */
let freshDataHandler = null;
export function onSattaApiFreshData(fn) {
  if (typeof fn === 'function' || fn === null) freshDataHandler = fn;
}

/** Read the global cache doc (null when the DB is unreachable). */
async function readGlobalCache() {
  if (mongoose.connection.readyState !== 1) return null;
  try {
    return await Cache.findOne({ key: CACHE_KEY }).lean().maxTimeMS(2500);
  } catch {
    return null;
  }
}

/** Persist the fresh payload as the fleet-wide last-known-good copy. */
async function writeGlobalCache(data) {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await Cache.updateOne(
      { key: CACHE_KEY },
      { $set: { data, fetchedAt: new Date(), ttlMs: CACHE_TTL_MS, fetchedBy: 'sattaapi' } },
      { upsert: true }
    );
  } catch (err) {
    console.warn('[sattaapi] cache write failed:', err.message);
  }
}

/**
 * Try to become the single fleet-wide refresh owner. Missing/expired leases
 * and first-ever boots all resolve to "we own it" so a cold fleet heals.
 */
async function acquireLease(now) {
  if (mongoose.connection.readyState !== 1) return true;
  try {
    const lease = await Cache.findOneAndUpdate(
      {
        key: CACHE_KEY,
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date(now) } }],
      },
      { $set: { leaseUntil: new Date(now + LEASE_MS), fetchedBy: 'sattaapi' } },
      { new: true, upsert: true }
    ).maxTimeMS(2500);
    return !!lease;
  } catch {
    return true;
  }
}

/** Release the refresh lease (best effort; expiry is the real guard). */
async function releaseLease() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await Cache.updateOne({ key: CACHE_KEY }, { $unset: { leaseUntil: 1 } }).maxTimeMS(2500);
  } catch {
    /* best effort */
  }
}

async function callProvider() {
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
    const body = await res.json().catch(() => null);
    throw new Error(`SattaAPI HTTP ${res.status}${body?.message ? `: ${body.message}` : ''}`);
  }
  const body = await res.json();
  return body?.results?.data ?? [];
}

/**
 * Normalize one upstream row into the row contract the rest of the codebase
 * already speaks (mirrors the fixture naming the board/tests were built
 * against): close carries the 2-digit jodi, jodi the 3-digit close panna,
 * so open-close-jodi renders open-jodi-close.
 *
 * date prefers the API's result_date (night markets close after midnight IST
 * and carry yesterday's date) so chart upserts land on the correct day.
 */
function mapRow(r, fallbackDate) {
  const jodi2 = String(r.jodi ?? '').trim().padStart(2, '0');
  const resultDate = String(r.result_date ?? '').trim();
  return {
    name: String(r.name ?? '').trim(),
    open: String(r.open ?? '').trim(),
    close: jodi2,
    jodi: String(r.close ?? '').trim(),
    result_date: resultDate,
    open_time: String(r.open_time ?? '').trim(),
    close_time: String(r.close_time ?? '').trim(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(resultDate) ? resultDate : fallbackDate,
  };
}

/**
 * Fetch today's results from sattaapi.com (two-level cache).
 * Returns [{ name, open, close, jodi, result_date, date }].
 * Serves the last-known-good payload when the upstream is down; throws only
 * when there is genuinely nothing to serve (no cache, no upstream).
 */
export async function fetchSattaApi() {
  if (!isSattaApiConfigured()) {
    throw new Error('SattaAPI credentials not configured');
  }

  const now = Date.now();

  // L1: per-instance memory - absorbs the 15s frontend polling.
  if (mem.data && now - mem.fetchedAt < CACHE_TTL_MS) {
    return mem.data;
  }

  // L2: fleet-wide MongoDB cache - absorbs every other instance / cold start.
  const g = await readGlobalCache();
  if (g?.data) {
    const at = new Date(g.fetchedAt).getTime();
    if (now - at < CACHE_TTL_MS) {
      mem = { data: g.data, fetchedAt: at };
      return mem.data;
    }
    // Stale but real: keep as the failure fallback below.
    mem = { data: g.data, fetchedAt: at };
  }

  // L3: refresh. Same-process callers share one upstream call; concurrent
  // PROCESSES are serialized by the lease - only the owner dials out.
  if (inflight) return inflight;
  inflight = (async () => {
    const owner = await acquireLease(now);
    try {
      if (!owner) {
        // Another instance owns the refresh: poll briefly for the payload it
        // is about to store, else serve the stale copy we already hold.
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const again = await readGlobalCache();
          if (again?.data && Date.now() - new Date(again.fetchedAt).getTime() < CACHE_TTL_MS) {
            const at = new Date(again.fetchedAt).getTime();
            mem = { data: again.data, fetchedAt: at };
            return mem.data;
          }
        }
        if (mem.data) return mem.data;
        throw new Error('SattaAPI refresh in progress elsewhere');
      }
      const raw = await callProvider();
      // An empty upstream payload is a glitch, not a delisting (markets do
      // not vanish wholesale): keep serving last-known-good instead of
      // wiping the cache and the board.
      if ((!raw || raw.length === 0) && mem.data?.length) {
        console.warn('[sattaapi] upstream returned no markets; serving cached payload');
        return mem.data;
      }
      const mapped = raw.map((r) => mapRow(r, todayKolkata()));
      mem = { data: mapped, fetchedAt: Date.now() };
      await writeGlobalCache(mapped);
      // Sync-on-read: persist chart history for the fresh payload. Awaited
      // (not fire-and-forget) so the write lands before the response - the
      // handler fast-fails off-DB, so a cold start never holds the request.
      if (freshDataHandler) {
        try {
          await freshDataHandler(mapped);
        } catch (err) {
          console.warn('[sattaapi] sync-on-read failed:', err?.message ?? err);
        }
      }
      return mapped;
    } catch (err) {
      // Upstream down / rate-limited: serve last-known-good instead of a
      // blank board. Throw only when there is nothing real to serve, so
      // callers can fall back to mock fixtures.
      if (mem.data) {
        console.warn('[sattaapi] fetch failed, serving cached payload:', err.message);
        return mem.data;
      }
      throw err;
    } finally {
      await releaseLease();
    }
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