/**
 * Single place where the app talks to the backend.
 *
 * Vite proxies /api -> http://localhost:8000 (the PHP server) in dev,
 * so the browser only ever makes same-origin requests. That means
 * CORS is a non-issue and the paid API key never reaches the client.
 *
 * SWAPPING TO THE PAID API: nothing below changes. Set PROVIDER_BASE_URL
 * and PROVIDER_API_KEY on the server (see .env.example).
 */

const BASE = '/api';

// Fail fast on Vercel: a hung upstream must never leave the UI on
// "Loading..." past the 5s budget (serverless functions time out at ~10s
// anyway). The server serves cached rows instantly via stale-while-
// revalidate, so anything slower than ~4.5s here is a real outage - abort
// and let useApi's background retry pick the page back up.
const FETCH_TIMEOUT_MS = 4500;

// Chart pages build a 52-week grid from MongoDB - on a cold serverless
// function the DB warm-up alone can exceed the 4.5s live-board budget, so
// chart reads get their own generous timeout. The page already shows a
// Loading banner meanwhile and retries silently in the background.
const CHART_TIMEOUT_MS = 20000;

async function getJson(path, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    // Network-level failure OR our 8s timeout - surface something actionable
    // instead of the browser's bare "Failed to fetch".
    if (err?.name === 'AbortError') {
      throw new Error('Results server is taking too long. Showing cached content - retry shortly.');
    }
    throw new Error('Cannot reach the results server. It may be restarting - retry shortly.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let msg = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }

  const body = await res.json();
  if (body && body.ok === false) {
    throw new Error(body.error || 'API returned ok:false');
  }
  return body;
}

export const api = {
  home: () => getJson('/home.php'),
  liveResult: () => getJson('/live-result.php'),
  markets: (slug) =>
    getJson(slug ? `/markets.php?slug=${encodeURIComponent(slug)}` : '/markets.php'),
  starline: (slug = '') =>
    getJson(`/starline.php${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`),

  /**
   * Chart data for a market. The server reads the MongoDB chart-history
   * collection (and the operator's Result rows for custom markets) and returns
   * the same shape fakeChart() uses, so the chart pages can show real history
   * as soon as the trial API has stored a draw for a market.
   */
  chart: (slug, weeks = 24) =>
    getJson(`/chart.php?slug=${encodeURIComponent(slug)}${weeks !== 24 ? `&weeks=${weeks}` : ''}`, CHART_TIMEOUT_MS),
};
