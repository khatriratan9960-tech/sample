import { config } from '../config.js';
import { lookupSchedule } from './marketSchedule.js';

/**
 * Matka trial API (matkaapi.com) - stateless, no IP check, history must be
 * stored server-side. Params: domain_key (required) + domain (required).
 *
 *   https://www.matkaapi.com/mapi/market_api.php?market_list=1&domain_key=...&domain=...
 *
 * Behavior replicated here:
 *   - response cache ~45s (upstream "same request min 10 sec gap" honoured)
 *   - single shared promise while a fetch is in flight (no request storms)
 *   - never throws the public page: last successful payload is served
 *   - market_list + market=all unioned into one row list:
 *       roster rows -> every market the trial knows (Loading state until drawn)
 *       result rows -> today's announced draws for those markets
 *     markets that appear only in market=all are still returned (union)
 *   - rows shaped exactly like the fixture rows the rest of the stack already
 *     understands (open/close/jodi trap included), so mergeMarkets + liveBoard
 *     need no changes
 *   - chart history is written from these rows by chartHistory.js (5-min
 *     throttle, idempotent upserts keyed {slug, date})
 */

const SOURCE = 'matka';

/** Read live each call so tests / env reloads take effect without reboot. */
function matkaCfg() {
  return {
    // Empty (default) = webhook-only install: no trial pull feed, so never
    // call the upstream. A key present via env/config re-enables the pull.
    key: process.env.MATKA_DOMAIN_KEY || config.matka.domainKey || '',
    domain: process.env.MATKA_DOMAIN || config.matka.domain || '',
    baseUrl: process.env.MATKA_BASE_URL || config.matka.baseUrl || 'https://www.matkaapi.com/mapi',
    cacheMs: Number(process.env.MATKA_CACHE_MS || config.matka.cacheMs || 45_000),
    timeoutMs: Number(process.env.MATKA_TIMEOUT_MS || config.matka.timeoutMs || 15_000),
  };
}

const cache = { rows: null, fetchedAt: 0 };
let pending = null;

/**
 * Fatal upstream answers (plan exhausted, domain-lock mismatch, bad key) do
 * NOT change on their own - retrying every request is pure waste and each
 * doomed fetch can hold the public page open for seconds. After one such
 * answer, stop calling the upstream for a cooldown window and serve the last
 * cached payload (or nothing) instantly. Transient failures (abort, network
 * blip) keep the normal 45s cache behaviour.
 */
const fatal = { until: 0, message: '' };
const FATAL_COOLDOWN_MS = Number(process.env.MATKA_COOLDOWN_MS || 5 * 60 * 1000);

/** True while a final upstream answer (limit/domain/key) is in cooldown. */
export function upstreamDead() {
  return fatal.until > Date.now();
}

/** "11:40 AM" style -> minutes since midnight (12h clock). */
function toMinutesLocal(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const ampm = s.match(/^(\d{1,2}):([0-5]\d)\s*([APap])\.?[Mm]?\.?$/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3].toLowerCase() === 'p') h += 12;
    return h * 60 + Number(ampm[2]);
  }
  const plain = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (plain) return Number(plain[1]) * 60 + Number(plain[2]);
  return null;
}

