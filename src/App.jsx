import { useCallback, useState, useRef } from 'react';
import { api } from './api/client.js';
import { useApi, usePolling } from './hooks/useApi.js';

import Header from './components/Header.jsx';
import Hero from './components/Hero.jsx';
import LuckyNumber from './components/LuckyNumber.jsx';
import LiveResults from './components/LiveResults.jsx';
import JodiPanels from './components/JodiPanels.jsx';
import StarlineTable from './components/StarlineTable.jsx';
import Footer from './components/Footer.jsx';
import PremiumPopup from './components/PremiumPopup.jsx';
import WhatsAppBanner from './components/WhatsAppBanner.jsx';
import KeywordStrip from './components/KeywordStrip.jsx';
import SeoContent from './components/SeoContent.jsx';
import ApiPromo, { LinkZone } from './components/ApiPromo.jsx';
import PassList from './components/PassList.jsx';
import WeeklyCharts from './components/WeeklyCharts.jsx';
import FreeGameZone from './components/FreeGameZone.jsx';
import DayTables from './components/DayTables.jsx';

function Banner({ error, provider }) {
  if (!error && !provider) return null;
  return (
    <div className="kalyan-notice" style={{ margin: '6px 0' }}>
      <span className="notice-badge">{error ? 'API Error' : `Provider: ${provider}`}</span>{' '}
      <span className="notice-text">
        <small>
          {error
            ? error
            : `Serving ${provider} mode - results from Maharashtra webhook pushes and admin declares.`}
        </small>
      </span>
    </div>
  );
}

export default function App() {
  const { data, loading, error } = useApi(() => api.home(), []);
  const [tick, setTick] = useState(0);

  // Live cards poll independently so a slow endpoint never blocks first paint.
  const { data: liveData, error: liveError, lastUpdate, reload } = usePolling(
    () => api.liveResult(),
    15000,
    [tick]
  );

  const onRefresh = useCallback(() => {
    setTick((t) => t + 1);
    reload();
  }, [reload]);

  const home = data?.data ?? null;
  const live = liveData?.data ?? home?.liveResults ?? [];
  const provider = data?.provider ?? liveData?.provider ?? null;
  // The Jodi/Panel grid must NOT depend on /home.php alone: if home.markets
  // is empty but /live-result.php answered (or vice versa), derive panels
  // from whichever feed has rows. This was the "live result nahi hai to
  // second panel bhi nahi dikhta" bug - two independent feeds gated one UI.
  const homeMarkets = home?.markets ?? [];
  const panelMarkets =
    homeMarkets.length > 0
      ? homeMarkets
      : live
          .filter((r) => r?.slug || r?.market)
          .map((r) => ({
            market: r.market ?? r.slug ?? 'Market',
            slug: r.slug ?? String(r.market ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            result: r.result ?? null,
            openTime: r.openTime ?? '',
            closeTime: r.closeTime ?? '',
            jodiUrl: `/jodi-chart-record/${r.slug ?? ''}.php`,
            panelUrl: `/panel-chart-record/${r.slug ?? ''}.php`,
          }));

  // Keep the last good panelMarkets so the Jodi/Panel grid never flickers
  // between "Loading markets…" and full markets as home.php and live-result.php
  // load at different times (cold starts, Vercel retries, slow upstream).
  const panelMarketsRef = useRef(panelMarkets);
  if (panelMarkets.length > 0) {
    panelMarketsRef.current = panelMarkets;
  }
  const stablePanelMarkets = panelMarketsRef.current;

  // NEVER block first paint on the API: render the full page skeleton
  // immediately (good for SEO + perceived speed on Vercel cold starts).
  // Sections fill in as data arrives; "Loading..." only appears inside the
  // live-results block, never as a whole-page gate.
  const showSkeleton = loading && !home && !error;

  return (
    <>
      <Header />
      <Hero />

      <div role="main">
        <Banner error={error || liveError} provider={provider} />

        <LuckyNumber
          goldenAnk={home?.todayLuckyNumber?.goldenAnk ?? '0-5-2-7'}
          finalAnk={home?.todayLuckyNumber?.finalAnk ?? []}
        />

        <WhatsAppBanner />

        {showSkeleton ? (
          <div className="liv-rslt">
            <h4>☔LIVE RESULT☔</h4>
            <div className="lv-mc">
              <h5>Sabse Tezz Live Result Yahi Milega</h5>
              <p style={{ padding: '12px' }}>Loading live results…</p>
            </div>
          </div>
        ) : (
          <LiveResults results={live} onRefresh={onRefresh} updatedAt={lastUpdate} />
        )}

        <h4 className="flyr24"> WORLD ME SABSE FAST SATTA MATKA RESULT </h4>

        <JodiPanels markets={stablePanelMarkets} />

        <KeywordStrip />

        {/* --- Starline result tables --- */}
        <StarlineTable
          title="MAIN STARLINE"
          rows={home?.starlineTables?.mainStarline}
          className="mr-sl"
        />
        <StarlineTable
          title="Mumbai Rajshree Star Line Result"
          rows={home?.starlineTables?.mumbaiRajshree}
          className="mumraj-sl"
        />
        <StarlineTable
          title="MAIN BOMBAY 36 BAZAR Chart"
          rows={home?.starlineTables?.bombay36}
        />

        <ApiPromo />

        {/* --- Link zones --- */}
        {(home?.linkZones ?? []).map((z) => (
          <LinkZone key={z.title} title={z.title} links={z.links} />
        ))}

        <PassList items={home?.passList} date={home?.passListDate} />

        <WeeklyCharts charts={home?.weeklyCharts} />

        <FreeGameZone data={home?.freeGame} />

        <DayTables tables={home?.dayTables} />

        <SeoContent />

        <Footer />
      </div>

      <a id="rotatingText1" className="mp-clk1 open-premium-popup" href="#">
        <i>VIP Zone</i>
      </a>

      <a
        target="_blank"
        rel="noreferrer"
        className="mp-clk1"
        style={{
          position: 'fixed',
          bottom: '10px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1000,
        }}
        href="https://pub-ded7f16a3f0c4c098118d639178c8bbd.r2.dev/user-app-1771992441627.apk"
      >
        <i>Live Matka App</i>
      </a>

      <button type="button" onClick={onRefresh} className="clk1-rld btm-clk1-f">
        REFRESH
      </button>

      <PremiumPopup />
    </>
  );
}
