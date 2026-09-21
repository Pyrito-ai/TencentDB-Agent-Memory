import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, ChevronDown, ChevronUp, ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { useTeams } from '@/services';
import { getPanelSession } from '@/lib/panelSession';
import './workbench.css';

type Worker = {
  receipt?: { output?: string; notice?: string; worktree?: string; terminal?: string };
  id: string;
  title: string;
  agent: string;
  spec: string;
  state: string;
};
type Run = {
  projectProposal?: { action: 'create' | 'select'; name?: string; binding?: string };
  id: string;
  binding: string;
  objective: string;
  context: string;
  summary: string;
  workers: Worker[];
  messages?: { id: string; role: string; text: string }[];
};
type Binding = { id: string; label: string; webUrl?: string };
type Options = {
  projectRuntimes?: { id: string; label: string }[];
  bindings: Binding[];
  coordinatorReady: boolean;
};
async function request<T>(team: string, action: string, body?: unknown): Promise<T> {
  const s = getPanelSession();
  if (!s) throw Error('Please sign in.');
  const response = await fetch(`/api/v1/workbench/${encodeURIComponent(team)}/${action}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': s.instanceId,
      'X-Tdai-User-Key': s.userKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Workbench request failed.');
  return data;
}
export function OrcaWorkbench() {
  const { activeTeamId } = useTeams();
  return activeTeamId ? (
    <Workspace key={activeTeamId} team={activeTeamId} />
  ) : (
    <p>Select a team to open Workbench.</p>
  );
}
export function Workspace({ team }: { team: string }) {
  const [options, setOptions] = useState<Options>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState('');
  const [binding, setBinding] = useState('');
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState('');
  const [taskId, setTaskId] = useState('');
  const [newProject, setNewProject] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [frameVersion, setFrameVersion] = useState(0);
  const lock = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const history = useRef<HTMLDivElement>(null);
  const run = runs.find((r) => r.id === selected);
  const connection = options?.bindings.find((b) => b.id === (run?.binding || binding));
  const messages =
    run?.messages ||
    (run
      ? [
          { id: 'objective', role: 'user', text: run.objective },
          { id: 'summary', role: 'assistant', text: run.summary },
        ]
      : []);
  useEffect(() => {
    let active = true;
    Promise.all([request<Options>(team, 'options'), request<{ items: Run[] }>(team, 'runs')])
      .then(([o, r]) => {
        if (!active) return;
        setOptions(o);
        setRuns(r.items);
        setBinding(o.bindings[0]?.id || '');
        setSelected(r.items[0]?.id || '');
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [team]);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [messages.length, selected, expanded, collapsed]);
  async function act(action: string, body: Record<string, unknown>) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    const signature = JSON.stringify([action, body]);
    const operation = attempts.current.get(signature) || crypto.randomUUID();
    attempts.current.set(signature, operation);
    try {
      const next = await request<Run>(team, action, { ...body, operation });
      setRuns((prev) => [next, ...prev.filter((r) => r.id !== next.id)]);
      setSelected(next.id);
      if (action === 'project-apply') setOptions(await request<Options>(team, 'options'));
      attempts.current.delete(signature);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function createProject() {
    const runtime = options?.projectRuntimes?.[0]?.id;
    if (!runtime || !newProject.trim() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const project = await request<{ binding: string; name: string }>(team, 'project-create', {
        runtime,
        name: newProject.trim(),
      });
      const o = await request<Options>(team, 'options');
      setOptions(o);
      setBinding(project.binding);
      setSelected('');
      setCreatingProject(false);
      setNewProject('');
      setDraft((prev) => prev || `Help me plan work in ${project.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Project creation failed.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (!draft.trim() || !connection || !options?.coordinatorReady) return;
    if (
      await act(
        run ? 'message' : 'start',
        run
          ? { id: run.id, text: draft }
          : { binding, objective: draft, context, taskId: taskId || undefined },
      )
    )
      setDraft('');
  }
  // The server supplies a credential-free URL; never forward Tencent credentials to Orca.
  const webUrl = connection?.webUrl;
  const frameUrl =
    webUrl &&
    (() => {
      try {
        const u = new URL(webUrl);
        return u.origin !== window.location.origin &&
          !u.username &&
          !u.password &&
          !u.hash &&
          !u.search &&
          (u.protocol === 'https:' ||
            (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
          ? u.href
          : undefined;
      } catch {
        return undefined;
      }
    })();
  return (
    <div className="native-workbench">
      <section
        className={`coordinator-band ${expanded ? 'expanded' : ''} ${collapsed ? 'collapsed' : ''}`}
        aria-label="Coordinator conversation"
      >
        <header className="coordinator-heading">
          <div className="coordinator-title">
            <Bot size={16} />
            <strong>Coordinator</strong>
            <span>Workbench</span>
          </div>
          <div className="coordinator-controls">
            <select
              aria-label="Conversation"
              value={selected}
              disabled={busy}
              onChange={(e) => {
                setSelected(e.target.value);
                setDraft('');
                setError('');
              }}
            >
              <option value="">New conversation</option>
              {runs.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.objective}
                </option>
              ))}
            </select>
            <button
              title="New conversation"
              aria-label="New conversation"
              disabled={busy}
              onClick={() => {
                setSelected('');
                setDraft('');
                setError('');
                setCollapsed(false);
              }}
            >
              <Plus size={15} />
            </button>
            <button
              aria-expanded={contextOpen}
              onClick={() => {
                setContextOpen(!contextOpen);
                setCollapsed(false);
              }}
            >
              Context
            </button>
            <button
              aria-label={expanded ? 'Compact coordinator' : 'Expand coordinator'}
              onClick={() => {
                setExpanded(!expanded);
                setCollapsed(false);
              }}
            >
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            <button
              aria-label={collapsed ? 'Show coordinator' : 'Collapse coordinator'}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? 'Show' : 'Hide'}
            </button>
          </div>
        </header>
        {!collapsed && (
          <>
            {error && (
              <div className="coordinator-error" role="alert">
                {error}
              </div>
            )}
            {contextOpen && (
              <div className="coordinator-context">
                {run ? (
                  <p>{run.context || 'No additional context attached.'}</p>
                ) : (
                  <>
                    <input
                      aria-label="Tencent task ID"
                      value={taskId}
                      onChange={(e) => setTaskId(e.target.value)}
                      placeholder="Tencent task ID (optional)"
                    />
                    <textarea
                      aria-label="Project context"
                      value={context}
                      maxLength={20000}
                      onChange={(e) => setContext(e.target.value)}
                      placeholder="Memory, Wiki excerpts, and constraints"
                    />
                  </>
                )}
              </div>
            )}
            <div className="coordinator-projects">
              <span>Project</span>
              <select
                aria-label="Target Orca project"
                disabled={busy || !!run}
                value={run?.binding || binding}
                onChange={(e) => setBinding(e.target.value)}
              >
                <option value="">Choose an Orca project</option>
                {options?.bindings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              {!!options?.projectRuntimes?.length && (
                <button disabled={busy} onClick={() => setCreatingProject(!creatingProject)}>
                  New project
                </button>
              )}
              {run && <small>Start a new conversation to change projects.</small>}
              {creatingProject && (
                <>
                  <input
                    aria-label="New project name"
                    placeholder="New project name"
                    value={newProject}
                    maxLength={60}
                    onChange={(e) => setNewProject(e.target.value)}
                  />
                  <button
                    disabled={busy || newProject.trim().length < 2}
                    onClick={() => void createProject()}
                  >
                    Create in Orca
                  </button>
                </>
              )}
            </div>
            <div className="coordinator-body">
              <div
                className="coordinator-history"
                ref={history}
                role="log"
                aria-label="Coordinator messages"
              >
                {!messages.length && (
                  <div className="coordinator-welcome">
                    <strong>What should we work on?</strong>
                    <p>Plan here. Delegate to workers in the Orca workspace below.</p>
                  </div>
                )}
                {messages.map((m) => (
                  <div className={`coordinator-message ${m.role}`} key={m.id}>
                    <span>
                      {m.role === 'user'
                        ? 'You'
                        : m.role === 'assistant'
                          ? 'Coordinator'
                          : 'Activity'}
                    </span>
                    <p>{m.text}</p>
                  </div>
                ))}
                {run?.projectProposal && (
                  <div className="coordinator-proposal">
                    <span>
                      {run.projectProposal.action === 'create' ? 'Create project' : 'Use project'}:{' '}
                      {run.projectProposal.name ||
                        options?.bindings.find((b) => b.id === run.projectProposal?.binding)
                          ?.label ||
                        run.projectProposal.binding}
                    </span>
                    <button
                      disabled={busy}
                      onClick={() => void act('project-apply', { id: run.id })}
                    >
                      Confirm project
                    </button>
                  </div>
                )}
                {run?.workers
                  .filter((w) => w.state === 'proposed')
                  .map((w) => (
                    <div className="coordinator-proposal" key={w.id}>
                      <details>
                        <summary>
                          {w.title} <small>{w.agent}</small>
                        </summary>
                        <p>{w.spec}</p>
                      </details>
                      <button
                        disabled={busy}
                        onClick={() => void act('dispatch', { id: run.id, workerId: w.id })}
                      >
                        Approve & launch
                      </button>
                    </div>
                  ))}
                {!!run?.workers.some((w) => w.state !== 'proposed') && (
                  <div className="coordinator-receipts">
                    {run.workers
                      .filter((w) => w.state !== 'proposed')
                      .map((w) => (
                        <div key={w.id}>
                          <strong>{w.title}</strong> · {w.agent} · terminal {w.state}
                          {w.receipt?.worktree && (
                            <small style={{ display: 'block' }}>
                              Worktree: {w.receipt.worktree.split('/').pop()}
                            </small>
                          )}
                          {w.receipt?.output && (
                            <details>
                              <summary>Worker output / startup prompts</summary>
                              <pre
                                style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}
                              >
                                {w.receipt.output}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                  </div>
                )}
                {busy && (
                  <p className="coordinator-pending" role="status">
                    Working…
                  </p>
                )}
              </div>
              <form
                className="coordinator-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  aria-label="Message coordinator"
                  value={draft}
                  maxLength={8000}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Ask, plan, or delegate…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="coordinator-send">
                  <small>
                    {options && !options.coordinatorReady
                      ? 'Configure coordinator model to chat'
                      : 'Coordinator · API billing'}
                  </small>
                  <button
                    aria-label="Send message to coordinator"
                    disabled={
                      busy ||
                      !connection ||
                      !options?.coordinatorReady ||
                      draft.trim().length < (run ? 1 : 10)
                    }
                  >
                    <ArrowUp size={16} />
                  </button>
                </div>
              </form>
            </div>
          </>
        )}
      </section>
      <section className="native-orca" aria-label="Orca workspace">
        <header className="native-orca-toolbar">
          <strong>Orca</strong>
          <span>{connection?.label || 'No runtime selected'}</span>
          <div />
          {run && (
            <button
              disabled={busy}
              title="Refresh coordinator worker receipts"
              onClick={() => void act('refresh', { id: run.id })}
            >
              <RefreshCw size={13} /> Sync workers
            </button>
          )}
          {frameUrl && (
            <>
              <button
                aria-label="Reload Orca interface"
                onClick={() => setFrameVersion((v) => v + 1)}
              >
                <RefreshCw size={14} />
              </button>
              <a
                href={frameUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open Orca separately"
              >
                <ExternalLink size={14} />
              </a>
            </>
          )}
        </header>
        {frameUrl ? (
          <iframe
            key={`${connection?.id}:${frameVersion}`}
            title="Orca native web interface"
            src={frameUrl}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
          />
        ) : (
          <div className="orca-connection-empty">
            <strong>Connect the Orca interface</strong>
            <p>Configure this runtime’s browser-client URL to load Orca’s own workspace here.</p>
            <p>
              The coordinator and Orca must use the same runtime. Pair directly inside Orca when
              prompted.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
