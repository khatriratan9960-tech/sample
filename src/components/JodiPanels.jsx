/**
 * The big grid of open-close-jodi panels.
 * Class names mirror the original markup exactly (tkt-val / bg-ylw /
 * vl-clk / vl-clk-2 / gm-clk) so the extracted CSS renders identically.
 *
 * The yellow strip (.bg-ylw) marks featured markets. It is applied to a fixed
 * set of markets (matched by slug, which is URL-safe and stable) instead of
 * just the first card, so the operator can pin specific markets:
 *   MILAN DAY, KALYAN, MAIN BAZAR, MILAN NIGHT, VIDARB DAY.
 * If none of the featured slugs are present, we fall back to highlighting the
 * first card so the board always has one highlight.
 *
 * The grid is sorted by OPEN TIME (earliest first) regardless of the order
 * the API returns, so every backend (Node, PHP mock, paid provider) renders
 * the same chronology. Markets whose open time is missing/unparseable sink
 * to the end instead of scrambling the list.
 */

/** Market slugs that get the yellow highlight. Edit this list to change them. */
const FEATURED_SLUGS = new Set([
  // Original pins.
  'milan-day',
  'kalyan',
  'main-bazar',
  'milan-night',
  'vidarb-day',
  // Requested yellow strips: Mahalaxmi day, Kuber Day, SRIDEVI,
  // Vidarbh. Day, Nagpur. Night (slugs verified against the live feed;
  // 'vidarb-day' is kept alongside 'vidarbh-day' in case the provider
  // renames the market back).
  'mahalaxmi-day',
  'kuber-day',
  'sridevi',
  'vidarbh-day',
  'nagpur-night',
]);

/** "10:00 PM" / "22:00" -> minutes since midnight; null when unparseable. */
function openMinutes(value) {
  const s = String(value ?? '').trim();
  const ampm = s.match(/^(\d{1,2}):([0-5]\d)\s*([APap])\.?[Mm]?\.?$/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3].toLowerCase() === 'p') h += 12;
    return h * 60 + Number(ampm[2]);
  }
  const plain = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (plain) return Number(plain[1]) * 60 + Number(plain[2]);
  return null;
}

/** Ascending by open time; ties break alphabetically so the order never flickers. */
function byOpenTime(a, b) {
  const av = openMinutes(a.openTime);
  const bv = openMinutes(b.openTime);
  if (av == null && bv == null) return String(a.market).localeCompare(String(b.market));
  if (av == null) return 1; // no parseable open time -> sink to the end
  if (bv == null) return -1;
  if (av !== bv) return av - bv;
  return String(a.market).localeCompare(String(b.market));
}

export default function JodiPanels({ markets = [] }) {
  // Don't vanish when the API is empty/slow: keep the section visible with a
  // placeholder so the page never looks like the "second panel" is missing.
  // (Before this, `return null` on empty hid the whole Jodi/Panel grid
  // whenever /home.php returned no markets, e.g. cold start + upstream hiccup.)
  if (!markets.length) {
    return (
      <div className="tkt-val" style={{ borderColor: '#aa00c0', marginBottom: '2px' }}>
        <div>
          <h4>WORLD ME SABSE FAST SATTA MATKA RESULT</h4>
          <span>Loading markets…</span>
          <p>Refreshing automatically — press REFRESH below if this persists.</p>
        </div>
      </div>
    );
  }

  // Copy before sorting - never mutate the prop (the API payload is shared).
  const sorted = [...markets].sort(byOpenTime);

  // Which indices are featured (by slug). Used for the no-match fallback below.
  const featuredIndexes = sorted
    .map((m, i) => (FEATURED_SLUGS.has(m.slug) ? i : -1))
    .filter((i) => i >= 0);

  return (
    <div className="tkt-val" style={{ borderColor: '#aa00c0', marginBottom: '2px' }}>
      {sorted.map((m, i) => {
        const featured = FEATURED_SLUGS.has(m.slug);
        // Fallback: if the operator's list matches nothing currently on the
        // board, keep the original behaviour (first card highlighted).
        const highlight = featured || (featuredIndexes.length === 0 && i === 0);
        return (
          <div key={m.slug || i} className={highlight ? 'bg-ylw' : ''}>
            <h4>{m.market}</h4>
            {/* Leading spaces in the original are intentional - preserve them. */}
            <span>{m.result ?? 'Loading...'}</span>
            <p>
              {m.openTime} &nbsp;&nbsp; {m.closeTime}
            </p>
            <a href={m.jodiUrl} className="vl-clk gm-clk">
              Jodi
            </a>
            <a href={m.panelUrl} className="vl-clk-2 gm-clk">
              Panel
            </a>
          </div>
        );
      })}
    </div>
  );
}
