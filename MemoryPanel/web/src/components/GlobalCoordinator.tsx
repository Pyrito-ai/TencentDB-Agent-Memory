import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, Compass, LoaderCircle, RefreshCw, X } from 'lucide-react';
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
type CoordinatorProps = {
  open: boolean;
  onClose: () => void;
};

const PAGE_NAMES: Record<string, string> = {
  '/': 'Task board',
  '/today': 'Today',
  '/upcoming': 'Upcoming',
  '/projects': 'Task board',
  '/areas': 'Areas',
  '/loops': 'Loops',
  '/timesheets': 'Timesheets',
  '/workbench': 'Workbench',
  '/wiki': 'Knowledge',
  '/code': 'Code',
  '/skills': 'Skills',
  '/memory': 'Memory',
  '/analytics': 'Analytics',
  '/team/members': 'Members',
  '/team/agents': 'Agents',
  '/team/api-keys': 'API Keys',
  '/guide': 'Guide',
};
function proposalLabel(name: string) {
  const parts = name.replace(/^meta\//, '').split('/');
  const action = parts.pop()?.replaceAll('-', ' ') || 'Change';
  const subject = parts.join(' ').replaceAll('-', ' ');
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} ${subject}`.trim();
}

function proposalTarget(args: Record<string, unknown>) {
  const keys = [
    'title',
    'name',
    'taskId',
    'task_id',
    'projectId',
    'loopId',
    'id',
    'wiki_id',
    'skill_id',
  ];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return { key, value };
  }
  return null;
}

export function GlobalCoordinator(props: CoordinatorProps) {
  const { activeTeamId } = useTeams();
  const session = getPanelSession();
  return activeTeamId && session ? (
    <Chat
      key={JSON.stringify([session.instanceId, session.userKey, activeTeamId])}
      team={activeTeamId}
      {...props}
    />
  ) : null;
}

function Chat({ team, open, onClose }: CoordinatorProps & { team: string }) {
  const location = useLocation();
  const titleId = useId();
  const contextId = useId();
  const [state, setState] = useState<State>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const keepAtBottom = useRef(true);

  function close() {
    onClose();
    document.getElementById('baren-coordinator-toggle')?.focus({ preventScroll: true });
  }

  const request = useCallback(
    async (op: string, body?: unknown) => {
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
    },
    [team],
  );

  async function load() {
    if (busy) return;
    setBusy(true);
    try {
      setState(await request('state'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
  }, [request]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (open && scroller && keepAtBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [state?.revision, busy, open]);

  async function act(op: 'message' | 'approve' | 'cancel') {
    if (busy || !state) return;
    if (
      op === 'message' &&
      (!state.ready ||
        !text.trim() ||
        ['proposed', 'executing'].includes(state.pending?.status || ''))
    )
      return;
    setBusy(true);
    setError('');
    keepAtBottom.current = true;
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

  const pageName =
    PAGE_NAMES[location.pathname] ||
    Object.entries(PAGE_NAMES).find(
      ([path]) => path !== '/' && location.pathname.startsWith(`${path}/`),
    )?.[1] ||
    'Workspace';
  const currentTask = new URLSearchParams(location.search).get('task');
  const pending = state?.pending;
  const target = pending ? proposalTarget(pending.args) : null;
  const awaitingReview = pending?.status === 'proposed';
  const sendingDisabled =
    busy || !state?.ready || !text.trim() || awaitingReview || pending?.status === 'executing';

  return (
    <div className="global-coordinator-shell" hidden={!open}>
      <section
        id="baren-coordinator-panel"
        className="global-coordinator"
        role="complementary"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            event.currentTarget.contains(event.target as Node)
          ) {
            event.preventDefault();
            close();
          }
        }}
      >
        <header className="global-coordinator-heading">
          <div className="global-coordinator-identity">
            <img src="/baren-mark.svg" alt="" className="global-coordinator-mark" />
            <div>
              <h2 id={titleId}>Coordinator</h2>
              <p>Your work, in context</p>
            </div>
          </div>
          <span
            className={`global-coordinator-readiness${state?.ready ? ' is-ready' : ''}`}
            role="status"
          >
            <span />
            {state?.ready
              ? 'Ready'
              : state
                ? 'Not configured'
                : error
                  ? 'Unavailable'
                  : 'Connecting'}
          </span>
          <button
            type="button"
            className="global-coordinator-close"
            aria-label="Close coordinator"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>

        <div
          ref={scrollRef}
          className="global-coordinator-scroll"
          onScroll={(event) => {
            const el = event.currentTarget;
            keepAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          <div className="global-coordinator-context" aria-labelledby={contextId}>
            <div className="global-coordinator-eyebrow" id={contextId}>
              <Compass size={13} /> Current context
            </div>
            <div className="global-coordinator-context-page">
              Workspace <ChevronRight size={13} /> <strong>{pageName}</strong>
            </div>
            {currentTask && (
              <p className="global-coordinator-context-task">
                Task <span>{currentTask}</span>
              </p>
            )}
            <p>Ask about your work. Review changes before they are applied.</p>
          </div>
          <div
            className="global-coordinator-history"
            role="log"
            aria-label="Coordinator conversation"
            aria-live="polite"
            aria-relevant="additions text"
          >
            <div className="global-coordinator-eyebrow global-coordinator-conversation-label">
              Conversation
            </div>
            {!state?.messages.length && (
              <div className="global-coordinator-welcome">
                <div className="global-coordinator-welcome-icon">
                  <Compass size={23} />
                </div>
                <h3>A little clarity for your day.</h3>
                <p>
                  Ask what needs your attention, explore a project, or describe a change you want to
                  make.
                </p>
                <button
                  type="button"
                  onClick={() => setText('What should I focus on today?')}
                  disabled={busy}
                >
                  What should I focus on today? <ChevronRight size={14} />
                </button>
              </div>
            )}
            {state?.messages.slice(-20).map((message, index) => (
              <article
                key={index}
                className={`global-coordinator-message${message.role === 'user' ? ' is-user' : ''}`}
              >
                <strong>{message.role === 'user' ? 'You' : 'Coordinator'}</strong>
                <p>{message.text.split('\n{')[0]}</p>
                {message.text.includes('\n{') && (
                  <details>
                    <summary>Result details</summary>
                    <pre>{message.text.slice(message.text.indexOf('\n{') + 1)}</pre>
                  </details>
                )}
              </article>
            ))}
          </div>

          {pending && pending.status !== 'done' && (
            <div className="global-coordinator-proposal">
              <div className="global-coordinator-eyebrow">
                <span className="global-coordinator-proposal-dot" />
                {awaitingReview ? 'Your review' : `Action ${pending.status}`}
              </div>
              <h3>{proposalLabel(pending.name)}</h3>
              {target && (
                <p className="global-coordinator-proposal-target">
                  <span>{target.key.replaceAll('_', ' ')}</span>
                  {target.value}
                </p>
              )}
              {awaitingReview && <p>Review this proposed change before applying it.</p>}
              <details>
                <summary>Change details</summary>
                <p className="global-coordinator-action-name">{pending.name}</p>
                <pre>{JSON.stringify(pending.args, null, 2)}</pre>
              </details>
              {awaitingReview && (
                <div className="global-coordinator-proposal-actions">
                  <button
                    className="global-coordinator-apply"
                    type="button"
                    disabled={busy}
                    onClick={() => void act('approve')}
                  >
                    <Check size={15} /> Apply change
                  </button>
                  <button type="button" disabled={busy} onClick={() => void act('cancel')}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}
          {busy && (
            <p className="global-coordinator-working" role="status">
              <LoaderCircle size={14} /> Working…
            </p>
          )}
        </div>

        <footer className="global-coordinator-footer">
          {error && (
            <div className="global-coordinator-error" role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => void load()} disabled={busy}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
          )}
          {state && !state.ready && (
            <p className="global-coordinator-notice">
              Coordinator model connection is not configured.
            </p>
          )}
          {awaitingReview && (
            <p className="global-coordinator-notice">
              Apply or dismiss the proposed change to continue.
            </p>
          )}
          <form
            className="global-coordinator-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void act('message');
            }}
          >
            <textarea
              aria-label="Message coordinator"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="What would you like to work on?"
              rows={3}
              maxLength={6000}
            />
            <div className="global-coordinator-composer-bottom">
              <span>Changes stay in your hands</span>
              <button
                type="submit"
                aria-label={busy ? 'Coordinator is working' : 'Send message'}
                disabled={sendingDisabled}
              >
                {busy ? <LoaderCircle size={17} /> : <ArrowUp size={18} />}
              </button>
            </div>
          </form>
          <p className="global-coordinator-footer-note">Review proposed changes before applying.</p>
        </footer>
      </section>
    </div>
  );
}
