import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTeams } from '@/services';
import { getPanelSession } from '@/lib/panelSession';
import { invalidateBackendCache } from '@/services/backendStore';
import './global-coordinator.css';
type State = {
  messages: { role: string; text: string }[];
  pending?: { id: string; name: string; args: Record<string, unknown>; status: string };
  revision: number;
  ready: boolean;
};
export function GlobalCoordinator() {
  const { activeTeamId } = useTeams();
  const session = getPanelSession();
  return activeTeamId && session ? (
    <Chat
      key={JSON.stringify([session.instanceId, session.userKey, activeTeamId])}
      team={activeTeamId}
    />
  ) : null;
}
function Chat({ team }: { team: string }) {
  const location = useLocation();
  const [state, setState] = useState<State>();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function request(op: string, body?: unknown) {
    const session = getPanelSession();
    if (!session) throw Error('Please sign in.');
    const r = await fetch(`/api/v1/coordinator/${encodeURIComponent(team)}/${op}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': session.instanceId,
        'X-Tdai-User-Key': session.userKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || 'Coordinator unavailable.');
    return d;
  }
  async function load() {
    try {
      setState(await request('state'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    let active = true;
    request('state')
      .then((s) => {
        if (active) setState(s);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [team]);
  async function act(op: string) {
    if (busy || !state) return;
    setBusy(true);
    setError('');
    setOpen(true);
    try {
      const s = await request(op, {
        revision: state.revision,
        text,
        page: location.pathname + location.search,
        id: state.pending?.id,
      });
      setState(s);
      if (op === 'message') setText('');
      if (s.changed) {
        invalidateBackendCache();
        window.dispatchEvent(new Event('projects-changed'));
        window.dispatchEvent(new Event('coordinator-changed'));
      }
    } catch (e) {
      setError((e as Error).message);
      await request('state')
        .then(setState)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="global-coordinator" aria-label="Coordinator">
      <header>
        <strong>Coordinator</strong>
        <span>Ask about your work or make a change</span>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Collapse' : 'Conversation'}
        </button>
      </header>
      {open && (
        <div
          className="global-coordinator-history"
          role="log"
          aria-label="Coordinator conversation"
        >
          {!state?.messages.length && (
            <p>
              Try “What should I focus on today?” or “Create a project for the website redesign.”
            </p>
          )}
          {state?.messages.slice(-20).map((m, i) => (
            <article key={i}>
              <strong>{m.role === 'user' ? 'You' : 'Coordinator'}</strong>
              <p>{m.text.split('\n{')[0]}</p>
              {m.text.includes('\n{') && (
                <details>
                  <summary>Result details</summary>
                  <pre>{m.text.slice(m.text.indexOf('\n{') + 1)}</pre>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
      {state?.pending && state.pending.status !== 'done' && (
        <div className="global-coordinator-proposal">
          <strong>
            {state.pending.status === 'proposed'
              ? 'Review proposed change'
              : `Action ${state.pending.status}`}
            : {state.pending.name}
          </strong>
          <details>
            <summary>Change details</summary>
            <pre>{JSON.stringify(state.pending.args, null, 2)}</pre>
          </details>
          {state.pending.status === 'proposed' && (
            <div>
              <button disabled={busy} onClick={() => void act('approve')}>
                Apply change
              </button>
              <button disabled={busy} onClick={() => void act('cancel')}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act('message');
        }}
      >
        <textarea
          aria-label="Message coordinator"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask, plan, or change something…"
          rows={1}
          maxLength={6000}
        />
        <button
          disabled={
            busy ||
            !state?.ready ||
            !text.trim() ||
            state.pending?.status === 'proposed' ||
            state.pending?.status === 'executing'
          }
        >
          {busy ? 'Working…' : 'Send'}
        </button>
      </form>
      {state && !state.ready && <small>Coordinator model connection is not configured.</small>}
    </section>
  );
}
