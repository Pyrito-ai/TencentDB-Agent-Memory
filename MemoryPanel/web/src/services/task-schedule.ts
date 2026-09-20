import { readTaskBoard } from './task-board';
export type Schedulable = { task_id: string; title: string; status: string; metadata_json?: string };
// Calendar arithmetic uses UTC date-only values; the caller supplies the viewer's local today.
export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function addDays(day: string, days: number): string {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function calendarWindow(today: string, weekOffset = 0) {
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
  const start = addDays(today, -((weekday + 6) % 7) + weekOffset * 7);
  return { start, end: addDays(start, 41), days: Array.from({ length: 42 }, (_, i) => addDays(start, i)) };
}
export function taskSpan(task: Schedulable) {
  const b = readTaskBoard(task);
  const start = validDay(b.plannedStart) ? b.plannedStart : validDay(b.dueDate) ? b.dueDate : '';
  const end = validDay(b.dueDate) ? b.dueDate : start;
  // Malformed externally written ranges never turn into misleading calendar bars.
  return start && end >= start ? { start, end } : null;
}
export function todayBucket(task: Schedulable, today: string): 'overdue' | 'due' | 'planned' | 'progress' | null {
  const b = readTaskBoard(task); if (b.status === 'done') return null;
  if (validDay(b.dueDate) && b.dueDate < today) return 'overdue';
  if (b.dueDate === today) return 'due';
  const span = taskSpan(task);
  if (b.plannedStart && span && span.start <= today && span.end >= today) return 'planned';
  return b.status === 'in_progress' ? 'progress' : null;
}
export function weekSegments<T extends Schedulable>(tasks: T[], weekStart: string) {
  const weekEnd = addDays(weekStart, 6);
  const spans = tasks.filter(t => readTaskBoard(t).status !== 'done').map(task => ({ task, span: taskSpan(task) }))
    .filter((v): v is { task: T; span: { start: string; end: string } } => !!v.span && v.span.start <= weekEnd && v.span.end >= weekStart)
    .sort((a, b) => a.span.start.localeCompare(b.span.start) || a.span.end.localeCompare(b.span.end) || a.task.task_id.localeCompare(b.task.task_id));
  const lanes: number[] = [];
  return spans.map(({ task, span }) => {
    const start = Math.max(0, Math.round((Date.parse(span.start) - Date.parse(weekStart)) / 86400000));
    const end = Math.min(6, Math.round((Date.parse(span.end) - Date.parse(weekStart)) / 86400000));
    let lane = lanes.findIndex(last => last < start); if (lane < 0) lane = lanes.length;
    lanes[lane] = end; return { task, start, end, lane, continuesBefore: span.start < weekStart, continuesAfter: span.end > weekEnd };
  });
}
