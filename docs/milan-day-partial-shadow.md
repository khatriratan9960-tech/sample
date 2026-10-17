# MILAN DAY "579-1" investigation (2026-10-17, post-f18bc0a)

## Symptom (production)
Live board shows for MILAN DAY:

  MILAN DAY
  579-1
  03:25 PM    05:25 PM

Expected (per sattaapi API): `579-11-146`.

## Root cause (traced, NOT yet fixed in code)
1. The DB holds a MILAN DAY Market doc (leftover from earlier cron runs of
   `syncSattaApiResults`) with only an OPEN half stored (579/1, no close).
   `buildCustomLiveCards()` in `server/services/marketService.js` therefore
   builds a custom card with `buildDisplay(open, null)` = "579-1", status
   `live`.
2. The provider DOES carry today's full `579-11-146`, but it is shadowed:
   - Market list: `mergeMarkets()` in `server/services/mergeMarkets.js`
     drops any provider row whose slug matches a custom doc ("custom always
     wins"), so the stale partial hides the fresh full result.
   - Live board: `rankLiveCards()` tiers `live` ABOVE `closed`, so the stale
     partial sorts on top of today's full provider card.
3. Aggravating: `fetchProviderMarkets()` (sattaapi branch) drops the panna
   fields entirely (openTime/closeTime placeholders only), so the market
   list can never render provider results - only stored halves.

## Planned fix (3 parts, f18bc0a already has the board display fix)
- F1 `fetchProviderMarkets`: carry open/close/jodi/result/ank/date through
  on sattaapi rows (board-contract field order) so the list renders results.
- F2 `fetchProviderLive`: partial draws (open only, close pending) render
  "579-5" as live instead of a "579-00-" stub; pass the API's 12h display
  times through instead of to24h-converting them.
- F3 provider-wins rule: when the provider carries a fresh complete 3-part
  result for a pushDriven market, the stored halves for that slug are
  skipped in BOTH `mergeMarkets()` and `buildCustomLiveCards()`. Manual
  markets keep operator-wins. Custom halves are NEVER deleted.

## F3 status
APPLIED to the working tree (uncommitted):
- `server/services/mergeMarkets.js`: freshSlugs/providerFresh/providerSlug
- `server/services/marketService.js`: providerFreshSlugs/livePushMarkets
- `verify-timing.mjs`: 35/35 green with these in place.

## F1/F2 status
BLOCKED on tooling, not on analysis: every scripted edit to
`server/services/provider.js` (anchor replace or line splice) reports
success yet leaves a syntax error at the same line (stale `:160 }));`).
File restored to f18bc0a (clean, `node --check` passes). The exact
replacement texts that must go in are preserved in the session transcript
(search "[H3]"): markets-map block -> `.map((r) => {...})` carrying pannas;
live vars -> `complete`/`result` partial handling; live card -> 12h
passthrough + complete/live/pending status. Re-apply with the `editor`
tool on small unique anchors (or hand-edit lines ~131-140, ~166-168,
~185-193 of the f18bc0a file) and re-run `node --check` +
`node verify-timing.mjs` before committing.

## Safe production workaround (until F1-F3 ship)
Delete the stale MILAN DAY Market doc + its Result halves from Atlas (or
deactivate it). The provider card then renders today's full result with
nothing shadowing it. Manual markets are unaffected.
