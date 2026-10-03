import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  LockKeyhole,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  StickyNote,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useCoordinatorNote } from '@/components/CoordinatorNoteContext';
import { getPanelSession, type PanelSession } from '@/lib/panelSession';
import { useTeams } from '@/services';
import { NoteMarkdown } from './NoteMarkdown';
import './ops.css';

type Connection = { id: string; email: string; status: string; revokePending: boolean };
type Routine = {
  id: string;
  revision: number;
  connectionId: string;
  name: string;
  query: string;
  instruction: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRun?: number;
  nextRun: number;
  lastError?: string;
  cursor?: string;
};
type Note = {
  id: string;
  revision: number;
  markdown: string;
  trashed: boolean;
  createdAt: number;
};
type State = {
  boardReady: boolean;
  configured: boolean;
  draftReady: boolean;
  busy: boolean;
  connections: Connection[];
  routines: Routine[];
  notes: Note[];
};
type Action = (op: string, body: object) => Promise<unknown>;

export function OpsPage() {
  const { activeTeamId } = useTeams();
  const session = getPanelSession();
  if (!session || !activeTeamId)
    return (
      <div className="ops-page">
        <h1>Ops</h1>
        <p>Sign in and choose a workspace to open your private board.</p>
      </div>
    );
  return (
    <OpsBoard
      key={JSON.stringify([session.instanceId, session.userKey, session.user, activeTeamId])}
      team={activeTeamId}
      session={session}
    />
  );
}

