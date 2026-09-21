import { expect, test } from 'vitest';
import { writeTaskBoard, type TaskBoard } from '../web/src/services/task-board';
import { addDays, calendarWindow, localDay, taskSpan, todayBucket, validDay, weekSegments } from '../web/src/services/task-schedule';
const task = (id: string, board: Partial<TaskBoard> = {}, status = 'running') => ({ task_id: id, title: id, status, metadata_json: writeTaskBoard('{}', board) });
test('six-week window includes both endpoints and crosses year and DST boundaries without drift', () => {
 const w = calendarWindow('2026-09-20'); expect(w.start).toBe('2026-09-14'); expect(w.end).toBe('2026-10-25'); expect(w.days).toHaveLength(42);
 expect(calendarWindow('2026-12-31').end).toBe('2027-02-07');
 expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
 expect(localDay(new Date(2026, 8, 20, 0, 1))).toBe('2026-09-20');
});
test('dates must be real calendar dates; legacy and invalid task ranges remain unscheduled', () => {
 expect(validDay('2026-02-30')).toBe(false); expect(validDay('2028-02-29')).toBe(true);
 expect(taskSpan(task('legacy'))).toBeNull();
 expect(taskSpan(task('backwards', { plannedStart: '2026-09-21', dueDate: '2026-09-20' }))).toBeNull();
 expect(taskSpan(task('due', { dueDate: '2026-09-20' }))).toEqual({ start: '2026-09-20', end: '2026-09-20' });
 expect(taskSpan(task('start', { plannedStart: '2026-09-20' }))).toEqual({ start: '2026-09-20', end: '2026-09-20' });
});
test('Today gives overdue and due dates precedence, includes planned spans, excludes completed work', () => {
 expect(todayBucket(task('late', { dueDate: '2026-09-19', status: 'in_progress' }), '2026-09-20')).toBe('overdue');
 expect(todayBucket(task('due', { dueDate: '2026-09-20' }), '2026-09-20')).toBe('due');
 expect(todayBucket(task('span', { plannedStart: '2026-09-18', dueDate: '2026-09-23', status: 'ready' }), '2026-09-20')).toBe('planned');
 expect(todayBucket(task('future', { plannedStart: '2026-09-21', status: 'ready' }), '2026-09-20')).toBeNull();
 expect(todayBucket(task('done', { dueDate: '2026-09-19' }, 'completed'), '2026-09-20')).toBeNull();
});
test('calendar clips multiweek spans, includes the final day, and excludes dates beyond it', () => {
 const rows = weekSegments([task('span', { plannedStart: '2026-09-01', dueDate: '2026-10-30' }), task('last', { dueDate: '2026-10-25' }), task('outside', { dueDate: '2026-10-26' }), task('done', { dueDate: '2026-10-25' }, 'completed')], '2026-10-19');
 expect(rows.map(r => r.task.task_id)).toEqual(['span', 'last']);
 expect(rows[0]).toMatchObject({ start: 0, end: 6, continuesBefore: true, continuesAfter: true });
 expect(rows[1]).toMatchObject({ start: 6, end: 6, lane: 1 });
});
test('overlapping inclusive spans receive different lanes; non-overlapping tasks reuse lanes', () => {
 const rows = weekSegments([task('a', { plannedStart: '2026-09-14', dueDate: '2026-09-16' }), task('b', { plannedStart: '2026-09-16', dueDate: '2026-09-17' }), task('c', { dueDate: '2026-09-18' })], '2026-09-14');
 expect(rows.map(r => r.lane)).toEqual([0, 1, 0]);
});
