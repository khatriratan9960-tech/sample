# Live Matka — React + PHP JSON API

A React (Vite) rebuild of **live.matka**, backed by an Express JSON API that
proxies the upstream result feed (the original PHP implementation is kept in
`php-api/`). The styling is the original site's stylesheet, extracted verbatim,
so the rendering matches pixel-for-pixel.

## Key finding about the original site

The `live.matka` homepage has **no client-side API at all** — no `fetch`,
no `XMLHttpRequest`, no `axios`. It is fully server-rendered PHP: every result
is baked into the HTML at request time, and every "Refresh" button is
`onclick="window.location.reload()"`. So this project *introduces* the API layer
the original never had.

## Architecture

```
Browser (React)  ──fetch('/api/*.php')──>  Express JSON API  ──>  Upstream provider
   localhost:5173  <──JSON──────────────    localhost:4000        mock | paid
                                          + MongoDB (Atlas)
```

Why the API layer exists:

- **Solves CORS permanently** — the browser only makes same-origin requests, so
  the upstream vendor does not need to send `Access-Control-Allow-Origin`.
- **Hides the API key** — credentials stay server-side and never reach the client.
- **Enables caching + failover** — you can serve last-known-good data if the
  upstream API is down.

Vite proxies `/api` → `http://localhost:4000` in dev (see `vite.config.js`).
The original PHP implementation of the same contract lives in `php-api/`;
only the Node API is deployed to Vercel (`api/index.js`).

## Running it

Three processes: MongoDB, the API server, and the frontend.

```bash
# 0. MongoDB must be running on :27017

# 1. API server (Express + MongoDB)
npm run api:dev      # http://localhost:4000

# 2. Frontend
npm run dev          # http://localhost:5173
```

| Page | URL |
|---|---|
| Public site | http://localhost:5173/ |
| **Admin panel** | **http://localhost:5173/admin** |
| API health | http://localhost:5173/api/health |

The first boot seeds an admin user from `.env` (`ADMIN_USERNAME` /
`ADMIN_PASSWORD`). Change that password before deploying anywhere public.

## Trial Matka API (matkaapi.com)

The live provider is the **trial API** (stateless, rate-limited, no history):

```bash
# .env
MATKA_DOMAIN_KEY=<your trial key>
MATKA_DOMAIN=clone-git-main-ratan18.vercel.app
```

