import { useCallback, useEffect, useState } from 'react';
import { useAuth, useApiClient } from './AuthContext.jsx';
import MarketManager from './MarketManager.jsx';
import ResultDeclarer from './ResultDeclarer.jsx';
import UserManager from './UserManager.jsx';
import Login from './Login.jsx';

export default function AdminApp() {
  const { isAuthed, user, logout } = useAuth();
  const api = useApiClient();

  const [markets, setMarkets] = useState([]);
  const [users, setUsers] = useState([]);
  const [counts, setCounts] = useState(null);
  const [tab, setTab] = useState('result');
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');

  const isSuper = user?.role === 'super_admin';

  const load = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([
        api('/api/admin/markets'),
        fetch('/api/health').then((r) => r.json()),
      ]);
      setMarkets(m.data);
      setCounts(h.counts ?? null);
      setHealth(h);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [api]);

  // Admin metrics are super-admin only, so fetch them separately.
  const loadUsers = useCallback(async () => {
    if (!isSuper) return;
    try {
      const r = await api('/api/admin/users');
      setUsers(r.data);
    } catch (err) {
      setError(err.message);
    }
  }, [api, isSuper]);

  useEffect(() => {
    if (isAuthed) load();
  }, [isAuthed, load]);

  useEffect(() => {
    if (isAuthed) loadUsers();
  }, [isAuthed, loadUsers]);

  function refreshAll() {
    load();
    loadUsers();
  }

  if (!isAuthed) {
    return (
      <>
        <Login />
      </>
    );
  }


  return (
    <div className="adm-wrap">
      <div className="adm-topbar">
        <div>
          <h1>Live Matka Admin</h1>
          <div className="adm-user">
            Signed in as <strong>{user?.username}</strong> ({user?.role})
            {health && (
              <>
                {' '}
                &middot; provider: <strong>{health.provider}</strong> &middot; db:{' '}
                <strong>{health.db}</strong>
              </>
            )}
          </div>
        </div>
        <div className="adm-row">
          <a className="adm-btn adm-btn-sm" href="/" target="_blank" rel="noreferrer">
            View site
          </a>
          <button className="adm-btn adm-btn-sm" onClick={load}>
            Refresh
          </button>
          <button className="adm-btn adm-btn-sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>

      {error && <div className="adm-error">{error}</div>}

      {counts && (
        <div className="adm-stats">
          <div className="adm-stat">
            <b>{counts.total}</b>
            <span>Total markets</span>
          </div>
          <div className="adm-stat">
            <b>{counts.provider}</b>
            <span>From API</span>
          </div>
          <div className="adm-stat">
            <b>{counts.custom}</b>
            <span>Your markets</span>
          </div>
          <div className="adm-stat">
            <b>{counts.pending}</b>
            <span>Pending draw</span>
          </div>
        </div>
      )}

      <div className="adm-row" style={{ marginBottom: 18 }}>
        <TabBtn active={tab === 'result'} onClick={() => setTab('result')}>
          Declare result
        </TabBtn>
        <TabBtn active={tab === 'markets'} onClick={() => setTab('markets')}>
          Manage markets
        </TabBtn>
        {isSuper && (
          <TabBtn active={tab === 'users'} onClick={() => setTab('users')}>
            Admins &amp; metrics
          </TabBtn>
        )}
      </div>

      {tab === 'result' && (
        <ResultDeclarer
          markets={markets}
          currentUserId={user?.id}
          isSuper={isSuper}
          onChanged={refreshAll}
        />
      )}
      {tab === 'markets' && (
        <MarketManager
          markets={markets}
          currentUserId={user?.id}
          isSuper={isSuper}
          onChanged={refreshAll}
        />
      )}
      {tab === 'users' && isSuper && (
        <UserManager users={users} onChanged={refreshAll} currentUserId={user?.id} />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button
      className="adm-btn adm-btn-sm"
      style={active ? { background: '#0f62fe', color: '#fff', borderColor: '#0f62fe' } : {}}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

