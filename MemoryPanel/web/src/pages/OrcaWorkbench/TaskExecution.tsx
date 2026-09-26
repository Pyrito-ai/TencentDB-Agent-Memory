import { useCallback, useEffect, useRef, useState } from 'react';
import { tasksApi } from '@/lib/teamApi';
import { invalidateBackendCache } from '@/stores/backend';
import { WorkerQuestions } from './WorkerQuestions';
import { request, executionLabel, workerSettled, type Options, type WorkerReceipt } from './api';

type Execution = {
  taskId: string;
  pendingContinuation?: { operation: string; spec: string };
  pendingMessage?: { operation: string; text: string; replyTo?: string };
  taskTitle?: string;
  taskDescription?: string;
  backgroundReady?: boolean;
  background?: boolean;
  acceptedSnapshot?: string;
  acceptanceCriteria?: string;
  backgroundReason?: string;
  projectId?: string;
  binding?: string;
  agent?: 'codex' | 'claude';
  loopOptIn?: boolean;
  spec?: string;
  approvedAt?: number;
  workerId?: string;
  receipt?: WorkerReceipt;
  projectionPending?: boolean;
  eligibility: { eligible: boolean; reasons: string[] };
  canApprove?: boolean;
  canBind?: boolean;
  canAccept?: boolean;
};
export function TaskExecution({
  team,
  taskId,
  initialSpec = '',
  onBinding,
  poll = true,
}: {
  team: string;
  taskId: string;
  initialSpec?: string;
  onBinding?: (binding: string) => void;
  poll?: boolean;
}) {
  const [execution, setExecution] = useState<Execution>();
  const [options, setOptions] = useState<Options>();
  const [binding, setBinding] = useState('');
  const [agent, setAgent] = useState<'codex' | 'claude'>('codex');
  const [spec, setSpec] = useState(initialSpec);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const [loopOptIn, setLoopOptIn] = useState(false);
  const [followup, setFollowup] = useState('');
  const [background, setBackground] = useState(false);
  const [revisionSpec, setRevisionSpec] = useState('');
  const [view, setView] = useState<{
    snapshot: string;
    diff: string;
    truncated: boolean;
    files: { path: string; status: string }[];
  }>();
  const lock = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const bindingCallback = useRef(onBinding);
  bindingCallback.current = onBinding;
  const load = useCallback(async () => {
    const next = await request<Execution>(team, 'execution-get', { taskId });
    setExecution(next);
    setBinding(next.binding || '');
    if (next.binding) bindingCallback.current?.(next.binding);
    return next;
  }, [team, taskId]);
  useEffect(() => {
    let active = true;
    Promise.all([
      request<Execution>(team, 'execution-get', { taskId }),
      request<Options>(team, 'options'),
    ])
      .then(([next, opts]) => {
        if (!active) return;
        setExecution(next);
        setOptions(opts);
        setBinding(next.binding || '');
        setAgent(next.agent || 'codex');
        setLoopOptIn(!!next.loopOptIn);
        setBackground(!!next.background);
        setSpec(
          (next.approvedAt ? next.spec : initialSpec) ||
            next.spec ||
            [next.taskTitle, next.taskDescription, next.acceptanceCriteria]
              .filter(Boolean)
              .join('\n\n'),
        );
        if (next.binding) bindingCallback.current?.(next.binding);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [team, taskId, initialSpec]);
  const workerId = execution?.workerId;
  const accepted = !!execution?.acceptedSnapshot;
  useEffect(() => {
    if (!workerId || accepted) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (document.hidden || lock.current) return;
      lock.current = true;
      setBusy(true);
      void request<Execution>(team, poll ? 'execution-sync' : 'execution-get', { taskId })
        .then((next) => {
          if (active) {
            setExecution(next);
            setSyncNotice('');
          }
        })
        .catch(() => {
          if (active) setSyncNotice('Evidence refresh unavailable — showing the last known state.');
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
  }, [team, taskId, workerId, accepted, poll]);
  async function act(action: string, body: Record<string, unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const key = JSON.stringify([action, body]);
    const operation =
      typeof body.operation === 'string'
        ? body.operation
        : attempts.current.get(key) || crypto.randomUUID();
    attempts.current.set(key, operation);
    try {
      await request(team, action, { ...body, operation });
      const next = await load();
      const uncertain =
        !!next.pendingContinuation ||
        !!next.pendingMessage ||
        (next.receipt?.lastOperation?.id === operation &&
          next.receipt.lastOperation.status === 'unknown');
      if (uncertain) {
        setError(
          'The outcome is uncertain. Retry only the saved operation below, or refresh evidence.',
        );
        return;
      }
      attempts.current.delete(key);
      invalidateBackendCache();
      if (action === 'execution-continue') {
        setRevisionSpec('');
        setView(undefined);
      }
      if (action === 'execution-send') {
        setFollowup('');
        setView(undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Execution request failed.');
      await load().catch(() => undefined);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function inspect() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setView(undefined);
    try {
      setView(await request(team, 'execution-inspect', { taskId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not inspect changes.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function ready() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const current = await tasksApi.boardState(taskId);
      await tasksApi.boardTransition(taskId, current.revision, 'ready');
      await load();
      invalidateBackendCache();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update task.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="task-execution" aria-label="Orca task execution">
      <div className="task-execution-heading">
        <strong>Orca execution</strong>
        <a href={`/#/workbench?task=${encodeURIComponent(taskId)}`}>Open in Workbench</a>
      </div>
      {error && <p role="alert">{error}</p>}
      {syncNotice && <p role="status">{syncNotice}</p>}
      {!execution ? (
        <p>Loading execution settings…</p>
      ) : (
        <>
          <p>
            {execution.acceptedSnapshot
              ? 'Changes accepted — task Done'
              : execution.receipt
                ? executionLabel(
                    execution.receipt.lifecycle || execution.receipt.state || 'unknown',
                  )
                : execution.approvedAt
                  ? 'Execution approved'
                  : 'Execution requires explicit approval. Moving a card to Ready does not authorize a worker.'}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setError('');
              void load().catch((e) => setError(e.message));
            }}
          >
            Refresh eligibility
          </button>
          {!execution.projectId && (
            <p>Assign this task to a project before configuring execution.</p>
          )}
          <label>
            Orca repository / runtime
            <select
              aria-label="Task execution repository"
              disabled={busy || !execution.canBind || !execution.projectId}
              value={binding}
              onChange={(e) => setBinding(e.target.value)}
            >
              <option value="">Choose a configured repository</option>
              {options?.bindings.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {execution.canBind && execution.projectId && (
            <button
              disabled={busy || !binding || binding === execution.binding}
              onClick={() =>
                void act('execution-bind', { projectId: execution.projectId, binding })
              }
            >
              Save project mapping
            </button>
          )}
          {execution.canApprove && !execution.workerId && (
            <details open={!execution.approvedAt}>
              <summary>Worker instructions and approval</summary>
              <label>
                Worker
                <select
                  value={agent}
                  disabled={busy}
                  onChange={(e) => setAgent(e.target.value as 'codex' | 'claude')}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
              <label>
                Instructions
                <textarea
                  value={spec}
                  disabled={busy}
                  maxLength={16000}
                  onChange={(e) => setSpec(e.target.value)}
                  placeholder="Objective, scope, acceptance criteria, and required checks"
                />
              </label>
              <label className="task-execution-checkbox">
                <input
                  type="checkbox"
                  checked={loopOptIn}
                  onChange={(e) => setLoopOptIn(e.target.checked)}
                  disabled={busy}
                />
                Allow execution of this occurrence if generated by a Loop
              </label>
              {execution.backgroundReady && (
                <label className="task-execution-checkbox">
                  <input
                    type="checkbox"
                    checked={background}
                    onChange={(e) => setBackground(e.target.checked)}
                    disabled={busy}
                  />
                  Allow automatic dispatch when eligible
                </label>
              )}
              <button
                disabled={busy || !execution.binding || spec.trim().length < 10}
                onClick={() =>
                  void act('execution-approve', { taskId, agent, spec, loopOptIn, background })
                }
              >
                Approve these instructions
              </button>
            </details>
          )}
          {!!execution.eligibility?.reasons.length && (
            <ul aria-label="Execution eligibility">
              {execution.eligibility.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {!execution.workerId &&
            execution.eligibility?.reasons.includes('Task must be Ready.') && (
              <button disabled={busy} onClick={() => void ready()}>
                Move task to Ready (does not launch)
              </button>
            )}
          {!execution.workerId && (
            <button
              disabled={busy || !execution.eligibility?.eligible}
              onClick={() => void act('execution-dispatch', { taskId })}
            >
              Execute eligible task in Orca
            </button>
          )}
          {execution.pendingContinuation && (
            <div className="worker-question">
              <strong>Revision outcome uncertain</strong>
              <p>{execution.pendingContinuation.spec}</p>
              <button
                disabled={busy}
                onClick={() =>
                  void act('execution-continue', {
                    taskId,
                    spec: execution.pendingContinuation!.spec,
                    operation: execution.pendingContinuation!.operation,
                  })
                }
              >
                Retry pending revision
              </button>
              <small>
                Reuses the saved operation and exact instructions. New revisions and acceptance are
                unavailable until resolved.
              </small>
            </div>
          )}
          {execution.pendingMessage && (
            <div className="worker-question">
              <strong>Message submission outcome uncertain</strong>
              <p>{execution.pendingMessage.text}</p>
              <button
                disabled={busy}
                onClick={() =>
                  void act('execution-send', {
                    taskId,
                    text: execution.pendingMessage!.text,
                    replyTo: execution.pendingMessage!.replyTo,
                    operation: execution.pendingMessage!.operation,
                  })
                }
              >
                Retry pending message
              </button>
              <small>
                Reuses the same message and operation; submission does not confirm worker action.
              </small>
            </div>
          )}
          {execution.workerId && (
            <>
              <WorkerQuestions
                receipt={execution.receipt}
                busy={busy || !!execution.pendingContinuation || !!execution.pendingMessage}
                onReply={(replyTo, text) => act('execution-send', { taskId, text, replyTo })}
              />
              <small>Worker: {execution.workerId}</small>
              {!execution.acceptedSnapshot && (
                <button disabled={busy} onClick={() => void act('execution-stop', { taskId })}>
                  Stop this worker
                </button>
              )}
              {['failed', 'stopped'].includes(execution.receipt?.lifecycle || '') && (
                <button disabled={busy} onClick={() => void act('execution-reset', { taskId })}>
                  Reset attempt for new approval
                </button>
              )}
              <form
                className="worker-followup"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (followup.trim())
                    void act('execution-send', { taskId, text: followup.trim() });
                }}
              >
                <label>
                  Message this worker
                  <textarea
                    disabled={!!execution.pendingContinuation || !!execution.pendingMessage}
                    value={followup}
                    maxLength={8000}
                    onChange={(e) => setFollowup(e.target.value)}
                    placeholder="Send instructions to the existing worker…"
                  />
                </label>
                <button
                  disabled={
                    busy ||
                    !!execution.acceptedSnapshot ||
                    workerSettled(execution.receipt) ||
                    !!execution.pendingContinuation ||
                    !!execution.pendingMessage ||
                    !followup.trim()
                  }
                >
                  Send to worker
                </button>
                <small>Submission does not confirm the worker has acted on the message.</small>
              </form>
              {execution.receipt?.lifecycle === 'review' &&
                !execution.acceptedSnapshot &&
                !execution.pendingContinuation &&
                !execution.pendingMessage && (
                  <form
                    className="worker-question"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (revisionSpec.trim().length >= 10)
                        void act('execution-continue', { taskId, spec: revisionSpec.trim() });
                    }}
                  >
                    <strong>Request a revision</strong>
                    <label>
                      Approved revision instructions
                      <textarea
                        value={revisionSpec}
                        maxLength={8000}
                        onChange={(e) => setRevisionSpec(e.target.value)}
                        placeholder="Describe the exact changes and acceptance criteria for the next attempt."
                      />
                    </label>
                    <button disabled={busy || revisionSpec.trim().length < 10}>
                      Approve and run revision
                    </button>
                    <small>
                      Starts a new native task in the same worktree and preserves prior execution
                      evidence.
                    </small>
                  </form>
                )}
              {workerSettled(execution.receipt) && (
                <small>This attempt has ended. A general message will not restart it.</small>
              )}
              <button disabled={busy} onClick={() => void inspect()}>
                Inspect current changes
              </button>
              {view && (
                <div>
                  <details open>
                    <summary>Current diff · {view.files.length} files</summary>
                    <pre>{view.diff || 'No changes in this snapshot.'}</pre>
                  </details>
                  {view.truncated && <p>Diff is incomplete; acceptance is unavailable.</p>}
                  <button
                    disabled={
                      busy ||
                      !!execution.acceptedSnapshot ||
                      !!execution.pendingContinuation ||
                      !!execution.pendingMessage ||
                      !execution.canAccept ||
                      view.truncated
                    }
                    onClick={() =>
                      void act('execution-accept', { taskId, snapshot: view.snapshot })
                    }
                  >
                    Accept reviewed changes and mark Done
                  </button>
                  <small>Acceptance does not merge or deploy changes.</small>
                </div>
              )}
              {execution.receipt?.native && (
                <small>
                  Run: {execution.receipt.native.runId || '—'} · Task:{' '}
                  {execution.receipt.native.taskId || '—'} · Dispatch:{' '}
                  {execution.receipt.native.dispatchId || '—'}
                </small>
              )}
              <button disabled={busy} onClick={() => void act('execution-sync', { taskId })}>
                Refresh execution evidence
              </button>
            </>
          )}
          {execution.projectionPending && (
            <p role="status">Execution evidence is saved; the board update is pending.</p>
          )}
          {execution.receipt?.notice && <p role="status">{execution.receipt.notice}</p>}
          {execution.receipt?.output && (
            <details>
              <summary>Worker output and evidence</summary>
              <pre>{execution.receipt.output}</pre>
            </details>
          )}
          {execution.backgroundReason && <small>{execution.backgroundReason}</small>}
          <small>Worker completion requires human review before the task is accepted.</small>
        </>
      )}
    </section>
  );
}