- `market_list=1` (every market) + `market=all` (today's draws) are fetched
  together, cached ~45s (honours the upstream 10-second gap), and unioned so
  **every market the trial knows appears in the clone** - drawn or not.
- The trial API stores nothing, so each completed draw is upserted into the
  `ChartEntry` collection (`{slug, date}` unique) as soon as it appears -
  throttled to `CHART_SYNC_MS` (5 min) and idempotent.
- `GET /api/chart.php?slug=...&weeks=24` returns the stored history in the
  same shape `fakeChart()` produces; `ChartPage.jsx` prefers it and falls
  back to `fakeChart` while a market has no stored draws yet.
- `npm run verify:chart` renders every chart page against stored history and
  asserts the full chain: roster -> market list -> chart history -> chart pages.

## Admin panel

JWT-authenticated, backed by MongoDB.

- **Declare result** — pick a market, date and session, type open/close/jodi.
  A live preview shows the exact string that will publish. Saving makes it
  appear on the public site and the live board immediately.
- **Manage markets** — create a market with its open/close times, show/hide it,
  or delete it (which also deletes its declared results). Times are picked from
  a **12-hour dropdown** (HH:MM + AM/PM) rather than typed as 24-hour values.

## Roles

| Role | Can do |
|---|---|
| `super_admin` | Everything: create/deactivate/delete admins, change roles, see and edit **all** markets |
| `admin` | Create markets and declare results — **only for markets they own** |
| `editor` | Read-only |

The first account created at bootstrap is always a `super_admin`, so the
system can never be set up with nobody able to create other admins.

### Per-admin metrics

The **Admins & metrics** tab (super admin only) shows, for each admin:

- markets **active / total**, plus how many are hidden
- how many results they have declared
- last login
- current role and status

### Deactivating an admin cascades to their markets

Deactivating an admin **immediately hides every market they created**, so those
markets disappear from the public site. Re-activating restores them. Send
`{ cascade: false }` to lock the account but keep markets published.

Deleting an admin offers two choices: delete their markets too, or transfer
them to you (`?keepMarkets=true`).

### Safety rails

The last remaining **active super admin cannot be deactivated, demoted or
deleted** — otherwise the system could be left with nobody able to manage
admins. You also cannot deactivate, demote or delete your own account.

### Ownership is enforced server-side

A normal admin only sees and can only edit their own markets
(`scope: "own"` in `GET /api/admin/markets`). This is checked in the route
handlers, not just hidden in the UI. `adminUsers.js` applies `requireRole`
**per route** rather than router-wide — applying it to the whole router would
also block `/markets` and `/results` for normal admins.

### Your markets blend in, they don't look bolted on

`server/services/mergeMarkets.js` merges provider markets with yours and sorts
the combined list by **open time**, so a custom market lands in its natural
chronological position rather than being appended. Every market goes through
the same shape, so the public page can't tell them apart. Verified: a market
closing at 09:45 PM sits between MANGAL NIGHT (09:25) and MATKA KING NIGHT
(10:00), not at the bottom of the page.

Internal keys (`_sort`, `_marketId`) are stripped before the response, and
`source` is returned for admin/debugging only.

### Declaring a result - two halves, jodi is automatic

You never type a jodi. Each market-day is declared in two steps:

| Step | You enter | Public page shows |
|---|---|---|
| 1. Open | number + open panna, e.g. `7` and `257` | `257-7` (single number) |
| 2. Close | number + close panna, e.g. `9` and `369` | `257-369-79` (jodi = 7 + 9) |

The **jodi is computed server-side** as `open number + close number`. The
declare route never reads a `jodi` from the request body, so even a hand-crafted
request cannot set it (verified: sending `jodi: 999` is ignored).

Saving one half **recomputes both rows**, because declaring the close changes
what the open displays. Deleting one half reverts the other (removing the close
puts it back to `257-7`).

`number` is 1-2 digits, `pana` is exactly 3, and both are validated server-side.
The form shows which halves are already declared for the selected date and
jumps to the other half after you save.

### Results publish ON TIME, not when you declare them

You can declare a result whenever you like - hours early, the night before,
whatever. The **public site is gated by the market's clock**, never by when
you pressed save. A result declared at 09:00 for a market that opens at 09:15
stays invisible until 09:15.

For a market with `openTime` 09:15 and `closeTime` 21:15, declared at 09:00:

| Time | What the public site shows |
|---|---|
| 09:00 - 09:14 | nothing - `Loading...` (even though both halves are stored) |
| 09:15 - 21:14 | the open half only, e.g. `257-7` - the close panna is still hidden |
| 21:15 onwards | the full result, e.g. `257-72-369` |

This is enforced in `server/services/customReveal.js`, which every public read
of a custom market goes through (both the live board and the merged market
list). Declaring early is safe and useful - the admin panel always shows the
full truth - it simply cannot leak to the public site.

Two things it fixes at the same time:

- **Early declarations no longer leak.** Previously the stored `display` string
  was published as-is, so a result saved before its window appeared instantly
  (and even reported `status: 'closed'`).
- **Both halves now survive.** A market has two rows per draw (`open` +
  `close`) and the old lookups kept only one, so whichever sorted last won.
  Halves are now collected per market before the display is built.

Provider markets are untouched - their results come from the upstream API and
are gated by `liveBoard.js` on the same clock.

Run `node verify-timing.mjs` to see the whole schedule asserted (26 checks),
including midnight-wrapping markets such as 22:00 -> 00:30.

### LIVE RESULT lists markets due within 10 minutes

The live board is capped at 14 cards, so a market whose draw was minutes away
used to sit at the bottom of the "upcoming" pile and get cut entirely - a
reader only ever found out after the fact. A market is now **promoted onto the
board as soon as it is within 10 minutes of declaring**, tagged `SOON`, ranked
directly under whatever is drawing right now and above recently-closed results.

| Time to next open/close | On the board? |
|---|---|
| more than 10 min | only if there is room, at the bottom as `upcoming` |
| **10 min or less** | **always listed**, tagged `SOON`, ranked with the live tier |
| inside its window | listed as `LIVE` (unchanged) |

Details:

- Applies to **both** provider and custom markets - they compete for the same
  board slots on equal terms.
- **No result is ever leaked by this.** An imminent market still shows
  `Loading...`; only its *presence* is early, never its result. The publish
  schedule above is untouched.
- Measured forwards around the 24-hour circle, so a market opening at 00:15 is
  correctly imminent at 23:50.
- Tune the window with `LIVE_IMMINENT_MINUTES` (default `10`).
- The `SOON` tag reuses the existing `LIVE` badge styling in
  `src/components/LiveResults.jsx`, so it matches the original site's look.

### The full sequence on the public site

Every market - provider or custom - walks the same four stages, driven purely
by the clock. `verify-timing.mjs` asserts each one.

| Stage | LIVE RESULT shows | Badge |
|---|---|---|
| 10 min or less before the open | `Loading...` | `SOON` |
| at the open time | the open panna + its ank, e.g. `257-4` | `LIVE` |
| between open and close | the open panna + its ank | `LIVE` |
| at and after the close time | the full result, `openPana-jodi-closePana` e.g. `257-48-369` | - |

A close pana that was declared early is never shown before its close time -
only the open half appears while the window is open.

#### A naming trap in the provider data

The upstream feed calls its **two-digit** number `close` and its
**three-digit** panna `jodi` - the opposite of this project's own vocabulary,
where `jodi` is the two-digit join of the two halves. So for provider rows,
`close` holds the jodi and `jodi` holds the close panna.

Both paths still produce the **same** `open-jodi-close` output
(`257-48-369`), verified by a test that renders the same draw through both
paths and compares them. Do not "fix" the interpolation in
`liveBoard.js:revealFor()` by swapping those two variables - that would invert
the result. Fix the fixture field names instead.



### One row per half

`Result` is now one document per `(market, date, session)` where `session` is
`open` or `close` — so re-saving a half updates it instead of duplicating, and a
typo is fixed by saving the correction.


### MongoDB collections

| Collection | Purpose |
|---|---|
| `users` | Admin accounts, bcrypt hashes |
| `markets` | Your custom markets (name, slug, open/close time, active) |
| `results` | Declared results, unique per `(market, date, session)` |


## Project layout

```
api/
  index.js              Vercel serverless entry: restores the original /api/*
                        path from the ?__p= rewrite param, hands off to app
php-api/
  _bootstrap.php        response helpers, ank derivation, schema normalization
  config.php            API credentials (leave blank for mock)
  provider_paid.php     upstream adapter — fill in once you have credentials
  data/mock.php         market fixtures: 168 markets with real open/close
                        times, plus the starline rows. The live board is
                        derived from the clock, not stored.
  data/sections.json    Final Ank, starline tables, weekly charts, free game
                        zone, day tables, pass list, link zones
  home.php              single call for the whole homepage
  markets.php           ?slug= / ?limit=
  live-result.php       polled every 15s; rebuilt from the clock each poll
  starline.php          15-minute interval rows
server/
  app.js                the Express app shared by local dev and Vercel
  index.js              local dev starter (listen on :4000)
  services/marketClock.js  the schedule: parse times, and decide
                        upcoming / live / closed for any market. Shared by
                        mergeMarkets and liveBoard.
  services/liveBoard.js    builds the LIVE RESULT board from the clock
  services/mergeMarkets.js provider + custom markets interleaved by open time
src/
  api/client.js         all fetch calls live here
  hooks/useApi.js       useApi (once) + usePolling (interval)
  components/           Header, Hero, LuckyNumber, WhatsAppBanner,
                        LiveResults, JodiPanels, KeywordStrip, SeoContent,
                        StarlineTable, ApiPromo, PassList, WeeklyCharts,
                        FreeGameZone, DayTables, Footer, PremiumPopup,
                        ChartPage (jodi / panel chart pages)
  lib/fakeChart.js      deterministic chart history + matka maths
                        (ankOf / jodiOf / hitDigits) used by ChartPage
  lib/chartLinks.js     bottom "SATTA MATKA JODI CHART" / "MATKA PANEL CHART" links
  styles/live-matka.css original stylesheet, extracted verbatim (511 lines)
  styles/chart.css      chart-page-only styles (title bar, panel cross cell)
public/img/             live-matka-laxmi.jpg (extracted from the original)
public/                  favicon.ico + apple-touch-icon-57/60/72/76/114/120/180.png
verify.mjs              headless render assertions
verify-chart.mjs        renders a chart page and asserts every Jodi matches
                        its Open/Close Panna (node verify-chart.mjs panel sridevi)
normalize-mock.mjs      audits php-api/data/mock.php against the same rules
                        (npm run verify:mock)
verify-vercel.mjs       simulates Vercel's /api/* -> function rewrite
mock-server.mjs         Node stand-in for the PHP API
vercel.json             Vercel routing: /api/* -> function, SPA fallback
```

Market data lives in `php-api/data/mock.php`; the non-market page content
lives in `php-api/data/sections.json`. Both servers read those two files, so
the PHP API and the Node server always return identical payloads.

### The matka rules every draw must follow

Both the chart pages and the market fixtures are audited against these, so a
wrong number can never reach the screen:

1. **Panna order** - the three digits are always written increasing in the
   sequence `1,2,3,4,5,6,7,8,9,0`, where `0` counts as the largest digit and is
   therefore written last: `598` -> `589`, `901` -> `190`, `320` -> `230`.
2. **Ank** - add the three digits of a panna and keep the last digit:
   `1+3+5 = 9` -> 9, `4+7+9 = 20` -> 0, `5+5+7 = 17` -> 7. The Open Panna
   gives the Open Ank, the Close Panna gives the Close Ank.
3. **Jodi** - the two Anks written side by side, **not** their sum: the Open Ank
   is the first digit and the Close Ank is the second.
   `579` -> `1` and `366` -> `5` gives `579-15-366`.

Run `npm run verify:mock` (fixture) and `npm run verify:chart -- panel sridevi`
(chart pages) to re-check.

> Note on the fixture field names: `close` holds the **jodi** and `jodi` holds
> the **close panna** - that is the upstream provider's shape, documented in
> `server/services/liveBoard.js` - which is why the printed result string stays
> `open-jodi-close`.

### Important: Final Ank is NOT derived from the jodi

`Final Ank` is its own published dataset. It genuinely disagrees with the jodi
digit on the source site — `KALYAN MORNING` shows **4** there while its jodi
`369` would derive to **9**. It is read from `sections.json` as-is; never
recompute it from the result string in either the API or the components.

## Data schema

All providers are normalized to one contract, so components never change:

```jsonc
{
  "market": "KALYAN MORNING",
  "open": "257", "close": "48", "jodi": "369",
  "result": "257-48-369",
  "openTime": "11:40 AM", "closeTime": "12:40 PM",
  "ank": 9,               // derived: last digit of the jodi
  "status": "closed",     // closed | live | pending
  "slug": "kalyan-morning",
  "jodiUrl": "/jodi-chart-record/kalyan-morning.php",
  "panelUrl": "/panel-chart-record/kalyan-morning.php"
}
```

A market that has not drawn yet comes back with `result: null` and
`isPending: true`; the UI renders the original's `Loading...` placeholder.

## Deploying to Vercel

### The flow: from provider data to the public website

```text
Paid API (vendor)  or  bundled fixtures (php-api/data/)
        │
        ▼
Express API  /api/*.php          ◀──── Admin panel /admin (JWT)
(Vercel function: api/index.js)        declares results, manages markets
        │  merges
        ▼
MongoDB Atlas                       React SPA (Vercel CDN, dist/)
custom markets, declared results,        │ same-origin JSON (no CORS)
seeded admins                            ▼
                                 https://your-domain/
```

1. **Data first (provider → database).** In mock mode the fixtures in
   `php-api/data/` feed the API; once you buy the paid result API, set
   `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` and the same code path serves live
   results. Declared results and custom markets live in MongoDB - that is the
   site's persistent state, so the database must exist before anything else.
2. **API next.** One Vercel Function (`api/index.js`) runs the Express app;
   `vercel.json` rewrites every `/api/*` URL to it (original path preserved
   via `?__p=`).
3. **Website last.** Vite builds the SPA to `dist/`, served from Vercel's CDN;
   every non-file URL falls back to `index.html` (chart pages, `/admin`).

### First-time deploy order

| # | Step | Where |
|---|---|---|
| 1 | Create a free M0 cluster, a DB user, network access (`0.0.0.0/0`), copy the connection string | cloud.mongodb.com |
| 2 | Push the repo to GitHub | done (`origin`) |
| 3 | Import the repo into Vercel - framework auto-detects **Vite**, `api/index.js` is picked up as a function | vercel.com/new |
| 4 | Set the env vars below **before** deploying | Project → Settings → Environment Variables |
| 5 | Deploy, then verify in order: `/api/health` shows `"db":"connected"`, `/api/home.php` returns `ok:true`, `/` renders the live board, `/admin` accepts the login | deployment URL |
| 6 | Log in at `/admin` and **change the seeded password immediately** | `/admin` |
| 7 | Attach your custom domain | Settings → Domains |

| Env var | Value |
|---|---|
| `MONGO_URL` | Atlas connection string (`mongodb+srv://...`) |
| `DB_NAME` | `dpboss` |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | bootstrap admin (only used while the users collection is empty) |
| `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` | leave empty until you buy the paid API |
| `MONGO_MAX_POOL` | optional, defaults to `10` |

`NODE_ENV=production` is set by Vercel, so the API refuses to boot without
`JWT_SECRET` on purpose.

### What runs where

| Piece | Runtime |
|---|---|
| React SPA (`dist/`) | Vercel static CDN; SPA rewrite serves `index.html` for every non-file URL |
| Express API | one serverless function `api/index.js` (path restored from `?__p=`) |
| Legacy PHP API | **not deployed** - `php-api/` kept for reference / standalone hosting |
| Fixture data | bundled with the function (`functions.includeFiles` in `vercel.json`) |
| MongoDB | Atlas - `localhost` is unreachable from Vercel |

### Serverless behaviour

- DB connect + seed admin run lazily on the first request of each cold start
  (`ensureReady()` in `server/app.js`), never at import time.
- There are no background timers anywhere - every response fetches what it
  needs per request, so warm functions can never serve frozen data.
- Local dev is unchanged: `npm run api:dev` (:4000) + `npm run dev` (:5173,
  which proxies `/api`).

## Switching to the paid result API

1. Get credentials + docs from your API vendor.
2. Set the env vars (local `.env`, or Vercel → Settings → Environment
   Variables):
   ```bash
   PROVIDER_BASE_URL=https://vendor-host/v1
   PROVIDER_API_KEY=your-key
   ```
3. Map the vendor's field names in `server/services/provider.js`
   (`fetchProviderMarkets()` and `fetchProviderLive()`).

**No React file changes are needed.** Normalization happens in
`server/services/` (`provider.js` + `mergeMarkets.js`). The legacy PHP
adapter (`php-api/provider_paid.php` + `php-api/config.php`) is only used
when hosting the PHP API standalone.

### Confirm these with the vendor before paying

- [ ] CORS headers present (moot with the proxy, but good to know)
- [ ] Auth style: `X-API-Key` header vs `?api_key=` query
- [ ] Rate limit — live polling is 240 requests/hour
- [ ] How an undrawn market is signalled: `null`, absent, or `"0"`
- [ ] Field names for open / close / jodi / times / ank
- [ ] Historical depth: 100 days jodi + panel, 240 starline rows per market
- [ ] Update latency after a real draw
- [ ] Commercial rights for an ad-supported public site

## Known differences from the original

- **Refresh does not reload the page.** The original used
  `window.location.reload()`; this polls `/api/live-result.php` every 15s and
  updates in place. Visually identical, functionally smoother.
- **No Cloudflare bot-check.** The original injects a
  `/cdn-cgi/challenge-platform/` script and a hidden iframe; both are stripped.
- **Market open/close times come from the fixtures.** All 168 markets carry
  `openTime` / `closeTime` extracted from the saved homepage. When you switch to
  the paid API, map the vendor's timing fields onto the same two keys.

## Fixed from the original source

- Added proper `<!DOCTYPE html>` and `<meta charset="utf-8">` (was `http-equiv`,
  which caused mojibake: `ðŸ’Ž`, `Ã—`, `àª¡à«€àª¬à«‹àª¸`).
- Removed invalid meta tags (`name="google"`, `name="Robots"`, `name="copyright"`).
- De-duplicated the repeated Open Graph tags.
- Moved `width`/`cellspacing`/`cellpadding` off `<table>` into CSS.
- Extracted the 512-line inline `<style>` block into `src/styles/live-matka.css`.
- Extracted the `<br>`-based footer layout into proper markup.
