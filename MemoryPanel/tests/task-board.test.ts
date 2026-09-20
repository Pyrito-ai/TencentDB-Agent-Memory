import { expect, test } from 'vitest';
import { readTaskBoard, writeTaskBoard } from '../web/src/services/task-board';
test('legacy tasks map to existing lifecycle without a migration', () => {
  expect(readTaskBoard({ status: 'running', metadata_json: 'bad' }).status).toBe('in_progress');
  expect(readTaskBoard({ status: 'completed' }).status).toBe('done');
});
test('external completion and reopening remain authoritative', () => {
  const metadata_json = writeTaskBoard('{}', { status: 'review', priority: 'high' });
  expect(readTaskBoard({ status: 'completed', metadata_json }).status).toBe('done');
  expect(readTaskBoard({ status: 'running', metadata_json: writeTaskBoard(metadata_json, { status: 'done' }) }).status).toBe('in_progress');
});
test('partial board edits preserve unrelated metadata and other board fields', () => {
  const first = writeTaskBoard('{"ui":{"participants":["a"]},"integration":{"id":42}}', { status: 'backlog', assignee: 'a' });
  const second = writeTaskBoard(first, { priority: 'urgent' });
  expect(JSON.parse(second).integration.id).toBe(42);
  expect(JSON.parse(second).ui.participants).toEqual(['a']);
  expect(readTaskBoard({ status: 'running', metadata_json: second })).toMatchObject({ status: 'backlog', assignee: 'a', priority: 'urgent' });
});
