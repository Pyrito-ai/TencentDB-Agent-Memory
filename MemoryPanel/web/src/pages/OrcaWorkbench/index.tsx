import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  FileCode2,
  FileDiff,
  FolderGit2,
  GitBranch,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { useTeams } from '@/services';
import { getPanelSession } from '@/lib/panelSession';
import './workbench.css';
type Message = {
  id: string;
  role: 'user' | 'assistant' | 'event';
  text: string;
  created: number;
  status?: string;
};
type Worker = {
  assessment?: string;
  id: string;
  title: string;
  agent: 'codex' | 'claude';
  spec: string;
  state: string;
  receipt?: { output?: string; notice?: string; worktree?: string };
  review?: {
    decision: string;
    comment: string;
    snapshot: string;
    created: number;
    stale?: boolean;
  };
};
type Run = {
  id: string;
  binding: string;
  objective: string;
  context: string;
  summary: string;
  created: number;
  workers: Worker[];
  messages?: Message[];
  review?: string;
};
type Options = { bindings: { id: string; label: string }[]; coordinatorReady: boolean };
type Snapshot = {
  files: { path: string; status: string }[];
  branch: string;
  base: string;
  diff: string;
  snapshot: string;
  truncated: boolean;
  notice?: string;
};
async function request<T>(team: string, action: string, body?: unknown): Promise<T> {
  const s = getPanelSession();
  if (!s) throw Error('Please sign in.');
  const r = await fetch(`/api/v1/workbench/${encodeURIComponent(team)}/${action}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': s.instanceId,
      'X-Tdai-User-Key': s.userKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || 'Workbench request failed.');
  return data;
}
export function OrcaWorkbench() {
  const { activeTeamId } = useTeams();
  return activeTeamId ? (
    <Workspace key={activeTeamId} team={activeTeamId} />
  ) : (
    <div className="ow-empty">
      <FolderGit2 />
      <h2>Select a team</h2>
      <p>Your conversations and worker sessions belong to a team.</p>
    </div>
  );
}
export function Workspace({ team }: { team: string }) {
  const [options, setOptions] = useState<Options>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [binding, setBinding] = useState('');
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState('');
  const [taskId, setTaskId] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [tab, setTab] = useState<'session' | 'files' | 'changes' | 'review'>('session');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [file, setFile] = useState<{ path: string; content: string }>();
  const [filter, setFilter] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState('');
  const [followup, setFollowup] = useState('');
  const [feedback, setFeedback] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const [live, setLive] = useState(true);
  const inFlight = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const viewKey = useRef('');
  const fileSequence = useRef(0);
  const chatBottom = useRef<HTMLDivElement>(null);
  const run = runs.find((r) => r.id === selected);
  const worker = run?.workers.find((w) => w.id === workerId) || run?.workers[0];
  const messages =
    run?.messages ||
    (run
      ? ([
          { id: 'objective', role: 'user', text: run.objective, created: run.created },
          { id: 'summary', role: 'assistant', text: run.summary, created: run.created },
        ] as Message[])
      : []);
  const update = (next: Run) => setRuns((old) => [next, ...old.filter((r) => r.id !== next.id)]);
  useEffect(() => {
    let active = true;
    void Promise.all([request<Options>(team, 'options'), request<{ items: Run[] }>(team, 'runs')])
      .then(([o, r]) => {
        if (active) {
          setOptions(o);
          setBinding(o.bindings[0]?.id || '');
          setRuns(r.items);
          setSelected(r.items[0]?.id || '');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [team]);
  useEffect(() => {
    viewKey.current = `${selected}:${worker?.id || ''}`;
    setSnapshot(undefined);
    setFile(undefined);
    setInspectError('');
    setFollowup('');
    setFeedback('');
    setConfirmStop(false);
  }, [selected, worker?.id]);
  useEffect(() => {
    chatBottom.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, messages.length]);
  const activeRunId = run?.id;
  const hasActiveWorker = !!run?.workers.some((w) =>
    ['running', 'launching', 'unknown'].includes(w.state),
  );
  useEffect(() => {
    if (!activeRunId || !live || !hasActiveWorker) return;
    let active = true;
    const id = activeRunId;
    const timer = setInterval(() => {
      if (document.hidden || inFlight.current) return;
      inFlight.current = true;
      setBusy('refresh');
      void request<Run>(team, 'refresh', { id })
        .then((next) => {
          if (active) update(next);
        })
        .catch(() => {
          /* explicit refresh exposes errors; keep last receipt during transient disconnects */
        })
        .finally(() => {
          inFlight.current = false;
          if (active) setBusy('');
        });
    }, 6000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [team, activeRunId, live, hasActiveWorker]);
  async function act(action: string, body: unknown) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(action);
    setError('');
    const original = body as Record<string, unknown>;
    const signature = JSON.stringify([
      action,
      original.id,
      original.workerId,
      original.text,
      original.objective,
    ]);
    const dedupe = ['start', 'message', 'send', 'stop'].includes(action);
    if (dedupe) {
      const operation = attempts.current.get(signature) || crypto.randomUUID();
      attempts.current.set(signature, operation);
      body = { ...original, operation };
    }
    try {
      const next = await request<Run>(team, action, body);
      attempts.current.delete(signature);
      update(next);
      if (action === 'start') setSelected(next.id);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
      return false;
    } finally {
      setBusy('');
      inFlight.current = false;
    }
  }
  async function sendChat() {
    if (!draft.trim()) return;
    const text = draft;
    const ok = run
      ? await act('message', { id: run.id, text, operation: crypto.randomUUID() })
      : await act('start', { binding, objective: text, context, taskId: taskId || undefined });
    if (ok) setDraft('');
  }
  async function inspect() {
    if (!run || !worker || worker.state === 'proposed') return;
    const key = viewKey.current;
    setInspecting(true);
    setInspectError('');
    try {
      const data = await request<Snapshot>(team, 'workspace', { id: run.id, workerId: worker.id });
      if (key === viewKey.current) setSnapshot(data);
    } catch (e) {
      if (key === viewKey.current)
        setInspectError(e instanceof Error ? e.message : 'Unable to load workspace.');
    } finally {
      if (key === viewKey.current) setInspecting(false);
    }
  }
  async function readFile(path: string) {
    if (!run || !worker) return;
    const key = viewKey.current;
    const sequence = ++fileSequence.current;
    setInspecting(true);
    setInspectError('');
    try {
      const data = await request<{ path: string; content: string }>(team, 'file', {
        id: run.id,
        workerId: worker.id,
        path,
      });
      if (key === viewKey.current && sequence === fileSequence.current) setFile(data);
    } catch (e) {
      if (key === viewKey.current && sequence === fileSequence.current)
        setInspectError(e instanceof Error ? e.message : 'Unable to read file.');
    } finally {
      if (key === viewKey.current && sequence === fileSequence.current) setInspecting(false);
    }
  }
  function selectTab(next: typeof tab) {
    setTab(next);
    if (next !== 'session' && !snapshot) void inspect();
  }
  const proposed = run?.workers.filter((w) => w.state === 'proposed') || [];
  const changed = snapshot?.files.filter((f) => f.status.trim()) || [];
  const stale =
    worker?.review &&
    (worker.review.stale || (!!snapshot && worker.review.snapshot !== snapshot.snapshot));
  const connection = options?.bindings.find((b) => b.id === (run?.binding || binding));
  return (
    <div className="orca-workspace">
      <header className="ow-header">
        <div className="ow-brand">
          <span className="ow-logo">
            <FolderGit2 size={18} />
          </span>
          <strong>Workbench</strong>
          <span className="ow-header-divider" />
          <span className="ow-project">{connection?.label || 'Connect a workspace'}</span>
        </div>
        <div className="ow-header-actions">
          <span className="ow-powered">Workers powered by Orca</span>
          <button
            className="ow-icon"
            aria-label="Start a new conversation"
            title="New conversation"
            onClick={() => {
              setSelected('');
              setWorkerId('');
              setDraft('');
              setError('');
            }}
          >
            <Plus size={17} />
          </button>
        </div>
      </header>
      {error && (
        <div className="ow-error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="ow-shell">
        <aside className="ow-sidebar">
          <div className="ow-section-label">
            CONVERSATIONS
            <button
              className="ow-icon"
              aria-label="New conversation"
              onClick={() => {
                setSelected('');
                setWorkerId('');
                setDraft('');
              }}
            >
              <Plus size={14} />
            </button>
          </div>
          <nav aria-label="Conversations">
            {runs.map((r) => (
              <button
                key={r.id}
                className={`ow-run ${selected === r.id ? 'is-selected' : ''}`}
                onClick={() => {
                  setSelected(r.id);
                  setWorkerId('');
                  setDraft('');
                }}
              >
                <MessageSquare size={14} />
                <span>
                  {r.objective}
                  <small>
                    {new Date(r.created).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}{' '}
                    · {r.workers.length} workers
                  </small>
                </span>
              </button>
            ))}
          </nav>
          {loaded && !runs.length && (
            <p className="ow-hint">
              Start a conversation to bring your project context and workers together.
            </p>
          )}
          <div className="ow-section-label ow-worker-label">
            WORKER SESSIONS<span>{run?.workers.length || 0}</span>
          </div>
          <nav aria-label="Worker sessions">
            {run?.workers.map((w) => (
              <button
                key={w.id}
                className={`ow-worker-link ${worker?.id === w.id ? 'is-selected' : ''}`}
                onClick={() => {
                  setWorkerId(w.id);
                  setTab('session');
                }}
              >
                <span className={`ow-state-dot ${w.state}`} />
                <span>
                  {w.title}
                  <small>
                    {w.agent === 'claude' ? 'Claude Code' : 'Codex'} · {w.state}
                  </small>
                </span>
                <ChevronRight size={13} />
              </button>
            ))}
          </nav>
          {!run?.workers.length && (
            <p className="ow-hint">Workers appear here when the coordinator proposes a task.</p>
          )}
          <div className="ow-sidebar-footer">
            <GitBranch size={14} />
            <span>
              Separate worktrees
              <br />
              <small>Shared project context</small>
            </span>
          </div>
        </aside>
        <section className="ow-conversation" aria-label="Coordinator conversation">
          <div className="ow-pane-heading">
            <div className="ow-person">
              <span className="ow-avatar">
                <Bot size={17} />
              </span>
              <div>
                <strong>Coordinator</strong>
                <small>Plan, delegate, and review</small>
              </div>
            </div>
            <button
              className={`ow-context-toggle ${contextOpen ? 'active' : ''}`}
              onClick={() => setContextOpen(!contextOpen)}
            >
              Context
            </button>
          </div>
          {contextOpen && (
            <div className="ow-context">
              <div className="ow-section-label">PROJECT CONTEXT</div>
              {run ? (
                <>
                  <p>{run.context || 'No additional context attached to this conversation.'}</p>
                  <p className="ow-hint">Add further context in the conversation below.</p>
                </>
              ) : (
                <>
                  <label>
                    Tencent task ID
                    <input
                      value={taskId}
                      onChange={(e) => setTaskId(e.target.value)}
                      placeholder="Optional task reference"
                    />
                  </label>
                  <label>
                    Memory, Wiki excerpts, and constraints
                    <textarea
                      rows={4}
                      maxLength={20000}
                      value={context}
                      onChange={(e) => setContext(e.target.value)}
                      placeholder="What should the coordinator know?"
                    />
                  </label>
                  <p className="ow-hint">
                    Context is attached explicitly. Automatic memory sync is not connected yet.
                  </p>
                </>
              )}
            </div>
          )}
          <div className="ow-chat-scroll">
            {!run && (
              <div className="ow-welcome">
                <span className="ow-welcome-mark">
                  <Bot size={27} />
                </span>
                <h1>What are we working on?</h1>
                <p>
                  Discuss the outcome with your coordinator, then bring in Codex or Claude Code
                  workers when you're ready.
                </p>
                <div className="ow-suggestions">
                  {[
                    'Plan a feature with me',
                    'Review a change before we ship',
                    'Break down a project',
                  ].map((s) => (
                    <button key={s} onClick={() => setDraft(s)}>
                      {s}
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <article key={m.id} className={`ow-message ${m.role}`}>
                <div className="ow-message-label">
                  {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Coordinator' : 'Activity'}
                  <time>
                    {new Date(m.created).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <div className="ow-message-text">{m.text}</div>
                {m.status === 'failed' && (
                  <small className="ow-warning">Response unavailable · message saved</small>
                )}
              </article>
            ))}
            {proposed.length > 0 && (
              <div className="ow-proposals">
                <div className="ow-section-label">PROPOSED WORKERS · AWAITING YOUR APPROVAL</div>
                {proposed.map((w) => (
                  <div className="ow-proposal" key={w.id}>
                    <div>
                      <span className="ow-agent-icon">{w.agent === 'codex' ? 'C' : '✳'}</span>
                      <strong>{w.title}</strong>
                    </div>
                    <p>{w.spec}</p>
                    <div className="ow-proposal-actions">
                      <span>{w.agent === 'claude' ? 'Claude Code' : 'Codex'} · new worktree</span>
                      <button
                        className="ow-primary"
                        disabled={!!busy}
                        onClick={() => {
                          setWorkerId(w.id);
                          void act('dispatch', { id: run!.id, workerId: w.id });
                        }}
                      >
                        Approve & launch
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!!busy && ['start', 'message', 'review'].includes(busy) && (
              <div className="ow-thinking" role="status">
                <span />
                Coordinator is {busy === 'review' ? 'reviewing the evidence' : 'thinking'}…
              </div>
            )}
            <div ref={chatBottom} />
          </div>
          <div className="ow-composer-area">
            {!run && (
              <label className="ow-runtime-label">
                Workspace
                <select
                  aria-label="Runtime and repository"
                  value={binding}
                  onChange={(e) => setBinding(e.target.value)}
                >
                  <option value="">Select a connected runtime</option>
                  {options?.bindings.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {loaded && (!options?.bindings.length || !options.coordinatorReady) && (
              <div className="ow-connection-note">
                {!options?.bindings.length
                  ? 'Connect an Orca runtime to your user and team to begin.'
                  : 'Configure the coordinator model to begin.'}
              </div>
            )}
            <form
              className="ow-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void sendChat();
              }}
            >
              <textarea
                aria-label="Message coordinator"
                value={draft}
                maxLength={8000}
                rows={3}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  run
                    ? 'Talk to your coordinator…'
                    : 'Describe an outcome, ask a question, or explore an idea…'
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void sendChat();
                  }
                }}
              />
              <div>
                <span>
                  {run ? 'Conversation saved' : 'Start with a conversation'} · ⌘ Enter to send
                </span>
                <button
                  className="ow-send"
                  aria-label="Send message to coordinator"
                  disabled={
                    !!busy ||
                    !options?.coordinatorReady ||
                    !connection ||
                    draft.trim().length < (run ? 1 : 10)
                  }
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </form>
            <p className="ow-billing">
              Coordinator uses API billing. Workers use the account signed in to Orca.
            </p>
          </div>
        </section>
        <section className="ow-inspector" aria-label="Worker workspace">
          <div className="ow-pane-heading">
            <div className="ow-person">
              <span className="ow-avatar worker">
                <Terminal size={16} />
              </span>
              <div>
                <strong>{worker?.title || 'Worker workspace'}</strong>
                <small>
                  {worker
                    ? `${worker.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${worker.state}`
                    : 'Sessions, files, changes, and review'}
                </small>
              </div>
            </div>
            <button
              className="ow-icon"
              title="Refresh worker"
              aria-label="Refresh worker"
              disabled={!run || !!busy}
              onClick={() => {
                if (run) void act('refresh', { id: run.id });
                if (tab !== 'session') void inspect();
              }}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="ow-tabs" role="tablist" aria-label="Workspace views">
            {(
              [
                { id: 'session', label: 'Session', icon: Terminal },
                { id: 'files', label: 'Files', icon: FileCode2 },
                { id: 'changes', label: 'Changes', icon: FileDiff },
                { id: 'review', label: 'Review', icon: Check },
              ] as const
            ).map((t) => (
              <button
                role="tab"
                aria-selected={tab === t.id}
                key={t.id}
                onClick={() => selectTab(t.id)}
              >
                <t.icon size={14} />
                {t.label}
                {t.id === 'changes' && changed.length > 0 && <span>{changed.length}</span>}
              </button>
            ))}
          </div>
          {!worker ? (
            <div className="ow-empty">
              <FolderGit2 size={32} />
              <h2>Room for the work</h2>
              <p>
                Select a worker to follow its session, browse its files, and review its changes
                without leaving Workbench.
              </p>
            </div>
          ) : worker.state === 'proposed' ? (
            <div className="ow-empty ow-proposed-detail">
              <Bot size={28} />
              <h2>{worker.title}</h2>
              <p>{worker.spec}</p>
              <button
                className="ow-primary"
                disabled={!!busy}
                onClick={() => void act('dispatch', { id: run!.id, workerId: worker.id })}
              >
                Approve & launch worker
              </button>
              <small>
                Starts {worker.agent === 'claude' ? 'Claude Code' : 'Codex'} in a new Orca worktree.
              </small>
            </div>
          ) : (
            <>
              {tab === 'session' && (
                <div className="ow-session">
                  <div className="ow-session-toolbar">
                    <span className={`ow-state-dot ${worker.state}`} />
                    <span>
                      {worker.state === 'running'
                        ? 'Worker session active'
                        : worker.state === 'exited'
                          ? 'Terminal exited · review required'
                          : 'Awaiting runtime confirmation'}
                    </span>
                    <label>
                      <input
                        type="checkbox"
                        checked={live}
                        onChange={(e) => setLive(e.target.checked)}
                      />{' '}
                      Live updates
                    </label>
                  </div>
                  <pre className="ow-terminal" aria-label="Worker output">
                    {worker.receipt?.output ||
                      'Waiting for worker output. Refresh to inspect the session.'}
                  </pre>
                  <p className="ow-runtime-notice">{worker.receipt?.notice}</p>
                  {confirmStop ? (
                    <div className="ow-stop-confirm">
                      <p>Stop this worker terminal? Its worktree and files will be preserved.</p>
                      <button
                        disabled={!!busy}
                        onClick={() => {
                          void act('stop', {
                            id: run!.id,
                            workerId: worker.id,
                            operation: crypto.randomUUID(),
                          }).then(() => setConfirmStop(false));
                        }}
                      >
                        Stop worker
                      </button>
                      <button onClick={() => setConfirmStop(false)}>Keep running</button>
                    </div>
                  ) : (
                    <form
                      className="ow-followup"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act('send', {
                          id: run!.id,
                          workerId: worker.id,
                          text: followup,
                          operation: crypto.randomUUID(),
                        }).then((ok) => {
                          if (ok) setFollowup('');
                        });
                      }}
                    >
                      <label>
                        Message {worker.agent === 'claude' ? 'Claude Code' : 'Codex'}
                        <textarea
                          aria-label="Worker follow-up"
                          rows={2}
                          value={followup}
                          onChange={(e) => setFollowup(e.target.value)}
                          maxLength={8000}
                          placeholder="Give feedback or steer this worker…"
                        />
                      </label>
                      <div>
                        <button
                          type="button"
                          className="ow-danger-link"
                          disabled={!!busy || worker.state === 'exited'}
                          onClick={() => setConfirmStop(true)}
                        >
                          <Square size={12} /> Stop
                        </button>
                        <button
                          className="ow-primary"
                          disabled={!!busy || worker.state !== 'running' || !followup.trim()}
                        >
                          Send to worker
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}
              {tab !== 'session' && (
                <div className="ow-worktree-view">
                  <div className="ow-branch">
                    <GitBranch size={14} />
                    <span>{snapshot?.branch || 'Worktree'}</span>
                    <button
                      className="ow-icon"
                      aria-label="Reload workspace"
                      disabled={inspecting}
                      onClick={() => void inspect()}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                  {inspecting && (
                    <p className="ow-loading" role="status">
                      Loading workspace…
                    </p>
                  )}
                  {inspectError && (
                    <div className="ow-error" role="alert">
                      {inspectError}
                    </div>
                  )}
                  {snapshot?.notice && <p className="ow-warning">{snapshot.notice}</p>}
                  {tab === 'files' && (
                    <>
                      <label className="ow-file-search">
                        <Search size={14} />
                        <input
                          aria-label="Find a file"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                          placeholder="Find a file…"
                        />
                      </label>
                      <div className="ow-file-browser">
                        <nav aria-label="Worktree files">
                          {snapshot?.files
                            .filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()))
                            .map((f) => (
                              <button
                                className={file?.path === f.path ? 'is-selected' : ''}
                                key={f.path}
                                onClick={() => void readFile(f.path)}
                                title={f.path}
                              >
                                <FileCode2 size={13} />
                                <span>{f.path}</span>
                                <small>{f.status.trim()}</small>
                              </button>
                            ))}
                        </nav>
                        {file ? (
                          <div className="ow-file-content">
                            <div>{file.path}</div>
                            <pre>
                              {file.content.split('\n').map((line, i) => (
                                <span key={i}>
                                  <i>{i + 1}</i>
                                  {line || ' '}
                                  {'\n'}
                                </span>
                              ))}
                            </pre>
                          </div>
                        ) : (
                          <div className="ow-file-placeholder">
                            Select a file to read its contents.
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {tab === 'changes' && (
                    <>
                      <div className="ow-change-summary">
                        <strong>{changed.length} changed files</strong>
                        <span>Compared with the worker’s starting commit</span>
                      </div>
                      <div className="ow-changed-list">
                        {changed.map((f) => (
                          <div key={f.path}>
                            <span>{f.status.trim()}</span>
                            {f.path}
                          </div>
                        ))}
                      </div>
                      {snapshot && (
                        <pre className="ow-diff" aria-label="Worktree diff">
                          {snapshot.diff
                            ? snapshot.diff.split('\n').map((line, i) => (
                                <span
                                  key={i}
                                  className={
                                    line.startsWith('+')
                                      ? 'addition'
                                      : line.startsWith('-')
                                        ? 'deletion'
                                        : line.startsWith('@@')
                                          ? 'hunk'
                                          : ''
                                  }
                                >
                                  {line || ' '}
                                  {'\n'}
                                </span>
                              ))
                            : 'No changes from the starting commit.'}
                        </pre>
                      )}
                    </>
                  )}
                  {tab === 'review' && (
                    <div className="ow-review">
                      <span className="ow-section-label">REVIEW THIS WORKTREE</span>
                      <h2>Evidence before approval.</h2>
                      <p>
                        Inspect the changes and test output. Approval records your decision for this
                        exact snapshot; it does not merge or deploy.
                      </p>
                      <button
                        disabled={!!busy || !worker.receipt?.output}
                        onClick={() => void act('review', { id: run!.id, workerId: worker.id })}
                      >
                        <Bot size={14} /> Ask coordinator to review
                      </button>
                      {worker.assessment && (
                        <div className="ow-review-note">
                          <strong>Coordinator assessment</strong>
                          <p>{worker.assessment}</p>
                        </div>
                      )}
                      {worker.review && (
                        <div className={`ow-verdict ${stale ? 'stale' : ''}`}>
                          <strong>
                            {stale
                              ? 'Changes need another review'
                              : worker.review.decision === 'approved'
                                ? 'Snapshot approved · not merged'
                                : 'Changes requested'}
                          </strong>
                          <p>{worker.review.comment}</p>
                        </div>
                      )}
                      <label>
                        Review notes
                        <textarea
                          rows={4}
                          aria-label="Review notes"
                          maxLength={8000}
                          value={feedback}
                          onChange={(e) => setFeedback(e.target.value)}
                          placeholder="What passed? What should change?"
                        />
                      </label>
                      <div className="ow-review-actions">
                        <button
                          disabled={!!busy || !snapshot || !feedback.trim()}
                          onClick={() =>
                            void act('decision', {
                              id: run!.id,
                              workerId: worker.id,
                              decision: 'changes_requested',
                              snapshot: snapshot!.snapshot,
                              text: feedback,
                            })
                          }
                        >
                          Request changes
                        </button>
                        <button
                          className="ow-primary"
                          disabled={!!busy || !snapshot || snapshot.truncated}
                          onClick={() =>
                            void act('decision', {
                              id: run!.id,
                              workerId: worker.id,
                              decision: 'approved',
                              snapshot: snapshot!.snapshot,
                              text: feedback || undefined,
                            })
                          }
                        >
                          <Check size={14} /> Approve changes
                        </button>
                      </div>
                      <small>
                        Requesting changes records feedback here. Use the Session tab to send it to
                        the worker.
                      </small>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