function OpsBoard({ team, session }: { team: string; session: PanelSession }) {
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [oauthSession, setOauthSession] = useState(
    () => new URLSearchParams(window.location.hash.split('?')[1] || '').get('oauth_session') || '',
  );
  useEffect(() => {
    if (oauthSession)
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search + '#/ops',
      );
  }, [oauthSession]);
  const [trash, setTrash] = useState(false);
  const [showRoutine, setShowRoutine] = useState(false);
  const [editingRoutine, setEditingRoutine] = useState<Routine>();
  const abort = useRef(new AbortController());
  const request = useCallback(
    async (op: string, body?: object) => {
      const response = await fetch(`/api/v1/ops/${encodeURIComponent(team)}/${op}`, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: abort.current.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Tdai-Service-Id': session.instanceId,
          'X-Tdai-User-Key': session.userKey,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load private Ops.');
      return data;
    },
    [team, session.instanceId, session.userKey],
  );
  const load = useCallback(async () => {
    setState(await request('list'));
  }, [request]);
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    const refresh = () => {
      void load().catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    };
    refresh();
    window.addEventListener('coordinator-changed', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('coordinator-changed', refresh);
    };
  }, [load]);
  const act: Action = async (op, body) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request(op, body);
      await load();
      return result;
    } catch (e) {
      if (!abort.current.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Operation failed.');
        await load().catch(() => undefined);
      }
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const run = (op: string, body: object, message = '') => {
    void act(op, body)
      .then(() => setNotice(message))
      .catch(() => undefined);
  };
  const connect = () => {
    // Open synchronously so popup blockers don't interrupt the OAuth flow.
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    void act('connect', {})
      .then((result) => {
        const { url } = result as { url: string };
        if (popup) popup.location.href = url;
        else window.location.assign(url);
        setNotice('Finish authorization in the new tab, then choose Check authorization here.');
      })
      .catch(() => popup?.close());
  };
  const active = state?.connections.filter((c) => c.status === 'active') || [];
  const notes = state?.notes.filter((n) => n.trashed === trash) || [];
  return (
    <div className="ops-page">
      <header className="ops-heading">
        <div>
          <h1>Ops</h1>
          <span className="ops-private">
            <LockKeyhole size={14} /> Private to you in this workspace
          </span>
        </div>
        <button
          className="ops-button"
          disabled={busy}
          onClick={() => {
            setError('');
            void load().catch((e) => setError(e.message));
          }}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </header>
      {error && (
        <div role="alert" className="ops-alert">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="ops-notice">
          {notice}
        </p>
      )}
      {oauthSession && (
        <section className="ops-setup">
          <h2>Finish Gmail authorization</h2>
          <p>
            Confirm this connection for your signed-in Pyrito account in the workspace where you
            started it.
          </p>
          <button
            className="ops-button ops-primary"
            disabled={busy}
            onClick={() => {
              void act('complete', { sessionUri: oauthSession })
                .then(() => {
                  setOauthSession('');
                  setNotice('Gmail connected to your private account.');
                })
                .catch(() => undefined);
            }}
          >
            Finish authorization
          </button>
        </section>
      )}
      {!state && !error && <p role="status">Loading your private board…</p>}
      {state && (
        <>
          {state.boardReady === false && (
            <section className="ops-setup">
              <h2>Set up private notes</h2>
              <p>
                Your administrator needs to enable private note storage before your Coordinator can
                post to this board.
              </p>
            </section>
          )}
          <details className="ops-settings" open={!!oauthSession}>
            <summary>
              Connections &amp; routines{' '}
              <span>
                {active.length} connected · {state.routines.filter((r) => r.enabled).length}{' '}
                scheduled
              </span>
            </summary>
            <section className="ops-connections" aria-labelledby="ops-connections-title">
              <div className="ops-section-title">
                <h2 id="ops-connections-title">
                  <Mail size={18} /> Gmail
                </h2>
                <button
                  className="ops-button ops-primary"
                  disabled={busy || !state.configured}
                  onClick={connect}
                >
                  <Plus size={16} /> Connect Gmail
                </button>
              </div>
              <p className="ops-muted">
                Only your coordinator and your routines can use your connections. Team members
                cannot see your mail or notes.
              </p>
              {!state.configured && state.boardReady && (
                <p className="ops-muted">
                  Gmail is not configured. Your Coordinator can still post notes here.
                </p>
              )}
              {state.connections.length === 0 && (
                <p className="ops-muted">No mailbox connected yet.</p>
              )}
              {state.connections.map((c) => (
                <div key={c.id} className="ops-connection">
                  <div>
                    <strong>{c.email || 'Google Workspace / Gmail'}</strong>
                    <span className="ops-status">
                      {c.status === 'pending'
                        ? 'Awaiting authorization'
                        : c.status === 'active'
                          ? 'Connected · private'
                          : 'Disconnected'}
                    </span>
                  </div>
                  <div className="ops-actions">
                    {c.status !== 'disconnected' && (
                      <button
                        className="ops-button"
                        disabled={busy}
                        onClick={() => run('refresh', { id: c.id })}
                      >
                        {c.status === 'pending' ? 'Check authorization' : 'Check connection'}
                      </button>
                    )}
                    {(c.status !== 'disconnected' || c.revokePending) && (
                      <button
                        className="ops-button"
                        disabled={busy}
                        onClick={() =>
                          run(
                            'disconnect',
                            { id: c.id },
                            'Gmail disconnected. Its routines are paused.',
                          )
                        }
                      >
                        {c.revokePending ? 'Retry revocation' : 'Disconnect'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>
            <section className="ops-routines" aria-labelledby="ops-routines-title">
              <div className="ops-section-title">
                <h2 id="ops-routines-title">Routines</h2>
                <button
                  className="ops-button"
                  disabled={busy || !active.length}
                  onClick={() => {
                    setEditingRoutine(undefined);
                    setShowRoutine(!showRoutine);
                  }}
                >
                  <Plus size={16} /> Add routine
                </button>
              </div>
              <p className="ops-muted">
                Check for relevant email and leave a concise note on your board. Routines never send
                email.
              </p>
              {!state.draftReady && state.configured && (
                <p className="ops-muted">
                  A coordinator model must be configured before routines can prepare notes.
                </p>
              )}
              {showRoutine && (
                <RoutineForm
                  key={editingRoutine?.id || 'new'}
                  connections={active}
                  initial={editingRoutine}
                  busy={busy}
                  ready={state.draftReady}
                  onCancel={() => setShowRoutine(false)}
                  onSave={async (body) => {
                    await act('routine-save', body);
                    setShowRoutine(false);
                  }}
                />
              )}
              {state.routines.map((r) => (
                <article className="ops-routine" key={r.id}>
                  <div>
                    <h3>{r.name}</h3>
                    <p className="ops-muted">
                      {r.enabled ? `Every ${r.intervalMinutes} minutes` : 'Paused'} ·{' '}
                      {r.lastRun
                        ? `Last checked ${new Date(r.lastRun).toLocaleString()}`
                        : 'Not checked yet'}
                      {r.cursor ? ' · More messages queued for the next check' : ''}
                    </p>
                    {r.lastError && <p className="ops-error">{r.lastError}</p>}
                  </div>
                  <div className="ops-actions">
                    <button
                      className="ops-button"
                      disabled={busy || !state.draftReady}
                      onClick={() =>
                        run(
                          'routine-run',
                          { id: r.id },
                          'Check complete. Any relevant new email is on your board.',
                        )
                      }
                    >
                      Check now
                    </button>
                    <button
                      className="ops-button"
                      disabled={busy}
                      onClick={() =>
                        run('routine-toggle', {
                          id: r.id,
                          revision: r.revision,
                          enabled: !r.enabled,
                        })
                      }
                    >
                      {r.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      className="ops-button"
                      disabled={busy}
                      onClick={() => {
                        setEditingRoutine(r);
                        setShowRoutine(true);
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </article>
              ))}
            </section>
          </details>
          <section aria-labelledby="ops-notes-title">
            <div className="ops-section-title ops-notes-title">
              <h2 id="ops-notes-title">
                <StickyNote size={18} /> {trash ? 'Dismissed notes' : 'Your notes'}{' '}
                <span className="ops-count">{notes.length}</span>
              </h2>
              <button className="ops-button" onClick={() => setTrash(!trash)}>
                {trash ? 'Back to board' : 'Dismissed'}
              </button>
            </div>
            {notes.length === 0 ? (
              <div className="ops-empty">
                <StickyNote size={30} />
                <h3>{trash ? 'No dismissed notes' : 'No notes yet'}</h3>
                <p>
                  {trash
                    ? 'Dismissed notes stay here until you restore them.'
                    : 'Your Coordinator can leave reminders, decisions, updates, and useful links here. Ask it to add a note.'}
                </p>
              </div>
            ) : (
              <div className="ops-notes">
                {notes.map((note) => (
                  <NoteCard key={`${note.id}:${note.revision}`} note={note} busy={busy} act={act} />
                ))}
              </div>
            )}
          </section>
          {busy && (
            <p role="status" className="ops-working">
              Updating your board…
            </p>
          )}
        </>
      )}
    </div>
  );
}

function RoutineForm({
  connections,
  initial,
  busy,
  ready,
  onCancel,
  onSave,
}: {
  connections: Connection[];
  initial?: Routine;
  busy: boolean;
  ready: boolean;
  onCancel: () => void;
  onSave: (body: object) => Promise<void>;
}) {
  const [connectionId, setConnection] = useState(initial?.connectionId || connections[0]?.id || '');
  const [name, setName] = useState(initial?.name || 'Email that needs my attention');
  const [query, setQuery] = useState(initial?.query || 'in:inbox newer_than:7d');
  const [instruction, setInstruction] = useState(
    initial?.instruction ||
      'Find emails that need my attention. Leave a concise Markdown note with the decision or next step.',
  );
  const [interval, setInterval] = useState(initial?.intervalMinutes || 60);
  const [enabled, setEnabled] = useState(initial?.enabled || false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSave({
      ...(initial ? { id: initial.id, revision: initial.revision } : {}),
      connectionId,
      name,
      query,
      instruction,
      intervalMinutes: interval,
      enabled,
    }).catch(() => undefined);
  };
  return (
    <form className="ops-form" onSubmit={submit}>
      <h3>{initial ? 'Edit routine' : 'New routine'}</h3>
      <div className="ops-form-row">
        <label>
          Name
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Mailbox
          <select required value={connectionId} onChange={(e) => setConnection(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.email}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Gmail search
        <input required maxLength={1000} value={query} onChange={(e) => setQuery(e.target.value)} />
        <small>
          Uses Gmail search syntax. Each check reviews up to five threads and continues through
          additional results on subsequent checks.
        </small>
      </label>
      <label>
        What should your coordinator look for?
        <textarea
          required
          rows={3}
          maxLength={4000}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <div className="ops-form-row">
        <label>
          Check every
          <select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
            {[15, 30, 60, 240, 1440, 10080].map((n) => (
              <option key={n} value={n}>
                {n < 60
                  ? `${n} minutes`
                  : n < 1440
                    ? `${n / 60} ${n === 60 ? 'hour' : 'hours'}`
                    : n === 1440
                      ? 'day'
                      : 'week'}
              </option>
            ))}
          </select>
        </label>
        <label className="ops-checkbox">
          <input
            type="checkbox"
            disabled={!ready}
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{' '}
          Enable scheduled checks
        </label>
      </div>
      <p className="ops-muted">
        Matching email content is shared with your configured coordinator model to prepare private
        notes. Scheduled checks use your saved Pyrito authorization and run while you are away.
      </p>
      <div className="ops-actions">
        <button type="submit" className="ops-button ops-primary" disabled={busy || !connectionId}>
          Save routine
        </button>
        <button type="button" className="ops-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function NoteCard({ note, busy, act }: { note: Note; busy: boolean; act: Action }) {
  const { selection, discuss, clear } = useCoordinatorNote();
  const selected = selection?.note.id === note.id && selection.note.revision === note.revision;
  const markdown = note.markdown || '';
  const label =
    markdown
      .split('\n')
      .find((line) => line.trim())
      ?.replace(/^[#>\s-]+|[*_`]/g, '')
      .slice(0, 100) || 'Coordinator note';
  return (
    <article className={`ops-note${selected ? ' is-selected' : ''}`} aria-label={label}>
      <div className="ops-note-top">
        <span className="ops-private">
          <StickyNote size={14} aria-hidden="true" /> Coordinator
        </span>
        <button
          className="ops-icon"
          title={note.trashed ? 'Restore note' : 'Dismiss note'}
          aria-label={`${note.trashed ? 'Restore' : 'Dismiss'} ${label}`}
          disabled={busy}
          onClick={() => {
            void act('trash', {
              id: note.id,
              revision: note.revision,
              trashed: !note.trashed,
            })
              .then(() => {
                if (selection?.note.id === note.id) clear(selection.requestId);
              })
              .catch(() => undefined);
          }}
        >
          {note.trashed ? <Undo2 size={17} /> : <Trash2 size={17} />}
        </button>
      </div>
      <NoteMarkdown>{markdown}</NoteMarkdown>
      {!note.trashed && (
        <div className="ops-note-actions">
          <button
            type="button"
            className="ops-button ops-note-discuss"
            disabled={busy}
            aria-label={`Discuss ${label} with Coordinator`}
            aria-controls="baren-coordinator-panel"
            onClick={() => discuss({ id: note.id, revision: note.revision, title: label })}
          >
            <MessageSquare size={15} aria-hidden="true" /> Discuss with Coordinator
          </button>
        </div>
      )}
    </article>
  );
}
