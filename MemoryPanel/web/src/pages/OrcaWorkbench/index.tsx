import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Plus,
  RefreshCw,
  PanelsTopLeft,
} from 'lucide-react';
import { useTeams } from '@/services';
import { PageHeading } from '@/components/baren';
import {
  request,
  requestedTask,
  boardTaskUrl,
  executionLabel,
  workerSettled,
  type WorkerReceipt,
  type Options,
} from './api';
import './workbench.css';
import { TaskExecution } from './TaskExecution';
import { TaskPicker } from './TaskPicker';
import { WorkerQuestions } from './WorkerQuestions';
import { CdesktopWorkbench } from './CdesktopWorkbench';
import {
  RuntimePicker,
  requestedRuntime,
  updateWorkbenchQuery,
  type WorkbenchRuntime,
} from './RuntimePicker';

// Keep the coordinator available in source while the simpler board-to-Orca flow is trialled.
const SHOW_COORDINATOR = false;

type Worker = {
  receipt?: WorkerReceipt;
  id: string;
  title: string;
  agent: string;
  spec: string;
  state: string;
};
type Run = {
  taskId?: string;
  contextReferences?: { kind: 'wiki_page'; wikiId: string; ref: string }[];
  pendingActions?: { id: string; type: 'send'; workerId: string; text: string; status?: string }[];
  projectProposal?: { action: 'create' | 'select'; name?: string; binding?: string };
  id: string;
  binding: string;
  objective: string;
  context: string;
  summary: string;
  workers: Worker[];
  messages?: { id: string; role: string; text: string }[];
};
export function OrcaWorkbench() {
  const { activeTeamId } = useTeams();
  return activeTeamId ? (
    <Workspace key={activeTeamId} team={activeTeamId} />
  ) : (
    <div className="orca-connection-empty workbench-team-empty">
      <PanelsTopLeft size={28} aria-hidden="true" />
      <h2>Your connected workspace</h2>
      <p>Select a team to open Workbench.</p>
    </div>
  );
}
export function Workspace({ team }: { team: string }) {
  const [runtime, setRuntime] = useState(requestedRuntime);
  const [visited, setVisited] = useState<Record<WorkbenchRuntime, boolean>>(() => ({
    orca: requestedRuntime() === 'orca',
    cdesktop: requestedRuntime() === 'cdesktop',
  }));
  useEffect(() => {
    const changed = () => {
      const next = requestedRuntime();
      setRuntime(next);
      setVisited((current) => ({ ...current, [next]: true }));
    };
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    window.addEventListener('workbench-query-change', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
      window.removeEventListener('workbench-query-change', changed);
    };
  }, []);
  return (
    <div className="runtime-workbench">
      <div className="workbench-runtime-toolbar">
        <PageHeading
          title="Workbench"
          description="Keep your task and its execution in view."
          actions={
            <RuntimePicker
              runtime={runtime}
              onChange={(next) => updateWorkbenchQuery({ runtime: next })}
            />
          }
        />
      </div>
      {visited.orca && (
        <div className="workbench-runtime-pane" hidden={runtime !== 'orca'}>
          <OrcaWorkspace team={team} visible={runtime === 'orca'} />
        </div>
      )}
      {visited.cdesktop && (
        <div className="workbench-runtime-pane" hidden={runtime !== 'cdesktop'}>
          <CdesktopWorkbench team={team} />
        </div>
      )}
    </div>
  );
}

