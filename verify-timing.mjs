/**
 * Proves that a CUSTOM market's declared result is published ON TIME, not
 * when the operator happens to save it.
 *
 * The scenario: a market opening 09:15 / closing 21:15, where the admin
 * declares BOTH halves at 09:00 - 15 minutes early. The public site must
 * show nothing at 09:00, the open half alone from 09:15, and the full
 * result from 21:15.
 *
 *   node verify-timing.mjs
 */
import { revealCustom } from './server/services/customReveal.js';
import { mergeMarkets } from './server/services/mergeMarkets.js';
import { buildLiveBoard, toLiveCard } from './server/services/liveBoard.js';

const results = [];
function check(name, cond, extra = '') {
  results.push([name, Boolean(cond)]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}

const hm = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

// A market open 09:15, close 21:15.
const market = { openTime: '09:15', closeTime: '21:15' };
const OPEN_MIN = hm('09:15');
const CLOSE_MIN = hm('21:15');

// Declared at 09:00: the open half 1/257 and the close half 8/369.
const openRow = { session: 'open', number: '7', pana: '257', ank: 7 };
const closeRow = { session: 'close', number: '2', pana: '369', ank: 9 };

// --- 1. Before the open: nothing at all, even though both halves exist. ---
const before = revealCustom(market, openRow, closeRow, hm('09:00'));
check(
  '09:00 (declared) -> nothing published',
  before.status === 'upcoming' && before.result === null && before.isPending,
  `status=${before.status} result=${before.result}`
);

// --- 2. At the open: only the open half. ---
const during = revealCustom(market, openRow, closeRow, OPEN_MIN + 1);
check(
  '09:16 -> open half only',
  during.status === 'live' && during.result === '257-7' && during.jodi === null,
  `status=${during.status} result=${during.result}`
);

// The close pana must NOT leak while the window is still open.
check(
  '09:16 -> close pana hidden',
  during.result !== null && !during.result.includes('369'),
  `result=${during.result}`
);

// --- 3. Exactly at the open minute, the open half appears. ---
const atOpen = revealCustom(market, openRow, closeRow, OPEN_MIN);
check(
  '09:15 exactly -> open half appears',
  atOpen.status === 'live' && atOpen.result === '257-7',
  `result=${atOpen.result}`
);

// --- 4. Before the close: still only the open half. ---
const beforeClose = revealCustom(market, openRow, closeRow, CLOSE_MIN - 1);
check(
  '21:14 -> still open half only',
  beforeClose.status === 'live' && beforeClose.result === '257-7',
  `result=${beforeClose.result}`
);

// --- 5. At/after the close: the full result with the jodi. ---
const after = revealCustom(market, openRow, closeRow, CLOSE_MIN);
check(
  '21:15 -> full result published',
  after.status === 'closed' && after.result === '257-72-369',
  `result=${after.result}`
);

// --- 6. Declared open half alone, after close -> no invented jodi. ---
const openOnly = revealCustom(market, openRow, null, CLOSE_MIN + 10);
check(
  'closed but close not declared -> no jodi',
  openOnly.result === '257-7' && openOnly.jodi === null,
  `result=${openOnly.result}`
);

// --- 7. Declared close half alone while live -> stays hidden. ---
const closeOnlyLive = revealCustom(market, null, closeRow, OPEN_MIN + 5);
check(
  'close declared but window open -> hidden',
  closeOnlyLive.result === null,
  `result=${closeOnlyLive.result}`
);

// --- 8. The merged public market list honours the same clock. ---
const halves = new Map([['m1', { open: openRow, close: closeRow }]]);
const customMarket = {
  _id: 'm1',
  name: 'MY MARKET',
  slug: 'my-market',
  openTime: '09:15',
  closeTime: '21:15',
};

const listEarly = mergeMarkets([], [customMarket], halves, hm('09:00'));
check(
  'merged list hides early result',
  listEarly[0].result === null && listEarly[0].status === 'upcoming',
  `result=${listEarly[0].result} status=${listEarly[0].status}`
);

const listLive = mergeMarkets([], [customMarket], halves, hm('10:00'));
check(
  'merged list shows open half while live',
  listLive[0].result === '257-7' && listLive[0].status === 'live',
  `result=${listLive[0].result}`
);

const listClosed = mergeMarkets([], [customMarket], halves, hm('22:00'));
check(
  'merged list shows full result after close',
  listClosed[0].result === '257-72-369' && listClosed[0].status === 'closed',
  `result=${listClosed[0].result}`
);

// --- 9. Provider markets are untouched by this gate. ---
const providerMarket = {
  market: 'KALYAN MORNING',
  open: '257',
  close: '369',
  jodi: '79',
  openTime: '11:40 AM',
  closeTime: '12:40 PM',
};
const providerList = mergeMarkets([providerMarket], [], new Map(), hm('06:00'));
check(
  'provider market keeps its own clock rules',
  providerList.length === 1 && typeof providerList[0].status === 'string',
  `status=${providerList[0].status}`
);

// --- 11. Push/webhook markets show the result directly, ignoring the clock. ---
const webhookMarket = {
  _id: 'mw',
  name: 'WEBHOOK MARKET',
  slug: 'webhook-market',
  openTime: '09:15',
  closeTime: '21:15',
  pushDriven: true,
};
const webhookHalves = new Map([
  [
    'mw',
    {
      open: { session: 'open', number: '7', pana: '257', ank: 7 },
      close: { session: 'close', number: '2', pana: '369', ank: 9 },
    },
  ],
]);
const webhookEarly = mergeMarkets([], [webhookMarket], webhookHalves, hm('09:00'));
check(
  'webhook market shows full result before open (result-driven)',
  webhookEarly[0].result === '257-72-369',
  `result=${webhookEarly[0].result} status=${webhookEarly[0].status}`
);
const webhookLive = mergeMarkets([], [webhookMarket], webhookHalves, hm('10:00'));
check(
  'webhook market stays result-driven while live',
  webhookLive[0].result === '257-72-369' && webhookLive[0].status === 'closed',
  `result=${webhookLive[0].result} status=${webhookLive[0].status}`
);

// --- 10. A market whose times cannot be parsed stays silent. ---
const broken = revealCustom({ openTime: '', closeTime: '' }, openRow, closeRow, hm('10:00'));
check('unparseable times -> nothing published', broken.result === null, `status=${broken.status}`);

// --- 11. Midnight-wrapping market (22:00 -> 00:30). ---
// The clock (marketClock.js) treats the window as running to midnight, so the
// draw is still "live" at 23:00 and "closed" just after midnight. Once the
// window has fully passed it correctly returns to "upcoming" for tonight.
const night = { openTime: '22:00', closeTime: '00:30' };
const nightLive = revealCustom(night, openRow, closeRow, hm('23:00'));
const nightClosed = revealCustom(night, openRow, closeRow, hm('00:05'));
const nightLater = revealCustom(night, openRow, closeRow, hm('01:00'));
check(
  'night market: open half at 23:00, full just after midnight',
  nightLive.status === 'live' &&
    nightLive.result === '257-7' &&
    nightClosed.status === 'closed' &&
    nightClosed.result === '257-72-369',
  `23:00=${nightLive.result} 00:05=${nightClosed.result}`
);
check(
  'night market: hidden again once tonight has not opened',
  nightLater.status === 'upcoming' && nightLater.result === null,
  `01:00 status=${nightLater.status} result=${nightLater.result}`
);

// --- 17. The full public sequence, end to end, for a PROVIDER market.
// 10 min before -> Loading... ; at open -> open panna ; at close -> full.
{
  // Upstream naming: "close" is the 2-digit jodi, "jodi" is the 3-digit panna.
  const m = { market: 'SEQ', open: '257', close: '48', jodi: '369', openTime: '09:15 AM', closeTime: '09:45 AM' };
  const at = (mins) => toLiveCard(m, mins);

  const before = at(hm('09:05'));
  check(
    'provider 10 min before open -> Loading...',
    before.status === 'upcoming' && before.isImminent === true && before.result === null,
    `status=${before.status} imminent=${before.isImminent}`
  );

  const opened = at(hm('09:15'));
  check(
    'provider at open -> open panna + ank',
    opened.status === 'live' && opened.result === '257-4',
    `result=${opened.result}`
  );

  const closed = at(hm('09:45'));
  check(
    'provider at close -> open-jodi-close',
    closed.status === 'closed' && closed.result === '257-48-369',
    `result=${closed.result}`
  );
}

// --- 18. Both paths must use the SAME "open-jodi-close" ordering.
{
  const custom = mergeMarkets(
    [],
    [{ _id: 'c1', name: 'CUSTOM', slug: 'custom', openTime: '09:15', closeTime: '09:45' }],
    new Map([['c1', { open: { number: '4', pana: '257' }, close: { number: '8', pana: '369' } }]]),
    hm('09:45')
  )[0];

  // Same draw, expressed in upstream field naming.
  const provider = toLiveCard(
    { market: 'PROVIDER', open: '257', close: '48', jodi: '369', openTime: '09:15 AM', closeTime: '09:45 AM' },
    hm('09:45')
  );

  check(
    'custom and provider agree on ordering',
    custom.result === provider.result,
    `custom=${custom.result} provider=${provider.result}`
  );
}

// --- 12. IMMINENT: a market due within 10 min is listed on the board. ---
// Market opens 21:15. At 21:10 only 5 minutes remain, so it must already
// appear on the live board instead of being buried under every other
// upcoming market.
{
  const soon = { market: 'SOON MARKET', open: '111', close: '222', jodi: '33', openTime: '09:15 PM', closeTime: '09:45 PM' };
  const later = { market: 'LATER MARKET', open: '111', close: '222', jodi: '33', openTime: '11:00 PM', closeTime: '11:30 PM' };

  const now5 = hm('21:10');
  const board = buildLiveBoard([soon, later], { now: now5 });

  check(
    '21:10 -> market opening at 21:15 is imminent',
    board[0]?.market === 'SOON MARKET' && board[0]?.isImminent === true,
    `first=${board[0]?.market} imminent=${board[0]?.isImminent}`
  );
  check(
    '21:10 -> market opening at 23:00 is not imminent',
    board.find((c) => c.market === 'LATER MARKET')?.isImminent === false
  );
  check(
    'imminent market is still pending (no result leaked early)',
    board[0]?.result === null && board[0]?.status === 'upcoming',
    `status=${board[0]?.status} result=${board[0]?.result}`
  );
}

// --- 13. The boundary: exactly 10 minutes counts, 11 does not. ---
{
  const m = { market: 'EDGE', open: '111', close: '222', jodi: '33', openTime: '09:15 PM', closeTime: '09:45 PM' };
  const at10 = buildLiveBoard([m], { now: hm('21:05') })[0];
  const at11 = buildLiveBoard([m], { now: hm('21:04') })[0];
  check(
    'exactly 10 min -> imminent, 11 min -> not',
    at10.isImminent === true && at11.isImminent === false,
    `10min=${at10.isImminent} 11min=${at11.isImminent}`
  );
}

// --- 14. An imminent market outranks a closed one, so it is never cut. ---
{
  const soon = { market: 'SOON', open: '111', close: '222', jodi: '33', openTime: '09:15 PM', closeTime: '09:45 PM' };
  // Several recently-closed markets that would otherwise fill the top slots.
  const closedMarkets = [
    { market: 'C1', open: '1', close: '2', jodi: '3', openTime: '06:00 PM', closeTime: '06:30 PM' },
    { market: 'C2', open: '1', close: '2', jodi: '3', openTime: '06:30 PM', closeTime: '07:00 PM' },
    { market: 'C3', open: '1', close: '2', jodi: '3', openTime: '07:00 PM', closeTime: '07:30 PM' },
  ];
  const board = buildLiveBoard([...closedMarkets, soon], { now: hm('21:10') });
  check(
    'imminent market ranks above recently-closed markets',
    board[0]?.market === 'SOON',
    `order=${board.map((c) => c.market).join(',')}`
  );
}

// --- 15. A market already drawing is live, never "imminent". ---
{
  const m = { market: 'DRAWING', open: '257', close: '369', jodi: '79', openTime: '09:15 PM', closeTime: '09:45 PM' };
  const card = buildLiveBoard([m], { now: hm('21:30') })[0];
  check(
    'drawing market is live, not imminent',
    card.status === 'live' && card.isImminent === false,
    `status=${card.status} imminent=${card.isImminent}`
  );
}

// --- 16. Midnight wrap: imminent works just before midnight. ---
{
  const night = { market: 'NIGHT', open: '111', close: '222', jodi: '33', openTime: '11:50 PM', closeTime: '12:30 AM' };
  const card = buildLiveBoard([night], { now: hm('23:45') })[0];
  check(
    '23:45 -> market opening 23:50 is imminent',
    card.isImminent === true && card.result === null,
    `imminent=${card.isImminent} result=${card.result}`
  );
}


// --- 17. Reference schedule: provider/webhook markets show the original
// site's times; manual custom markets keep their own. ---
const schedMod = await import('./server/services/marketSchedule.js');
const { lookupSchedule: schedLookup } = schedMod;
check(
  'KALYAN MORNING -> 11:40 AM / 12:40 PM',
  schedLookup('KALYAN MORNING')?.open === '11:40 AM' && schedLookup('KALYAN MORNING')?.close === '12:40 PM',
  JSON.stringify(schedLookup('KALYAN MORNING'))
);
check(
  'MAIN BAZAR -> 10:00 PM / 12:10 AM (midnight wrap)',
  schedLookup('MAIN BAZAR')?.open === '10:00 PM' && schedLookup('MAIN BAZAR')?.close === '12:10 AM',
  JSON.stringify(schedLookup('MAIN BAZAR'))
);
check(
  'case-insensitive: kalyan night',
  schedLookup('kalyan night')?.open === '09:45 PM' && schedLookup('kalyan night')?.close === '11:45 PM',
  JSON.stringify(schedLookup('kalyan night'))
);
check(
  'PUNA NIGHT [ main ] bracket form resolves',
  schedLookup('PUNA NIGHT [ main ]')?.open === '11:00 PM',
  JSON.stringify(schedLookup('PUNA NIGHT [ main ]'))
);
check(
  'unknown market -> null (manual markets untouched)',
  schedLookup('SOME NEW CUSTOM') === null
);
// (provider card checks run in the block below)
{
  const { mergeMarkets: mm } = await import('./server/services/mergeMarkets.js');
  const rows = mm([{ market: 'KALYAN MORNING', open: '489', close: '16', jodi: '457' }], [], { now: 12 * 60 });
  check(
    'provider KALYAN MORNING card shows 11:40 AM / 12:40 PM',
    rows[0]?.openTime === '11:40 AM' && rows[0]?.closeTime === '12:40 PM',
    `${rows[0]?.openTime} / ${rows[0]?.closeTime}`
  );
  const rows2 = mm([{ market: 'SOME NEW CUSTOM', open: '111', close: '22', jodi: '333' }], [], { now: 12 * 60 });
  check(
    'unlisted market keeps blank times (no invented window)',
    rows2[0]?.openTime === '' && rows2[0]?.closeTime === '',
    `${rows2[0]?.openTime} / ${rows2[0]?.closeTime}`
  );
}

// --- 19. Real sattaapi payload -> FINAL board format (regression guard) ---
// The raw API's field names are swapped vs our vocabulary:
//   raw.open  = 3-digit open panna
//   raw.close = 2-digit JODI         (NOT the close panna)
//   raw.jodi  = 3-digit close panna  (NOT the jodi)
// and partial rows can carry junk in raw.close (e.g. Milan Night "07" while
// close is still pending). mapRow renames them ONCE at the API boundary into
// the final board format the whole codebase speaks ({close: 2-digit jodi,
// jodi: 3-digit close panna, result: 'open_pana-jodi-close_panna'}) - the
// global cache stores exactly that format (_fmt 'board-v1').
// sattaApiToMarkets/sattaApiToLive read it as-is, and ensureBoardRows() heals
// rows cached by older deploys. Never a padded "00" half, never a leaked raw
// jodi-half.
{
  const { sattaApiToMarkets, sattaApiToLive } = await import('./server/services/provider.js');
  const { mapRow, ensureBoardRows, BOARD_FMT } = await import('./server/services/sattaApi.js');

  const RAW = [
    { name: 'KALYAN', open: '250', close: '77', jodi: '359', open_time: '04:35 PM', close_time: '06:35 PM' },
    { name: 'MILAN NIGHT', open: '269', close: '07', jodi: '', open_time: '09:10 PM', close_time: '11:10 PM' },
    { name: 'NIGHT TIME BAZAR', open: '389', close: '', jodi: '', open_time: '08:57 PM', close_time: '10:57 PM' },
  ];
  const rows = RAW.map((r) => mapRow(r, '2026-10-17'));

  check(
    'mapRow FINAL board format: close=2-digit jodi, jodi=3-digit panna, result open-jodi-panna',
    rows[0].close === '77' && rows[0].jodi === '359' &&
      rows[0].result === '250-77-359' && rows[0].ank === 7 &&
      rows[0]._fmt === BOARD_FMT,
    `close=${rows[0].close} jodi=${rows[0].jodi} result=${rows[0].result} ank=${rows[0].ank}`
  );
  check(
    'mapRow partial: junk jodi half can never leak (Milan -> 269-7, not 07)',
    rows[1].close === '07' && rows[1].jodi === '' && rows[1].result === '269-7',
    `close=${rows[1].close} jodi=${rows[1].jodi} result=${rows[1].result}`
  );
  check(
    'mapRow empty close -> open-ank only (389-0), no padded 00',
    rows[2].result === '389-0' && rows[2].close === '' && rows[2].jodi === '',
    `result=${rows[2].result}`
  );

  // Legacy cache rows written by older deploys (inverse contract) must be
  // healed into the same final format on every global-cache read.
  const legacy = ensureBoardRows([
    { name: 'KALYAN', open: '250', close: '359', jodi: '77' },
    { name: 'MILAN NIGHT', open: '269', close: '', jodi: '07' },
  ]);
  check(
    'global cache: legacy inverse row converts to open-jodi-closePana',
    legacy[0].close === '77' && legacy[0].jodi === '359' &&
      legacy[0].result === '250-77-359' && legacy[0]._fmt === BOARD_FMT,
    `close=${legacy[0].close} jodi=${legacy[0].jodi} result=${legacy[0].result}`
  );
  check(
    'global cache: legacy junk jodi still gated (Milan -> 269-7)',
    legacy[1].jodi === '' && legacy[1].result === '269-7',
    `jodi=${legacy[1].jodi} result=${legacy[1].result}`
  );

  const mkts = sattaApiToMarkets(rows);
  const k = mkts.find((m) => m.market === 'KALYAN');
  check(
    'markets mapper: full row = open-jodi-close with digit-sum ank',
    k?.result === '250-77-359' && k?.close === '77' && k?.jodi === '359' && k?.ank === 7,
    `${k?.result} ank=${k?.ank}`
  );
  const mil = mkts.find((m) => m.market === 'MILAN NIGHT');
  check(
    'markets mapper: partial row carries no fake halves',
    mil?.close === null && mil?.jodi === null && mil?.result === null,
    JSON.stringify({ close: mil?.close, jodi: mil?.jodi, result: mil?.result })
  );

  const list = mergeMarkets(mkts, [], new Map(), 21 * 60 + 54);
  const shown = Object.fromEntries(list.map((m) => [m.market, m.result]));
  check('list renders KALYAN 250-77-359', shown['KALYAN'] === '250-77-359', shown['KALYAN']);
  check(
    'list renders MILAN NIGHT 269-7 (open half, digit-sum ank)',
    shown['MILAN NIGHT'] === '269-7' && list.find((m) => m.market === 'MILAN NIGHT')?.ank === 7,
    `${shown['MILAN NIGHT']} ank=${list.find((m) => m.market === 'MILAN NIGHT')?.ank}`
  );
  check('list renders NIGHT TIME BAZAR 389-0', shown['NIGHT TIME BAZAR'] === '389-0', shown['NIGHT TIME BAZAR']);
  check(
    'list KALYAN headline ank = 7 (digit-sum of 359, not 9)',
    list.find((m) => m.market === 'KALYAN')?.ank === 7,
    `ank=${list.find((m) => m.market === 'KALYAN')?.ank}`
  );

  const live = sattaApiToLive(rows);
  const card = (name) => live.find((m) => m.market === name);
  check(
    'live KALYAN 250-77-359 closed',
    card('KALYAN')?.result === '250-77-359' && card('KALYAN')?.status === 'closed',
    `${card('KALYAN')?.result} ${card('KALYAN')?.status}`
  );
  check(
    'live MILAN NIGHT 269-7',
    card('MILAN NIGHT')?.result === '269-7' && card('MILAN NIGHT')?.status === 'live',
    `${card('MILAN NIGHT')?.result} ${card('MILAN NIGHT')?.status}`
  );
  check(
    'live NIGHT TIME BAZAR 389-0',
    card('NIGHT TIME BAZAR')?.result === '389-0' && card('NIGHT TIME BAZAR')?.status === 'live',
    `${card('NIGHT TIME BAZAR')?.result} ${card('NIGHT TIME BAZAR')?.status}`
  );
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);