/** Project workflow is separate from the core's running/completed lifecycle. */
export const BOARD_STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'] as const;
export type BoardStatus = typeof BOARD_STATUSES[number];
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export interface TaskBoard {
  status: BoardStatus;
  assignee: string;
  priority: typeof PRIORITIES[number];
  dueDate: string;
  acceptanceCriteria: string;
}
function metadata(raw?: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function readTaskBoard(task: { metadata_json?: string; status: string }): TaskBoard {
  const value = metadata(task.metadata_json).project_board;
  const b = value && typeof value === 'object' ? value as Partial<TaskBoard> : {};
  // External agents may complete/reopen tasks using the original API.
  const status = task.status === 'completed' ? 'done'
    : BOARD_STATUSES.includes(b.status!) && b.status !== 'done' ? b.status! : 'in_progress';
  return { status, assignee: typeof b.assignee === 'string' ? b.assignee : '',
    priority: PRIORITIES.includes(b.priority!) ? b.priority! : 'none',
    dueDate: typeof b.dueDate === 'string' ? b.dueDate : '',
    acceptanceCriteria: typeof b.acceptanceCriteria === 'string' ? b.acceptanceCriteria : '' };
}
export function writeTaskBoard(raw: string | undefined, patch: Partial<TaskBoard>): string {
  const meta = metadata(raw);
  const old = meta.project_board;
  meta.project_board = { ...(old && typeof old === 'object' ? old : {}), ...patch };
  return JSON.stringify(meta);
}
