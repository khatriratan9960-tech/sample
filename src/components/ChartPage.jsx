import { useEffect, useState } from 'react';
import '../styles/chart.css';
import { useApi } from '../hooks/useApi.js';
import { api } from '../api/client.js';
import { chartCopy, hitDigits } from '../lib/fakeChart.js';
import { JODI_CHART_LINKS, PANEL_CHART_LINKS, chartUrl } from '../lib/chartLinks.js';

const DAYS = ['Mo', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function slugFromPath() {
  const p = window.location.pathname;
  // Supports:
  //   /jodi-chart-record/sridevi.php
  //   /panel-chart-record/sridevi.php
  //   /chart/jodi/sridevi   (clean SPA fallback)
  //   /chart/panel/sridevi
  let type = 'jodi';
  if (p.startsWith('/panel-chart-record') || p.includes('/panel')) type = 'panel';
  const last = p.split('/').filter(Boolean).pop() || '';
  const slug = last.replace(/\.php.*$/, '').replace(/^chart-/, '') || 'sridevi';
  return { slug, type };
}

/* ------------------------------------------------------------------ *
 * Chart cells
 * ------------------------------------------------------------------ */

/** Jodi cell: the two-digit result, red when one of its digits was drawn. */
function CellJodi({ day }) {
  if (day.missing) return <span className="chp-miss">{day.isFuture ? '' : '**'}</span>;
  const hot = hitDigits(day.open, day.close);
  const hit = day.jodi.split('').some((d) => hot.has(d));
  return <span className={`chp-jodi${hit ? ' hit' : ''}`}>{day.jodi}</span>;
}

/**
 * Panel cell, laid out like the original site:
 *
 *      5   3
 *      7 06 6
 *      9   6
 *
 * left column = open panna, middle = jodi, right column = close panna.
 * A digit that appears in BOTH panna is printed in red, and the jodi turns
 * red when it carries one of those shared digits.
 */
function CellPanel({ day }) {
  if (day.missing) {
    if (day.isFuture) return <span className="chp-miss" />;
    return (
      <span className="chp-miss">
        *
        <br />
        **
        <br />*
      </span>
    );
  }
  const hot = hitDigits(day.open, day.close);
  const jodiHit = day.jodi.split('').some((d) => hot.has(d));
  const dig = (panna, offset) =>
    panna.split('').map((d, i) => (
      <i key={`${offset}-${i}`} className={hot.has(d) ? 'hit' : undefined}>
        {d}
      </i>
    ));

  return (
    <span className="chp-cross">
      {dig(day.open, 'o')}
      <b className={jodiHit ? 'hit' : undefined}>{day.jodi}</b>
      {dig(day.close, 'c')}
    </span>
  );
}

/** Market name + latest "open-jodi-close" + refresh button. */
function ResultBox({ market, latest }) {
  return (
    <div className="tkt-val chp-result">
      <h4>{market}</h4>
      <span className="chp-line">
        {latest ? `${latest.open}-${latest.jodi}-${latest.close}` : '---'}
      </span>
      <p>
        <button
          type="button"
          className="gm-clk"
          style={{ position: 'static' }}
          onClick={() => window.location.reload()}
        >
          Refresh Result
        </button>
      </p>
    </div>
  );
}

function ChartTable({ data, type }) {
  const cols = type === 'panel' ? DAYS.length + 1 : DAYS.length;
  return (
    <div className="chp-table-wrap">
      <table className="chp-table">
        <thead>
          <tr>
            <th className="chp-cap" colSpan={cols}>
              {data.market.toUpperCase()} MATKA {type === 'panel' ? 'PANEL' : 'JODI'} RECORD 2018 - 2026
            </th>
          </tr>
          <tr>
            {type === 'panel' && <th>Date</th>}
            {DAYS.map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.weeks.map((w) => (
            <tr key={w.label}>
              {type === 'panel' && (
                <td className="chp-date">
                  {w.label.split(' to ')[0]}
                  <br />
                  to {w.label.split(' to ')[1]}
                </td>
              )}
              {w.days.map((day, i) => (
                <td key={i} className="chp-cell">
                  {type === 'panel' ? <CellPanel day={day} /> : <CellJodi day={day} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinkZone({ title, links, type, current }) {
  return (
    <div className="sta-div chp-links">
      <h6 className="chp-links-h">{title}</h6>
      {links.map((l) => (
        <a
          key={`${type}-${l.slug}-${l.label}`}
          href={chartUrl(type, l.slug)}
          className={l.slug === current ? 'cur' : undefined}
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}

export default function ChartPage() {
  const { slug, type } = slugFromPath();
  const [markets, setMarkets] = useState([]);
  // First paint asks for the recent window only (fast); history older than
  // that is empty anyway until months of sync-on-read accumulate. The full
  // range stays reachable via the weeks query param if ever needed.
  const { data, loading, error } = useApi(() => api.chart(slug, 52), [slug]);
  // ONLY ever show real stored history. The chart API always returns a weeks
  // array (empty days render **), so we never fabricate numbers. A market with
  // no stored draws simply shows an all-empty chart instead of fake data.
  const stored = data?.data;
  const chart = {
    market: stored?.market || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    weeks: stored?.weeks || [],
    latest: stored?.latest || null,
  };

  // Pull the full market list once so the "all markets" link zone is always
  // populated, no matter where the chart data comes from.
  useEffect(() => {
    let cancelled = false;
    api.markets().then((r) => {
      if (!cancelled) setMarkets(r?.data ?? []);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const upper = chart.market.toUpperCase();
  const copy = chartCopy(chart.market, type, slug);

  const goTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  const goBottom = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

  return (
    <>
      <div className="chp-title">
        {upper} {type === 'panel' ? 'PANEL' : 'JODI'} CHART
      </div>

      {loading && !data && (
        <div className="chp-loading" role="status" aria-live="polite">
          <p>
            Loading {type === 'panel' ? 'panel' : 'jodi'} history for{' '}
            {upper}…
          </p>
          <p>Fetching chart records from the database — please wait.</p>
        </div>
      )}

      {error && !data && !loading && (
        <div className="chp-error">
          <p>
            Could not load {type === 'panel' ? 'panel' : 'jodi'} history for{' '}
            {upper}.
          </p>
          <p>{error}</p>
          <button type="button" className="gm-clk" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      )}

      <div className="chp-desc">
        <h4>
          {upper} {type === 'panel' ? 'PANEL RESULT CHART RECORDS' : 'JODI RESULT CHART RECORDS'}
        </h4>
        <p>{copy.intro}</p>
      </div>

      <ResultBox market={upper} latest={chart.latest} />

      <div className="chp-nav">
        <button type="button" onClick={goBottom}>
          Go to Bottom
        </button>
        {type === 'panel' && <a href={chartUrl('jodi', slug)}>View Full Chart</a>}
      </div>

      <ChartTable data={chart} type={type} />

      <ResultBox market={upper} latest={chart.latest} />

      <div className="seo-content-box chp-seo">
        <p>{copy.intro}</p>

        <h2>{copy.getHeading}</h2>
        <p>{copy.getBody}</p>

        <h2>{copy.mathHeading}</h2>
        <p>{copy.mathBody}</p>

        <h2>{copy.orderHeading}</h2>
        <p>{copy.orderBody}</p>

        <h2>Frequently Asked Questions (FAQs):</h2>
        {copy.faqs.map(([q, a]) => (
          <div key={q}>
            <div className="chp-faq-h">{q}</div>
            <p>{a}</p>
          </div>
        ))}
      </div>

      <div className="chp-nav">
        <button type="button" onClick={goTop}>
          Go to Top
        </button>
      </div>

      <LinkZone title="SATTA MATKA JODI CHART" links={chartLinkList(markets, 'jodi')} type="jodi" current={slug} />
      {type === 'panel' && (
        <LinkZone title="MATKA PANEL CHART" links={chartLinkList(markets, 'panel')} type="panel" current={slug} />
      )}

      <div style={{ margin: '8px 0' }}>
        <a href="/" className="gm-clk" style={{ position: 'static', display: 'inline-block' }}>
          Back to Home
        </a>
      </div>
    </>
  );
}

/**
 * Build the link zones for a market's chart page: the original site's static
 * link list plus any market from the API that is not already listed there, so
 * every market reachable from /api/markets.php gets its own chart page.
 */
function chartLinkList(markets, type) {
  const staticLinks = type === 'panel' ? PANEL_CHART_LINKS : JODI_CHART_LINKS;
  const known = new Set(staticLinks.map((l) => l.slug));
  const extras = (markets ?? [])
    .filter((m) => m && typeof m.slug === 'string' && m.slug && !known.has(m.slug))
    .map((m) => ({ label: String(m.market ?? m.slug), slug: m.slug }));
  return [...staticLinks, ...extras];
}
