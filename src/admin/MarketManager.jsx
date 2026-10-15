import { useEffect, useMemo, useState } from 'react';
import { useApiClient } from './AuthContext.jsx';
import TimePicker from './TimePicker.jsx';

/** Day-of-week labels — 0 = Sun ... 6 = Sat */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Default closed days: Sunday + Saturday (traditional matka schedule). */
const DEFAULT_OFF_DAYS = [0, 6];

const BLANK = {
  name: '',
  openTime: '',
  closeTime: '',
  category: 'Custom',
  note: '',
  offDays: [...DEFAULT_OFF_DAYS],
};

export default function MarketManager({ markets, currentUserId, isSuper, onChanged }) {
  const api = useApiClient();
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // The API now returns the operator's webhook (unowned) markets too, so the
  // result dropdown can declare on them. Those are NOT management objects for
  // a normal admin (the server rejects hide/delete on them), so keep them out
  // of this table. A super admin can manage everything.
  // NOTE: a login stored BEFORE the backend started returning user ids has a
  // user object with no id field (e.g. after an old cached login): then
  // currentUserId is undefined and a strict equality check hides EVERY row,
  // showing "No custom markets yet" even though the markets are there. So when
  // we cannot tell who owns what, show the rows instead of an empty table.
  const managed = useMemo(() => {
    if (isSuper) return markets;
    if (!currentUserId) return markets;
    const mine = markets.filter((m) => m.owner && m.owner === currentUserId);
    // If none of the returned rows carry an owner id we recognise (stale or
    // partial payload), fall back to showing everything rather than an empty
    // "no markets" table - the server still enforces edit/delete rights.
    return mine.length > 0 ? mine : markets;
  }, [markets, isSuper, currentUserId]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function create(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await api('/api/admin/markets', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm(BLANK);
      setMsg({ type: 'ok', text: `Created "${form.name}" - it now appears on the public site.` });
      onChanged();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(m) {
    setMsg(null);
    try {
      await api(`/api/admin/markets/${m.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: !m.active }),
      });
      onChanged();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  async function remove(m) {
    if (!confirm(`Delete "${m.name}"? Its declared results will be deleted too.`)) return;
    setMsg(null);
    try {
      await api(`/api/admin/markets/${m.id}`, { method: 'DELETE' });
      setMsg({ type: 'ok', text: `Deleted "${m.name}".` });
      onChanged();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }

  return (
    <>
      <div className="adm-section">
        <h2>Create a market</h2>
        <p className="adm-hint">
          It is published on the homepage immediately, sorted into place by its
          open time so it sits naturally among the other markets.
        </p>

        {msg && <div className={msg.type === 'ok' ? 'adm-ok' : 'adm-error'}>{msg.text}</div>}

        <form onSubmit={create}>
          <div className="adm-grid2">
            <label className="adm-label">
              Market name
              <input
                className="adm-input"
                value={form.name}
                onChange={set('name')}
                placeholder="e.g. SHRI KALYAN NIGHT"
                required
                maxLength={80}
              />
            </label>

            <label className="adm-label">
              Category
              <input
                className="adm-input"
                value={form.category}
                onChange={set('category')}
                placeholder="Custom"
                maxLength={40}
              />
            </label>

            <TimePicker
              label="Open time"
              value={form.openTime}
              onChange={(v) => setForm((f) => ({ ...f, openTime: v }))}
            />

            <TimePicker
              label="Close time"
              value={form.closeTime}
              onChange={(v) => setForm((f) => ({ ...f, closeTime: v }))}
            />
          </div>

          <div className="adm-row" style={{ marginTop: 12 }}>
            <span className="adm-label">Closed days</span>
            <span className="adm-hint">Off-day markets show ** in charts and never auto-append results.</span>
            <div className="adm-row-inline" style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              {DAY_LABELS.map((d) => (
                <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text)' }}>
                  <input
                    type="checkbox"
                    checked={form.offDays.includes(DAY_LABELS.indexOf(d))}
                    onChange={(e) => {
                      setForm((f) => {
                        const next = f.offDays.includes(DAY_LABELS.indexOf(d))
                          ? f.offDays.filter((x) => x !== DAY_LABELS.indexOf(d))
                          : [...f.offDays, DAY_LABELS.indexOf(d)];
                        return { ...f, offDays: next.sort() };
                      });
                    }}
                  />
                  {d}
                </label>
              ))}
            </div>
          </div>

          <button className="adm-btn adm-btn-primary" type="submit" disabled={busy} style={{ maxWidth: 200 }}>
            {busy ? 'Creating...' : 'Create market'}
          </button>
        </form>
      </div>

      <div className="adm-section">
        <h2>Your markets ({managed.length})</h2>

        {managed.length === 0 ? (
          <p className="adm-empty">No custom markets yet. Create one above.</p>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Open</th>
                <th>Close</th>
                <th>Status</th>
                <th style={{ width: 190 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {managed.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.name}</strong>
                    <br />
                    <small style={{ color: 'var(--adm-muted)' }}>/{m.slug}</small>
                  </td>
                  <td>{m.openTimeLabel}</td>
                  <td>{m.closeTimeLabel}</td>
                  <td>
                    <span className={`adm-badge ${m.active ? 'adm-badge-on' : 'adm-badge-off'}`}>
                      {m.active ? 'Live' : 'Hidden'}
                      {m.offDays?.length > 0 && (
                        <span className="adm-badge adm-badge-off" style={{ marginLeft: 6 }} title="Closed days (0=Sun..6=Sat)">
                          OFF:{m.offDays.map((d) => DAY_LABELS[d]).join('/')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td>
                    <button className="adm-btn adm-btn-sm" onClick={() => toggle(m)}>
                      {m.active ? 'Hide' : 'Show'}
                    </button>{' '}
                    <button className="adm-btn adm-btn-sm adm-btn-danger" onClick={() => remove(m)}>
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
