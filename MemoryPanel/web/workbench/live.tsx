import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from '../src/pages/OrcaWorkbench';
import { setPanelSession } from '../src/lib/panelSession';
import '../src/i18n';
function Live() {
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [team, setTeam] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/v1/local-session')
      .then(async (r) => {
        const s = await r.json();
        if (!r.ok) throw Error(s.error);
        setPanelSession({ instanceId: s.instance, userKey: 'local-cookie-session' });
        setTeams(s.teams);
        setTeam(s.teams[0]?.id || '');
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <header style={{ font: '12px system-ui', padding: '10px', background: '#eef6ef' }}>
        LIVE WORKBENCH · Coordinator calls use API billing · Approved workers execute in Orca{' '}
        <select aria-label="Tencent team" value={team} onChange={(e) => setTeam(e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : team ? (
        <Workspace key={team} team={team} />
      ) : (
        <p>Connecting to Tencent…</p>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Live />);
