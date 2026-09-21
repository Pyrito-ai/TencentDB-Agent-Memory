import { getPanelSession } from '@/lib/panelSession';

export type WorkerReceipt = {
  id?: string;
  state?: string;
  output?: string;
  notice?: string;
  lastOperation?: {
    id: string;
    action: 'send' | 'stop' | 'continue';
    status: 'accepted' | 'refused' | 'unknown';
  };
  worktree?: string;
  terminal?: string;
  native?: { runId?: string; taskId?: string; dispatchId?: string };
  lifecycle?: string;
  events?: {
    id: string;
    type: string;
    subject: string;
    body: string;
    questionState?: 'pending' | 'answered';
    runId?: string;
    taskId?: string;
    dispatchId?: string;
  }[];
};
export type Binding = { id: string; label: string; webUrl?: string };
export type Options = {
  projectRuntimes?: { id: string; label: string }[];
  bindings: Binding[];
  coordinatorReady: boolean;
};
export async function request<T>(team: string, action: string, body?: unknown): Promise<T> {
  const s = getPanelSession();
  if (!s) throw Error('Please sign in.');
  const response = await fetch(`/api/v1/workbench/${encodeURIComponent(team)}/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': s.instanceId,
      'X-Tdai-User-Key': s.userKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Workbench request failed.');
  return data;
}
/** Query works in both the hash-routed panel and the standalone local Workbench. */
export function requestedTask(): string {
  const hashQuery = window.location.hash.split('?')[1];
  return new URLSearchParams(hashQuery || window.location.search).get('task') || '';
}
export function boardTaskUrl(taskId: string): string {
  return `/#/?task=${encodeURIComponent(taskId)}`;
}
export function executionLabel(state: string): string {
  return (
    (
      {
        running: 'Worker running',
        launching: 'Starting worker',
        exited: 'Session ended — review required',
        working: 'Worker running',
        starting: 'Starting worker',
        needs_input: 'Needs input',
        review: 'Ready for review',
        stopped: 'Stopped',
        unknown: 'Status uncertain',
        blocked: 'Needs input',
        waiting: 'Waiting',
        completed: 'Worker finished — review required',
        failed: 'Execution failed',
        cancelled: 'Cancelled',
        proposed: 'Awaiting approval',
      } as Record<string, string>
    )[state] || state
  );
}

export function workerSettled(receipt?: WorkerReceipt, state?: string): boolean {
  return (
    ['review', 'failed', 'stopped'].includes(receipt?.lifecycle || '') ||
    (receipt?.state || state) === 'exited'
  );
}
