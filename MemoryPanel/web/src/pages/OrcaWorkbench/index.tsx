import { useEffect, useState } from 'react';
import { useTeams } from '@/services';
import { getPanelSession } from '@/lib/panelSession';
import './workbench.css';
type Worker = {
  id: string;
  title: string;
  agent: 'codex' | 'claude';
  spec: string;
  state: string;
  receipt?: { output?: string; notice?: string; worktree?: string };
};
type Run = {
  id: string;
  objective: string;
  summary: string;
  created: number;
  workers: Worker[];
  review?: string;
};
type Options = { bindings: { id: string; label: string }[]; coordinatorReady: boolean };
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
  // Remount on team change so in-flight responses can never show another team's runs.
  return activeTeamId ? (
    <Workspace key={activeTeamId} team={activeTeamId} />
  ) : (
    <div className="orca-workbench">
      <h1>Workbench</h1>
      <p>Select a team to coordinate workers.</p>
    </div>
  );
}
export function Workspace({ team }: { team: string }) {
  const [options, setOptions] = useState<Options>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [binding, setBinding] = useState('');
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [taskId, setTaskId] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
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
      });
    return () => {
      active = false;
    };
  }, [team]);
  const run = runs.find((r) => r.id === selected);
  async function act(action: string, body: unknown) {
    setBusy(action);
    setError('');
    try {
      const next = await request<Run>(team, action, body);
      setRuns((old) => [next, ...old.filter((r) => r.id !== next.id)]);
      setSelected(next.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="orca-workbench">
      <header>
        <div>
          <div className="wb-eyebrow">TENCENT MEMORY × ORCA</div>
          <h1>Workbench</h1>
          <p>Give the coordinator an outcome. Put your subscription workers to work.</p>
        </div>
        <span className="wb-pill">Review before dispatch</span>
      </header>
      {error && (
        <div role="alert" className="wb-error">
          {error}
        </div>
      )}
      <div className="wb-grid">
        <aside>
          <section className="wb-card">
            <h2>New run</h2>
            <p className="wb-muted">
              Planning uses the coordinator API. Workers use their own accounts in Orca.
            </p>
            {!options ? (
              <p role="status">Loading connections…</p>
            ) : !options.bindings.length ? (
              <div className="wb-empty">
                <strong>Connect an Orca runtime</strong>
                <p>
                  No runtime is assigned to your user and team. Your administrator can connect a
                  dedicated runtime and repository using the Workbench setup guide.
                </p>
              </div>
            ) : (
              <>
                <label>
                  Runtime and repository
                  <select value={binding} onChange={(e) => setBinding(e.target.value)}>
                    {options.bindings.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
                {!options.coordinatorReady && (
                  <p className="wb-error">The coordinator model is not configured yet.</p>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('plan', { binding, objective, context, taskId: taskId || undefined });
                  }}
                >
                  <label>
                    Outcome
                    <textarea
                      required
                      minLength={10}
                      maxLength={8000}
                      rows={4}
                      value={objective}
                      onChange={(e) => setObjective(e.target.value)}
                      placeholder="What should be different when the work is done?"
                    />
                  </label>
                  <details>
                    <summary>Project context</summary>
                    <label>
                      Tencent task ID (optional)
                      <input
                        value={taskId}
                        maxLength={200}
                        onChange={(e) => setTaskId(e.target.value)}
                      />
                    </label>
                    <label>
                      Decisions, knowledge, and acceptance criteria
                      <textarea
                        rows={5}
                        maxLength={20000}
                        value={context}
                        onChange={(e) => setContext(e.target.value)}
                        placeholder="Include relevant Wiki or memory excerpts for this run."
                      />
                    </label>
                  </details>
                  <button
                    className="wb-primary"
                    disabled={!!busy || !options.coordinatorReady || !binding}
                  >
                    {busy === 'plan' ? 'Preparing plan…' : 'Prepare a plan'}
                  </button>
                </form>
              </>
            )}
          </section>
          <nav className="wb-history" aria-label="Run history">
            <h2>Recent runs</h2>
            {runs.length === 0 ? (
              <p className="wb-muted">Your plans and worker receipts will appear here.</p>
            ) : (
              runs.map((r) => (
                <button
                  key={r.id}
                  aria-pressed={r.id === selected}
                  onClick={() => setSelected(r.id)}
                >
                  {r.objective}
                  <small>{new Date(r.created).toLocaleString()}</small>
                </button>
              ))
            )}
          </nav>
        </aside>
        <main className="wb-main">
          {!run ? (
            <section className="wb-welcome">
              <span className="wb-eyebrow">PLAN → DISPATCH → REVIEW</span>
              <h2>One place to coordinate the work.</h2>
              <p>
                Tencent holds the context. Orca runs Codex and Claude Code in separate worktrees.
                You decide what gets dispatched and what is ready to merge.
              </p>
              <div className="wb-stages">
                <div>
                  <b>01</b>
                  <strong>Prepare</strong>
                  <p>Define the outcome and give the coordinator relevant context.</p>
                </div>
                <div>
                  <b>02</b>
                  <strong>Delegate</strong>
                  <p>Approve a worker task and launch it through Orca.</p>
                </div>
                <div>
                  <b>03</b>
                  <strong>Review</strong>
                  <p>Read the evidence. Inspect diffs and checks in Orca before merging.</p>
                </div>
              </div>
            </section>
          ) : (
            <>
              <section className="wb-card">
                <span className="wb-eyebrow">COORDINATOR PLAN</span>
                <h2>{run.objective}</h2>
                <p>{run.summary}</p>
                <div className="wb-actions">
                  <button disabled={!!busy} onClick={() => void act('refresh', { id: run.id })}>
                    {busy === 'refresh' ? 'Refreshing…' : 'Refresh workers'}
                  </button>
                  <button
                    disabled={!!busy || !run.workers.some((w) => w.receipt?.output)}
                    onClick={() => void act('review', { id: run.id })}
                  >
                    {busy === 'review' ? 'Reviewing…' : 'Review worker evidence'}
                  </button>
                </div>
              </section>
              {run.workers.map((w) => (
                <section className="wb-card wb-worker" key={w.id}>
                  <div className="wb-worker-heading">
                    <h3>{w.title}</h3>
                    <span className="wb-pill">
                      {w.agent === 'claude' ? 'Claude Code' : 'Codex'} · {w.state}
                    </span>
                  </div>
                  <p className="wb-spec">{w.spec}</p>
                  {w.state === 'proposed' ? (
                    <button
                      className="wb-primary"
                      disabled={!!busy}
                      onClick={() => void act('dispatch', { id: run.id, workerId: w.id })}
                    >
                      {busy === 'dispatch' ? 'Dispatching…' : 'Approve & launch worker'}
                    </button>
                  ) : (
                    <>
                      <p className="wb-muted">
                        {w.receipt?.notice ||
                          'Worker launched in Orca. Refresh to read its output.'}
                      </p>
                      {w.receipt?.worktree && <code>{w.receipt.worktree}</code>}
                    </>
                  )}
                  {w.receipt?.output && (
                    <details open>
                      <summary>Worker output</summary>
                      <pre>{w.receipt.output}</pre>
                    </details>
                  )}
                </section>
              ))}
              {run.review && (
                <section className="wb-card">
                  <span className="wb-eyebrow">COORDINATOR REVIEW · ADVISORY</span>
                  <p className="wb-spec">{run.review}</p>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
