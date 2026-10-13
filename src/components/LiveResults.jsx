/**
 * LIVE RESULT cards. Polls /api/live-result.php every 15s.
 *
 * The board is ordered and populated by the server from each market's real
 * open/close time, so whatever is drawing right now is at the top. A card
 * shows the open pana while its window is open, the full result once closed,
 * and "Loading..." until the open time arrives.
 *
 * Note: the original's Refresh button did window.location.reload().
 * Visually identical, but this updates in place with no page reload.
 */
export default function LiveResults({ results = [], onRefresh, updatedAt }) {
  // Same rule as JodiPanels: never render an empty shell that makes the
  // section look "missing". If the live feed is empty, show a placeholder
  // card so the reader sees the board is loading, not gone.
  if (!results.length) {
    return (
      <div className="liv-rslt">
        <h4>☔LIVE RESULT☔</h4>

        <div className="lv-mc">
          <h5>Sabse Tezz Live Result Yahi Milega</h5>

          <div className="lv-mc-list">
            <div>
              <span className="h8">Live results</span>
              <span className="h9">Loading...</span>
              <button type="button" onClick={onRefresh}>
                Refresh
              </button>
            </div>
          </div>
          <br />
        </div>

        {updatedAt && (
          <p style={{ fontSize: '11px', color: '#333', marginTop: '4px' }}>
            Updated {updatedAt.toLocaleTimeString()}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="liv-rslt">
      <h4>☔LIVE RESULT☔</h4>

      <div className="lv-mc">
        <h5>Sabse Tezz Live Result Yahi Milega</h5>

        <div className="lv-mc-list">
          {results.map((r) => (
            <div key={r.slug}>
              <span className="h8">
                {r.market}
                {/* A market inside its draw window is flagged, so a reader
                    can tell "drawing now" from "already published". */}
                {r.status === 'live' && <i className="lv-live-tag"> LIVE</i>}
                {/* Due to declare within minutes but not drawing yet - shown
                    early so the reader knows it is coming. */}
                {r.isImminent && <i className="lv-live-tag"> SOON</i>}
              </span>
              {/* Original prints "Loading..." when a market has not drawn. */}
              <span className="h9">
                {r.isPending || !r.result ? 'Loading...' : r.result}
              </span>
              <button type="button" onClick={onRefresh}>
                Refresh
              </button>
            </div>
          ))}
        </div>
        <br />
      </div>

      {updatedAt && (
        <p style={{ fontSize: '11px', color: '#333', marginTop: '4px' }}>
          Updated {updatedAt.toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
