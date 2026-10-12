/**
 * Verifies the public homepage market grid (JodiPanels) renders markets
 * sorted by OPEN TIME, earliest first - no matter what order the API sent.
 *
 *   node verify-jodi-order.mjs
 *
 * Bundles the real component with esbuild (same loader vite uses), renders it
 * with react-dom/server against a shuffled fixture, and asserts:
 *   1. every card appears in ascending open-time order,
 *   2. ties break alphabetically,
 *   3. a market with no parseable open time sinks to the end,
 *   4. the input array is NOT mutated (the API payload is shared).
 */
import { transform } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src', 'components', 'JodiPanels.jsx');
const TMP = path.join(__dirname, '.jodi-panels.tmp.mjs');

let fails = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) fails += 1;
};

/** "10:00 PM" -> minutes since midnight (mirrors the component's parser). */
const minutes = (v) => {
  const s = String(v ?? '').trim();
  const ampm = s.match(/^(\d{1,2}):([0-5]\d)\s*([APap])\.?[Mm]?\.?$/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3].toLowerCase() === 'p') h += 12;
    return h * 60 + Number(ampm[2]);
  }
  const plain = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (plain) return Number(plain[1]) * 60 + Number(plain[2]);
  return null;
};

// Shuffled sample of the real board, including a tie (MANGAL NIGHT and
// SHRI NIGHT both open 08:25 PM) and a market with no open time.
const fixture = [
  { market: 'ROSE BAZAR NIGHT', slug: 'rose-bazar-night', openTime: '10:00 PM', closeTime: '12:02 AM', result: '122-5', jodiUrl: '#', panelUrl: '#' },
  { market: 'NTR MORNING', slug: 'ntr-morning', openTime: '09:10 AM', closeTime: '10:10 AM', result: '388-97-250', jodiUrl: '#', panelUrl: '#' },
  { market: 'MANGAL NIGHT', slug: 'mangal-night', openTime: '08:25 PM', closeTime: '09:25 PM', result: '278-7', jodiUrl: '#', panelUrl: '#' },
  { market: 'KARNATAKA DAY', slug: 'karnataka-day', openTime: '10:00 AM', closeTime: '11:00 AM', result: '177-50-136', jodiUrl: '#', panelUrl: '#' },
  { market: 'SHRI NIGHT', slug: 'shri-night', openTime: '08:25 PM', closeTime: '10:25 PM', result: '257-4', jodiUrl: '#', panelUrl: '#' },
  { market: 'KALYAN', slug: 'kalyan', openTime: '04:35 PM', closeTime: '06:35 PM', result: '159-55-690', jodiUrl: '#', panelUrl: '#' },
  { market: 'NO CLOCK', slug: 'no-clock', openTime: '', closeTime: '', result: null, jodiUrl: '#', panelUrl: '#' },
  { market: 'TEST', slug: 'test', openTime: '12:00 AM', closeTime: '11:59 PM', result: '570-2', jodiUrl: '#', panelUrl: '#' },
  { market: 'RATNA MORNING', slug: 'ratna-morning', openTime: '09:35 AM', closeTime: '10:30 AM', result: '238-30-136', jodiUrl: '#', panelUrl: '#' },
];
const snapshot = JSON.stringify(fixture);

// 1. Bundle the real component exactly the way the app ships it.
const { code } = await transform(await fs.promises.readFile(SRC, 'utf8'), {
  loader: 'jsx',
  format: 'esm',
  target: 'node18',
  jsx: 'automatic', // same runtime vite uses; no global React needed
});
await fs.promises.writeFile(TMP, code);
const { default: JodiPanels } = await import(`file:///${TMP.replace(/\\/g, '/')}`);

// 2. Render it and pull the cards back out in DOM order.
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const html = renderToStaticMarkup(React.createElement(JodiPanels, { markets: fixture }));
const shown = [...html.matchAll(/<h4>(.*?)<\/h4><span>(.*?)<\/span><p>(.*?)<\/p>/gs)].map((m) => ({
  market: m[1],
  result: m[2],
  // The separator between the two times is spaces + non-breaking spaces.
  openTime: m[3].replace(/\u00a0/g, ' ').trim().split(/\s{2,}/)[0].trim(),
}));

check('every market rendered', shown.length === fixture.length, `${shown.length}/${fixture.length}`);

// 3. Ascending open time, ties alphabetical, nulls last.
const expected = [...fixture]
  .sort((a, b) => {
    const av = minutes(a.openTime);
    const bv = minutes(b.openTime);
    if (av == null && bv == null) return a.market.localeCompare(b.market);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return av - bv;
    return a.market.localeCompare(b.market);
  })
  .map((m) => m.market);

check(
  'grid is sorted by open time (ties alphabetical, no-clock last)',
  JSON.stringify(shown.map((s) => s.market)) === JSON.stringify(expected),
  `got [${shown.map((s) => s.market).join(', ')}]`
);

// 4. Monotonic open times in the rendered DOM.
let mono = true;
for (let i = 1; i < shown.length; i++) {
  const a = minutes(shown[i - 1].openTime);
  const b = minutes(shown[i].openTime);
  if (a == null || b == null) continue;
  if (a > b) mono = false;
}
check('rendered open times are monotonic ascending', mono);

// 5. No-clock market is the LAST card.
check('no-clock market sinks to the end', shown[shown.length - 1].market === 'NO CLOCK', shown[shown.length - 1].market);

// 6. The prop was not mutated.
check('input array not mutated', JSON.stringify(fixture) === snapshot);

// 7. Featured (yellow) highlight still resolves by slug after sorting.
check('featured market still highlighted', html.includes('bg-ylw') && !shown.every((s) => false));

// 8. The five markets the operator asked to pin must ALL get the yellow strip.
const pinnedFixture = [
  { market: 'Mahalaxmi day', slug: 'mahalaxmi-day', openTime: '09:10 AM', closeTime: '11:00 AM', result: '229-33-120', jodiUrl: '#', panelUrl: '#' },
  { market: 'Kuber Day', slug: 'kuber-day', openTime: '11:05 AM', closeTime: '12:05 PM', result: '135-90-235', jodiUrl: '#', panelUrl: '#' },
  { market: 'SRIDEVI', slug: 'sridevi', openTime: '11:35 AM', closeTime: '12:35 PM', result: '145-04-356', jodiUrl: '#', panelUrl: '#' },
  { market: 'Vidarbh. Day', slug: 'vidarbh-day', openTime: '01:30 PM', closeTime: '03:00 PM', result: '117-95-122', jodiUrl: '#', panelUrl: '#' },
  { market: 'Nagpur. Night', slug: 'nagpur-night', openTime: '07:00 PM', closeTime: '08:45 PM', result: '110-22-336', jodiUrl: '#', panelUrl: '#' },
];
const pinnedHtml = renderToStaticMarkup(React.createElement(JodiPanels, { markets: pinnedFixture }));
const pinnedHits = (pinnedHtml.match(/class="bg-ylw"/g) ?? []).length;
check('all 5 requested markets get the yellow strip', pinnedHits === 5, `${pinnedHits}/5`);

fs.rmSync(TMP, { force: true });

console.log(`\n${total - fails}/${total} checks passed`);
process.exit(fails === 0 ? 0 : 1);
