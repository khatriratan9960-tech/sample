import { useEffect, useMemo, useState } from 'react';
import { useApiClient } from './AuthContext.jsx';

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Keep digits only; panna is exactly 3, the number is 1-2. */
const onlyDigits = (v) => v.replace(/\D/g, '');
const fmtTime = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * Declare a result in two steps: the open half (number + panna), then the
 * close half. The jodi is never typed - it appears automatically once both
 * halves are saved.
 */
export default function ResultDeclarer({ markets, onChanged, currentUserId, isSuper }) {
  const api = useApiClient();
  // Same ownership guard as MarketManager: the API also returns the
  // operator's unowned webhook markets so results can be declared on them.
  // Prefer the admin's own markets in the dropdown, but never render an
  // empty dropdown when ownership cannot be matched (stale login without a
  // user id, partial payload) - fall back to all active markets instead so
  // the form stays usable. The server still enforces declare rights.
  const owned = useMemo(() => {
    if (isSuper || !currentUserId) return null;
    const mine = markets.filter((m) => m.owner && m.owner === currentUserId);
    return mine.length > 0 ? mine : null;
  }, [markets, isSuper, currentUserId]);
  const active = useMemo(
    () => (owned ?? markets).filter((m) => m.active),
    [owned, markets]
  );

  const [marketId, setMarketId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [session, setSession] = useState('open');
  const [number, setNumber] = useState('');
  const [pana, setPana] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (!marketId && active.length) setMarketId(active[0].id);
  }, [active, marketId]);

  async function loadHistory() {
    try {
      const res = await api('/api/admin/results?limit=60');
      setHistory(res.data);
    } catch {
      /* history is informational */
    }
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const market = active.find((m) => m.id === marketId);

  // Which halves are already declared for the selected market + date.
  const declared = useMemo(() => {
    const open = history.find((r) => r.marketId === marketId && r.date === date && r.session === 'open');
    const close = history.find((r) => r.marketId === marketId && r.date === date && r.session === 'close');
    return { open, close, jodi: close?.jodi ?? null };
  }, [history, marketId, date]);

  // Live preview of what the public page will show.
  // Mirrors buildDisplay() in server/models/Result.js:
  //   open only   -> "<openPana>-<number>"
  //   both halves -> "<openPana>-<jodi>-<closePana>"
  const preview = useMemo(() => {
    const oPana = session === 'open' ? pana : declared.open?.pana;
    const cPana = session === 'close' ? pana : declared.close?.pana;
    const oNum = session === 'open' ? number : declared.open?.number;
    const cNum = session === 'close' ? number : declared.close?.number;

    if (oPana && cPana) {
      return oNum && cNum ? `${oPana}-${oNum}${cNum}-${cPana}` : `${oPana}-${cPana}`;
    }
    if (oPana) return oNum ? `${oPana}-${oNum}` : oPana;
    if (cPana) return cNum ? `${cPana}-${cNum}` : cPana;
    return '—';
  }, [session, number, pana, declared]);

  async function submit(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const res = await api('/api/admin/results', {
        method: 'POST',
        body: JSON.stringify({ marketId, date, session, number, pana, note }),
      });

      const d = res.data;
      setMsg({
        type: 'ok',
        text: d.jodiComplete
          ? `Saved. Jodi ${d.jodi} is now live on the site (${d.display}).`
          : `Saved ${d.session} ${d.pana}-${d.number}. Now enter the ${
              d.session === 'open' ? 'close' : 'open'
            } to complete the jodi.`,
      });

      // Jump straight to the other half so the operator can finish the draw.
      setNumber('');
      setPana('');
      setNote('');
      setSession(d.session === 'open' ? 'close' : 'open');

      loadHistory();
      onChanged();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function removeResult(r) {
    if (!confirm(`Delete the ${r.session} result "${r.display}" for ${r.market}?`)) return;
    try {
      await api(`/api/admin/results/${r.id}`, { method: 'DELETE' });
      loadHistory();
      onChanged();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  if (active.length === 0) {
    return (
      <div className="adm-section">
        <h2>Declare a result</h2>
        <p className="adm-empty">You have no active markets yet. Create one above first.</p>
      </div>
    );
  }


  return (
    <>
      <div className="adm-section">
        <h2>Declare a result</h2>
        <p className="adm-hint">
          Enter the open first (number + panna), then the close. The jodi is worked out
          automatically from the two pannas - you never type it.
        </p>

        {msg && <div className={msg.type === 'ok' ? 'adm-ok' : 'adm-error'}>{msg.text}</div>}

        <form onSubmit={submit}>
          <div className="adm-grid2">
            <label className="adm-label">
              Market
              <select
                className="adm-input"
                value={marketId}
                onChange={(e) => setMarketId(e.target.value)}
                required
              >
                {active.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.closeTimeLabel})
                  </option>
                ))}
              </select>
            </label>

            <label className="adm-label">
              Draw date
              <input
                className="adm-input"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </label>
          </div>

          {/* Step 1 / step 2, doubling as a progress indicator. */}
          <div className="adm-row" style={{ marginBottom: 14, alignItems: 'center' }}>
            <button
              type="button"
              className="adm-btn adm-btn-sm"
              style={session === 'open' ? { background: '#0f62fe', color: '#fff', borderColor: '#0f62fe' } : {}}
              onClick={() => setSession('open')}
            >
              1. Open {declared.open ? `✓ ${declared.open.pana}-${declared.open.number}` : '(pending)'}
            </button>
            <button
              type="button"
              className="adm-btn adm-btn-sm"
              style={session === 'close' ? { background: '#0f62fe', color: '#fff', borderColor: '#0f62fe' } : {}}
              onClick={() => setSession('close')}
            >
              2. Close {declared.close ? `✓ ${declared.close.pana}-${declared.close.number}` : '(pending)'}
            </button>
            {market && (
              <span className="adm-hint" style={{ margin: 0 }}>
                Open {fmtTime(market.openTime)} &middot; Close {fmtTime(market.closeTime)}
              </span>
            )}
          </div>

          <div className="adm-row">
            <label className="adm-label" style={{ flex: 1, minWidth: 130 }}>
              {session === 'open' ? 'Open number' : 'Close number'}
              <input
                className="adm-input"
                value={number}
                onChange={(e) => setNumber(onlyDigits(e.target.value).slice(0, 2))}
                placeholder="7"
                inputMode="numeric"
                required
              />
            </label>

            <label className="adm-label" style={{ flex: 1, minWidth: 130 }}>
              {session === 'open' ? 'Open panna' : 'Close panna'}
              <input
                className="adm-input"
                value={pana}
                onChange={(e) => setPana(onlyDigits(e.target.value).slice(0, 3))}
                placeholder="257"
                inputMode="numeric"
                required
              />
            </label>

            <label className="adm-label" style={{ flex: 1, minWidth: 150 }}>
              Note (optional)
              <input
                className="adm-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={300}
              />
            </label>

            <div className="adm-label" style={{ minWidth: 190 }}>
              {declared.jodiComplete ? 'Jodi is live' : 'Will publish as'}
              <div className="adm-result" style={{ paddingTop: 8, fontSize: 16 }}>
                {preview}
              </div>
            </div>
          </div>

          <button
            className="adm-btn adm-btn-primary"
            type="submit"
            disabled={busy}
            style={{ maxWidth: 260 }}
          >
            {busy ? 'Saving...' : `Save ${session} result`}
          </button>
        </form>
      </div>

      <div className="adm-section">
        <h2>Recent results</h2>
        {history.length === 0 ? (
          <p className="adm-empty">No results declared yet.</p>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Market</th>
                <th>Half</th>
                <th>Number</th>
                <th>Panna</th>
                <th>Jodi</th>
                <th>Live as</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td>{r.date}</td>
                  <td>{r.market}</td>
                  <td style={{ textTransform: 'capitalize' }}>{r.session}</td>
                  <td className="adm-result">{r.number}</td>
                  <td className="adm-result">{r.pana}</td>
                  <td className="adm-result">
                    {r.jodiComplete ? r.jodi : <span style={{ color: 'var(--adm-muted)' }}>—</span>}
                  </td>
                  <td>{r.display}</td>
                  <td>
                    <button
                      className="adm-btn adm-btn-sm adm-btn-danger"
                      onClick={() => removeResult(r)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