function OrcaWorkspace({ team, visible }: { team: string; visible: boolean }) {
  const [options, setOptions] = useState<Options>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState('');
  const [binding, setBinding] = useState('');
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState('');
  const [wikiId, setWikiId] = useState('');
  const [wikiRef, setWikiRef] = useState('');
  const [taskId, setTaskId] = useState(requestedTask);
  const [newProject, setNewProject] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [frameVersion, setFrameVersion] = useState(0);
  const [followups, setFollowups] = useState<Record<string, string>>({});
  const [lastSynced, setLastSynced] = useState('');
  const [executionVersion, setExecutionVersion] = useState(0);
  const [approvalNotice, setApprovalNotice] = useState('');
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
        const linked = requestedTask();
        setSelected(
          (linked ? r.items.find((item) => item.taskId === linked)?.id : r.items[0]?.id) || '',
        );
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [team]);
  useEffect(() => {
    const changed = () => {
      const linked = requestedTask();
      setTaskId(linked);
      setSelected((linked ? runs.find((item) => item.taskId === linked)?.id : undefined) || '');
    };
    window.addEventListener('hashchange', changed);
    window.addEventListener('workbench-query-change', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('workbench-query-change', changed);
    };
  }, [runs]);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [messages.length, selected, expanded, collapsed]);
  async function act(action: string, body: Record<string, unknown>) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    const signature = JSON.stringify([action, body]);
    const operation =
      typeof body.operation === 'string'
        ? body.operation
        : attempts.current.get(signature) || crypto.randomUUID();
    attempts.current.set(signature, operation);
    try {
      const next = await request<Run>(team, action, { ...body, operation });
      setRuns((prev) => [next, ...prev.filter((r) => r.id !== next.id)]);
      setSelected(next.id);
      if (action === 'project-apply') setOptions(await request<Options>(team, 'options'));
      const target = next.workers.find((worker) => worker.id === body.workerId);
      if (
        target?.receipt?.lastOperation?.id === operation &&
        target.receipt.lastOperation.status === 'unknown'
      ) {
        setError(
          'Submission outcome uncertain. Use Task execution settings to retry the saved operation or refresh evidence.',
        );
        return false;
      }
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
  const hasStartedWorkers = !!run?.workers.some((worker) => worker.state !== 'proposed');
  useEffect(() => {
    if (!visible || !selected || !hasStartedWorkers) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (document.hidden || lock.current) return;
      lock.current = true;
      setBusy(true);
      void request<Run>(team, 'refresh', { id: selected })
        .then((next) => {
          if (!active) return;
          setRuns((prev) => prev.map((item) => (item.id === next.id ? next : item)));
          setLastSynced(new Date().toLocaleTimeString());
        })
        .catch(() => {
          if (active) setLastSynced('Connection interrupted; retrying');
        })
        .finally(() => {
          lock.current = false;
          setBusy(false);
        });
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [team, selected, hasStartedWorkers, visible]);
  function chooseTask(id: string) {
    setTaskId(id);
    setSelected(runs.find((item) => item.taskId === id)?.id || '');
    const url = new URL(window.location.href);
    if (url.hash.startsWith('#/')) {
      const [route, query = ''] = url.hash.split('?');
      const params = new URLSearchParams(query);
      if (id) params.set('task', id);
      else params.delete('task');
      url.hash = route + (params.size ? '?' + params.toString() : '');
    } else {
      if (id) url.searchParams.set('task', id);
      else url.searchParams.delete('task');
    }
    window.history.replaceState(window.history.state, '', url);
  }
  async function approveWorker(worker: Worker) {
    if (!run?.taskId || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setApprovalNotice('');
    try {
      await request(team, 'execution-approve', {
        taskId: run.taskId,
        agent: worker.agent,
        spec: worker.spec,
        contextReferences: run.contextReferences,
      });
      setApprovalNotice(
        `Approved instructions for ${worker.title}. Launch when the task is eligible.`,
      );
      setExecutionVersion((value) => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not approve instructions.');
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
          : {
              binding,
              objective: draft,
              context,
              taskId: taskId || undefined,
              contextReferences:
                wikiId.trim() && wikiRef.trim()
                  ? [{ kind: 'wiki_page', wikiId: wikiId.trim(), ref: wikiRef.trim() }]
                  : undefined,
            },
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
      {SHOW_COORDINATOR && (
        <section
          className={`coordinator-band ${expanded ? 'expanded' : ''} ${collapsed ? 'collapsed' : ''}`}
          aria-label="Coordinator conversation"
        >
          <header className="coordinator-heading">
            <div className="coordinator-title">
              <Bot size={16} />
              <strong>Coordinator</strong>
              <span>Workbench</span>
              {(run?.taskId || taskId) && (
                <a href={boardTaskUrl(run?.taskId || taskId)}>Back to task</a>
              )}
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
              {approvalNotice && (
                <p className="coordinator-approval-notice" role="status">
                  {approvalNotice}
                </p>
              )}
              {contextOpen && (
                <div className="coordinator-context">
                  {run ? (
                    <p>{run.context || 'No additional context attached.'}</p>
                  ) : (
                    <>
                      <input
                        aria-label="Task Board task ID"
                        value={taskId}
                        onChange={(e) => setTaskId(e.target.value)}
                        placeholder="Task Board task ID (optional)"
                      />
                      <label>
                        Wiki asset ID
                        <input
                          value={wikiId}
                          onChange={(e) => setWikiId(e.target.value)}
                          placeholder="Optional authorized Wiki asset"
                        />
                      </label>
                      <label>
                        Wiki page reference
                        <input
                          value={wikiRef}
                          onChange={(e) => setWikiRef(e.target.value)}
                          placeholder="Exact page reference"
                        />
                      </label>
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
              {!run && (
                <TaskPicker team={team} taskId={taskId} disabled={busy} onSelect={chooseTask} />
              )}
              {(run?.taskId || taskId) && (
                <details className="coordinator-task-settings">
                  <summary>Task execution settings · {run?.taskId || taskId}</summary>
                  <TaskExecution
                    key={`${run?.taskId || taskId}:${executionVersion}`}
                    team={team}
                    poll={!hasStartedWorkers}
                    taskId={run?.taskId || taskId}
                    onBinding={(next) => {
                      if (!run) setBinding(next);
                    }}
                  />
                </details>
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
                        {run.projectProposal.action === 'create' ? 'Create project' : 'Use project'}
                        :{' '}
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
                          disabled={busy || !run.taskId}
                          onClick={() => void approveWorker(w)}
                        >
                          Approve these instructions
                        </button>
                        <button
                          disabled={busy || !run.taskId}
                          title={
                            !run.taskId
                              ? 'Attach a Task Board task and approve execution first'
                              : undefined
                          }
                          onClick={() => void act('dispatch', { id: run.id, workerId: w.id })}
                        >
                          Launch approved task
                        </button>
                      </div>
                    ))}
                  {!!run?.workers.some((w) => w.state !== 'proposed') && (
                    <div className="coordinator-receipts">
                      {run.workers
                        .filter((w) => w.state !== 'proposed')
                        .map((w) => (
                          <div key={w.id}>
                            <strong>{w.title}</strong> · {w.agent} ·{' '}
                            {executionLabel(w.receipt?.lifecycle || w.state)}
                            <WorkerQuestions
                              receipt={w.receipt}
                              busy={busy || w.receipt?.lastOperation?.status === 'unknown'}
                              onReply={(replyTo, text) =>
                                act('send', { id: run.id, workerId: w.id, text, replyTo })
                              }
                            />
                            {w.receipt?.notice && <p role="status">{w.receipt.notice}</p>}
                            {w.receipt?.native && (
                              <small className="worker-identifiers">
                                Run: {w.receipt.native.runId || '—'} · Task:{' '}
                                {w.receipt.native.taskId || '—'} · Dispatch:{' '}
                                {w.receipt.native.dispatchId || '—'}
                              </small>
                            )}
                            {w.receipt?.worktree && (
                              <small style={{ display: 'block' }}>
                                Worktree: {w.receipt.worktree.split('/').pop()}
                              </small>
                            )}
                            <form
                              className="worker-followup"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const text = followups[w.id]?.trim();
                                if (text)
                                  void act('send', { id: run.id, workerId: w.id, text }).then(
                                    (ok) => {
                                      if (ok) setFollowups((prev) => ({ ...prev, [w.id]: '' }));
                                    },
                                  );
                              }}
                            >
                              <label htmlFor={`followup-${w.id}`}>Message {w.title}</label>
                              <textarea
                                id={`followup-${w.id}`}
                                disabled={w.receipt?.lastOperation?.status === 'unknown'}
                                value={followups[w.id] || ''}
                                maxLength={8000}
                                onChange={(e) =>
                                  setFollowups((prev) => ({ ...prev, [w.id]: e.target.value }))
                                }
                                placeholder="Send instructions to this existing worker…"
                              />
                              <button
                                disabled={
                                  busy ||
                                  workerSettled(w.receipt, w.state) ||
                                  !followups[w.id]?.trim()
                                }
                              >
                                Send to worker
                              </button>
                              <small>
                                Submission does not confirm the worker has acted on the message.
                              </small>
                            </form>
                            {w.receipt?.lastOperation?.status === 'unknown' && (
                              <small>
                                Submission outcome uncertain. Retry the saved operation in Task
                                execution settings.
                              </small>
                            )}
                            {workerSettled(w.receipt, w.state) && (
                              <small>
                                This attempt has ended. Use Task execution settings to approve a
                                revision.
                              </small>
                            )}
                            {w.receipt?.output && (
                              <details>
                                <summary>Worker output / startup prompts</summary>
                                <pre
                                  style={{
                                    whiteSpace: 'pre-wrap',
                                    maxHeight: 200,
                                    overflow: 'auto',
                                  }}
                                >
                                  {w.receipt.output}
                                </pre>
                              </details>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                  {run?.pendingActions?.map((action) => {
                    const target = run.workers.find((worker) => worker.id === action.workerId);
                    const proposed = !action.status || action.status === 'proposed';
                    return (
                      <div className="coordinator-proposal" key={action.id}>
                        <div>
                          <strong>
                            {proposed
                              ? 'Proposed message'
                              : action.status === 'submitted'
                                ? 'Message submitted'
                                : 'Submission outcome uncertain'}{' '}
                            to {target?.title || action.workerId}
                          </strong>
                          <p>{action.text}</p>
                          {!proposed && (
                            <small>
                              {action.status === 'submitted'
                                ? 'Submission does not confirm the worker has acted.'
                                : 'Refresh worker evidence before sending this instruction again.'}
                            </small>
                          )}
                        </div>
                        {proposed && (
                          <button
                            disabled={
                              busy ||
                              !target ||
                              target.receipt?.lastOperation?.status === 'unknown' ||
                              workerSettled(target.receipt, target.state)
                            }
                            onClick={() =>
                              void act('send', {
                                id: run.id,
                                actionId: action.id,
                                workerId: action.workerId,
                                text: action.text,
                              })
                            }
                          >
                            Send to worker
                          </button>
                        )}
                        {proposed && target && workerSettled(target.receipt, target.state) && (
                          <small>
                            This attempt has ended. Approve a revision in Task execution settings.
                          </small>
                        )}
                      </div>
                    );
                  })}
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
      )}
      <section className="native-orca" aria-label="Orca workspace">
        <header className="native-orca-toolbar">
          <strong>Orca</strong>
          {(run?.taskId || taskId) && (
            <a href={boardTaskUrl(run?.taskId || taskId)}>Back to task</a>
          )}
          <div />
          {SHOW_COORDINATOR && lastSynced && <span aria-live="polite">{lastSynced}</span>}
          {SHOW_COORDINATOR && run && (
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
            <PanelsTopLeft size={28} aria-hidden="true" />
            <strong>Connect the Orca interface</strong>
            <p>Configure this runtime’s browser-client URL to load Orca’s own workspace here.</p>
            <p>Pair directly inside Orca when prompted.</p>
          </div>
        )}
      </section>
    </div>
  );
}
