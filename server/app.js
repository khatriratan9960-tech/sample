import express from 'express';
import cors from 'cors';
import { connectDbOnce } from './db.js';
import authRoutes, { ensureSeedAdmin } from './routes/auth.js';
import adminMarketRoutes from './routes/adminMarkets.js';
import adminResultRoutes from './routes/adminResults.js';
import adminUserRoutes from './routes/adminUsers.js';
import publicRoutes from './routes/public.js';
import maharashtraWebhookRoutes from './routes/maharashtraWebhook.js';

/**
 * The Express app, shared by both runtimes:
 *
 *   - local dev: server/index.js awaits ensureReady() and calls app.listen()
 *   - Vercel:    api/index.js hands every /api/* request straight to `app`
 *
 * Keeping one definition means routing, JSON errors and the request log are
 * identical in both environments.
 */
export const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
// Providers may ping the webhook as form-encoded or plain text instead of
// JSON — parse those too so the body is never silently dropped.
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));

// Compact request log - useful while wiring the provider up.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });
  next();
});

let readyPromise = null;

/**
 * Connect to MongoDB and seed the first super admin exactly once per
 * process. Local dev runs this at boot; on Vercel it runs lazily on the
 * first request of each cold start - a serverless function must not open
 * connections at import time, because there is no long-lived process to
 * own them.
 */
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await connectDbOnce();
      try {
        await ensureSeedAdmin();
      } catch (err) {
        // Two cold starts can race the bootstrap; the unique username index
        // makes exactly one of them win - the loser just carries on.
        if (err?.code !== 11000) throw err;
      }
    })().catch((err) => {
      readyPromise = null; // a failed attempt must not poison the process
      throw err;
    });
  }
  return readyPromise;
}

// Every API request waits for the DB before touching a route - EXCEPT
// public reads + /api/health, which must answer even when the database is
// unreachable (on Vercel that is exactly when you need it most).
// PUBLIC reads never wait: the DB warms in the background and each query
// fast-fails via readyState checks, so the page renders provider data in
// ~1-2s even on a cold start instead of hanging until Vercel times out
// (which the frontend showed as endless "Loading...").
// Admin/auth routes still wait for the DB.
const PUBLIC_GET_PREFIXES = ['/home.php', '/live-result.php', '/markets.php', '/starline.php', '/chart.php', '/health'];
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  const isPublicGet =
    req.method === 'GET' && PUBLIC_GET_PREFIXES.some((p) => req.path === p || req.path.startsWith(p));
  if (!isPublicGet) {
    ensureReady().then(() => next(), next);
    return;
  }
  // Kick off the connection for future (warm) requests, but NEVER block
  // this response on it. loadCustomMarkets() fast-fails when disconnected.
  ensureReady().catch(() => {});
  return next();
});

// Public endpoints (no auth).
app.use('/api', publicRoutes);

// Push webhook - external providers POST results here. No auth required.
app.use('/api/maharashtra-market-callback', maharashtraWebhookRoutes);

// Auth + admin (JWT required except login).
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminUserRoutes);
app.use('/api/admin', adminMarketRoutes);
app.use('/api/admin', adminResultRoutes);

// 404 for unknown API routes, so a typo never returns HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: `No such endpoint: ${req.method} ${req.path}` });
});

// Central error handler - always JSON, never a stack trace to the client.
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || 'Internal server error',
  });
});

export default app;