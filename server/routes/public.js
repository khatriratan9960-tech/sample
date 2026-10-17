import { Router } from 'express';
import mongoose from 'mongoose';
import { getPublicMarkets, getPublicLive, today } from '../services/marketService.js';
import { providerName, getSections } from '../services/provider.js';
import { getChartHistory } from '../services/chartHistory.js';
import { missingEnv } from '../config.js';

const router = Router();

/** GET /api/home.php - everything the homepage renders, in one call. */
router.get('/home.php', async (req, res) => {
  const [markets, live, sec] = await Promise.all([
    getPublicMarkets(),
    getPublicLive(),
    Promise.resolve(getSections()),
  ]);

  res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=30');
  res.json({
    ok: true,
    provider: providerName(),
    updatedAt: new Date().toISOString(),
    data: {
      todayLuckyNumber: { goldenAnk: sec.goldenAnk, finalAnk: sec.finalAnk },
      liveResults: live,
      markets,
      starline: sec.starlineTables.mainStarline,
      starlineTables: sec.starlineTables,
      weeklyCharts: sec.weeklyCharts,
      freeGame: sec.freeGame,
      dayTables: sec.dayTables,
      passList: sec.passList,
      passListDate: sec.passListDate,
      linkZones: sec.linkZones,
      // Counts shown in the admin dashboard.
      counts: {
        total: markets.length,
        custom: markets.filter((m) => m.source === 'custom').length,
        provider: markets.filter((m) => m.source === 'provider').length,
        pending: markets.filter((m) => m.status === 'pending').length,
      },
    },
  });
});

/** GET /api/live-result.php - polled every 15s by the frontend. */
router.get('/live-result.php', async (req, res) => {
  const live = await getPublicLive();
  // Edge-cache the board: the payload is already server-cached per TTL, so a
  // 30s shared-cache window only ever serves seconds-old data while
  // collapsing concurrent polls into one function invocation.
  res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=30');
  res.json({ ok: true, provider: providerName(), updatedAt: new Date().toISOString(), data: live });
});

/** GET /api/markets.php[?slug=][?limit=] */
router.get('/markets.php', async (req, res) => {
  const { slug, limit } = req.query ?? {};
  let markets = await getPublicMarkets();

  if (slug) {
    const one = markets.find((m) => m.slug === slug);
    if (!one) return res.status(404).json({ ok: false, error: `Unknown market slug: ${slug}` });
    return res.json({ ok: true, provider: providerName(), data: one });
  }

  if (limit) markets = markets.slice(0, Number(limit));

  res.json({ ok: true, provider: providerName(), count: markets.length, data: markets });
});

/** GET /api/starline.php[?slug=] */
router.get('/starline.php', (req, res) => {
  const sec = getSections();
  const rows = sec.starlineTables.mainStarline;
  res.json({
    ok: true,
    provider: providerName(),
    slug: req.query?.slug ?? '',
    count: rows.length,
    data: rows,
  });
});

/** GET /api/health - liveness + provider status. Never 500s: on Vercel this
 *  is the first URL to check - missing env vars are reported as JSON. */
router.get('/health', (req, res) => {
  const missing = missingEnv();
  res.json({
    ok: missing.length === 0,
    provider: providerName(),
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    today: today(),
    uptimeSec: Math.round(process.uptime()),
    ...(missing.length ? { missingEnv: missing } : {}),
  });
});

/** GET /api/chart.php?slug=kalyan-morning[&weeks=24] - chart history from MongoDB. */
router.get('/chart.php', async (req, res) => {
  const { slug, weeks } = req.query ?? {};
  if (typeof slug !== 'string' || !slug.trim()) {
    return res.status(400).json({ ok: false, error: 'slug is required' });
  }
  // Cap raised to ~10 years so imported history (as far back as 2020) is
  // fully reachable. ChartPage requests enough weeks to cover the data.
  const weeksN = Math.min(Math.max(Number(weeks) || 24, 1), 520);
  const history = await getChartHistory(slug.trim(), weeksN);
  // History only grows going forward, so a 60s edge window is safe and makes
  // repeat opens (and the page's own background retries) instant - the DB is
  // hit at most once a minute per market no matter how often charts open.
  res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');
  res.json({ ok: true, provider: providerName(), data: history });
});

export default router;
