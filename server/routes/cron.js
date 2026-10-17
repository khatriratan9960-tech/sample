import { Router } from 'express';
import { syncSattaApiResults } from '../services/provider.js';

const router = Router();

/**
 * GET /api/cron/sync-results
 *
 * Vercel Cron calls this on a schedule. Protected by CRON_SECRET header.
 * Fetches today's results from sattaapi.com and stores them in MongoDB.
 *
 * Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
 * We also accept ?secret= or x-cron-secret header for external cron services.
 */
router.get('/sync-results', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  const provided =
    req.headers['x-cron-secret'] ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) ||
    req.query.secret;

  if (!expected || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized cron request' });
  }

  try {
    const result = await syncSattaApiResults();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;