/** minutes -> "11:40 AM". */
function to12HourLocal(minutes) {
  if (minutes == null) return '';
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Normalize the trial API's "558-84-789" into our matka field contract:
 *   open  -> 3-digit open panna
 *   close -> 2-digit jodi
 *   jodi  -> 3-digit close panna   (matches the fixture naming trap)
 */
function parseResult(result) {
  const s = String(result ?? '').trim();
  if (!s) return null;
  const parts = s.split('-').map((p) => p.trim()).filter(Boolean);
  if (!parts.every((p) => /^\d+$/.test(p))) return null; // 'Loading', '-', etc.
  if (parts.length === 3 && parts[0].length === 3 && parts[2].length === 3) {
    return {
      open: parts[0],
      close: String(parts[1]).padStart(2, '0'),
      jodi: parts[2],
      display: `${parts[0]}-${parts[1]}-${parts[2]}`,
    };
  }
  if (parts.length === 2 && parts[1].length === 2) {
    return { open: parts[0], close: parts[1], jodi: null, display: `${parts[0]}-${parts[1]}` };
  }
  if (parts.length === 1) {
    return { open: parts[0], close: null, jodi: null, display: parts[0] };
  }
  return null;
}

/** Row ready for the shared market list (roster or with a drawn result). */
function normalizeRow(raw, { date, includeResult } = {}) {
  const name = String(raw.name ?? raw.market ?? '').trim();
  if (!name) return null;
  const openTime = toMinutesLocal(raw.open_time ?? raw.openTime);
  const closeTime = toMinutesLocal(raw.close_time ?? raw.closeTime);
  const base = {
    market: name,
    slug: slugFromName(name),
    name,
    open: undefined,
    close: undefined,
    jodi: undefined,
    openTime: openTime != null ? to12HourLocal(openTime) : (lookupSchedule(name)?.open ?? ''),
    closeTime: closeTime != null ? to12HourLocal(closeTime) : (lookupSchedule(name)?.close ?? ''),
    date: date ?? todayStr(),
    result: undefined,
    display: undefined,
    source: SOURCE,
  };
  if (includeResult) {
    const parsed = parseResult(raw.result);
    if (!parsed) return null; // no draw declared yet - skip entirely
    return { ...base, open: parsed.open, close: parsed.close, jodi: parsed.jodi, result: parsed.display, display: parsed.display };
  }
  return base;
}

function slugFromName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One upstream call (used by the test harness to count hits). */
async function requestMatka(path, kind) {
  const { key, domain, baseUrl, timeoutMs } = matkaCfg();
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  if (kind === 'list') url.searchParams.set('market_list', '1');
  else url.searchParams.set('market', 'all');
  if (domain) url.searchParams.set('domain', domain);
  url.searchParams.set('domain_key', key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`matka API HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    // Upstream sometimes prepends PHP warnings before the JSON body.
    const start = text.search(/[{[]/);
    const body = start > 0 ? text.slice(start) : text;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`matka API non-JSON: ${text.slice(0, 160)}`);
    }
    if (Array.isArray(data)) return { status: true, data };
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMatka(path, kind) {
  const data = await requestMatka(path, kind);
  if (data && data.status === false) {
    const message = data.message || 'matka API reported an error';
    // status:false is an API-level answer (limit reached / domain not
    // matched / invalid key) - the next call would get the exact same
    // reply, so remember it and stop hammering the upstream.
    fatal.until = Date.now() + FATAL_COOLDOWN_MS;
    fatal.message = message;
    const err = new Error(message);
    err.fatalUpstream = true;
    throw err;
  }
  return data;
}
export async function fetchMatkaMarkets() {
  const { key, cacheMs } = matkaCfg();
  if (!key) return [];
  // The upstream already told us the answer is final (limit reached, domain
  // mismatch): don't wait on another doomed HTTP round-trip - serve the last
  // good payload (or none) immediately.
  if (fatal.until > Date.now()) return cache.rows ?? [];
  // A request is already in flight: hand back that same promise so concurrent
  // callers share ONE upstream hit. `pending` is the promise itself (NOT an
  // object with a .promise field) - returning pending.promise here returned
  // undefined on the first call after every cold start, which propagated an
  // undefined market list and collapsed the live board.
  if (pending) return pending;
  const now = Date.now();
  if (cache.rows && now - cache.fetchedAt < cacheMs) return cache.rows;
  pending = (async () => {
    let rows = [];
    try {
      // ONE upstream hit per cache window (the stub/test counts hits):
      // roster (market_list) + today's draws (market=all) in parallel, so a
      // slow second call can never double page time. The union below keeps
      // every roster market (Loading until drawn) plus any draw-only market.
      const [listRes, allRes] = await Promise.all([
        fetchMatka('market_api.php', 'list'),
        fetchMatka('market_api.php', 'results').catch((err) => {
          console.warn('[matkaApi] market=all failed: ' + err.message);
          return { data: [] };
        }),
      ]);
      const roster = Array.isArray(listRes?.data)
        ? listRes.data.map((raw) => normalizeRow(raw)).filter(Boolean)
        : [];
      if (roster.length === 0) {
        throw new Error('market_list=1 returned no markets');
      }
      const results = Array.isArray(allRes?.data)
        ? allRes.data.map((raw) => normalizeRow(raw, { includeResult: true })).filter(Boolean)
        : [];
      const bySlug = new Map();
      for (const r of results) bySlug.set(r.slug, r);
      rows = roster.map((r) => {
        const hit = bySlug.get(r.slug);
        return hit ? { ...r, ...hit } : r;
      });
      // Totally unlisted markets still belong to this domain (today's "all"
      // response carries more than the roster). They get a place in the list
      // and their draws are fully chart-historied.
      for (const r of results) {
        if (!rows.some((m) => m.slug === r.slug)) rows.push(r);
      }
      cache.rows = rows;
      // A real payload proves the upstream works again - clear any cooldown.
      fatal.until = 0;
      fatal.message = '';
    } catch (err) {
      // Never crash the public page: keep the last good payload (if any) and
      // retry on the next 45s tick.
      console.warn('[matkaApi] fetch failed: ' + err.message);
      if (!cache.rows) cache.rows = [];
      rows = [...cache.rows];
    } finally {
      cache.fetchedAt = Date.now();
      pending = null;
    }
    return rows;
  })();
  return pending;
}
