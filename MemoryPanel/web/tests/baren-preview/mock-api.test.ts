import test from 'node:test';
import assert from 'node:assert/strict';
import { installMockApi } from './mock-api';
import { TEAM, USER, AGENT, LOOP_TIMEZONE, now, today, createData } from './data';
import { addDays } from '../../src/services/task-schedule';
import { localDay, periodFor } from '../../../src/panel/http/routes/loop-periods';

function setup(query = '') {
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, 'location', {
    value: new URL(`http://127.0.0.1:5191/${query}#/today`),
    configurable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => stored.get(key) || null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'history', {
    value: { replaceState() {} },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    value: class {
      open() {}
    },
    configurable: true,
  });
  installMockApi();
}
const call = (path: string, body?: object) =>
  fetch(path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);

test('loop history has real completion dates, coherent summaries and an owned open occurrence', () => {
  const data = createData('member', false);
  assert.equal(data.tasks.length, 7, 'Historical task details do not change the existing board');
  assert.equal(data.loopTasks.length, 26);
  const scheduled = data.loops.find((loop) => loop.mode === 'scheduled')!;
  const flexible = data.loops.find((loop) => loop.mode === 'flexible')!;
  assert.equal(scheduled.stats.total, 9);
  assert.equal(flexible.stats.total, 17);
  assert.equal(scheduled.stats.currentStreak, 1);
  assert.equal(scheduled.stats.bestStreak, 3);
  assert.equal(scheduled.overdue, 1);
  assert.equal(scheduled.nextDue, addDays(today, -21));
  assert.ok(!data.history.some((item) => item.due_day === scheduled.nextDue));
  assert.equal(scheduled.slots.filter((slot) => slot.state === 'skipped').length, 2);
  assert.equal(scheduled.slots.filter((slot) => slot.state === 'completed' && slot.late).length, 2);
  assert.equal(scheduled.slots.find((slot) => slot.day === today)?.state, 'due');
  const open = data.history.find((item) => item.loop_id === flexible.id && item.state === 'open')!;
  assert.equal(open.author, USER);
  assert.equal(open.completed_at, null);
  assert.equal(open.task_id, 'baren-task-3');
  for (const loop of data.loops) {
    const completed = data.history.filter(
      (item) => item.loop_id === loop.id && item.state === 'completed',
    );
    assert.equal(loop.stats.total, completed.length);
    assert.equal(loop.stats.currentPeriod, periodFor(now, LOOP_TIMEZONE, loop.frequency));
    assert.equal(
      loop.stats.progress,
      completed.filter((item) => item.period === loop.stats.currentPeriod).length,
    );
    for (const occurrence of completed) {
      assert.ok(occurrence.completed_at !== null && occurrence.completed_at < now);
      assert.ok(occurrence.created_at <= occurrence.completed_at!);
      const task = data.loopTasks.find((item) => item.task_id === occurrence.task_id)!;
      assert.ok(task, 'Every completion opens its own synthetic task');
      assert.equal(task.status, 'completed');
      assert.equal(JSON.parse(task.metadata_json).loop_occurrence, occurrence.id);
      if (loop.mode === 'flexible') {
        assert.equal(occurrence.due_day, '');
        assert.equal(
          occurrence.period,
          periodFor(occurrence.completed_at!, LOOP_TIMEZONE, loop.frequency),
        );
      }
    }
  }
  const actualCounts = [7, 30, 90].map((days) => {
    const start = addDays(today, 1 - days);
    return data.loops.map(
      (loop) =>
        data.history.filter((item) => {
          if (item.loop_id !== loop.id || item.state !== 'completed' || item.completed_at === null)
            return false;
          const completedDay = localDay(item.completed_at, LOOP_TIMEZONE);
          return completedDay >= start && completedDay <= today;
        }).length,
    );
  });
  assert.deepEqual(actualCounts, [
    [0, 2],
    [3, 9],
    [9, 17],
  ]);
});

test('human loop start creates one local task, replays safely and reports an occupied scheduled slot', async () => {
  setup();
  const endpoint = `/api/v1/loops/${TEAM}`;
  const before = await (await call(`${endpoint}/list`)).json();
  const loop = before.items.find((item: { mode: string }) => item.mode === 'scheduled');
  const taskCount = async () =>
    (await (await call('/api/v1/meta/task/list', {})).json()).data.total;
  const count = await taskCount();
  const body = {
    loopId: loop.id,
    requestId: 'preview-loop-start-request-1',
    agentId: '',
    dueDay: loop.nextDue,
  };
  const created = await call(`${endpoint}/start`, body);
  assert.equal(created.status, 201);
  const { occurrence } = await created.json();
  assert.equal(occurrence.id, body.requestId);
  assert.equal(occurrence.author, USER);
  assert.equal(occurrence.agent_id, '');
  assert.equal(occurrence.state, 'open');
  assert.equal(occurrence.completed_at, null);
  assert.equal(occurrence.due_day, loop.nextDue);
  const task = (await (await call('/api/v1/meta/task/get', { task_id: occurrence.task_id })).json())
    .data;
  assert.deepEqual(task.agents, []);
  const metadata = JSON.parse(task.metadata_json);
  assert.equal(metadata.loop_occurrence, occurrence.id);
  assert.equal(metadata.project_board.status, 'in_progress');
  assert.equal(metadata.project_board.assignee, loop.owner_id);
  assert.equal(metadata.project_board.dueDate, loop.nextDue);
  const projects = await (await call(`/api/v1/projects/${TEAM}/list`)).json();
  assert.ok(
    projects.assignments.some(
      (item: { task: string; project_id: string }) =>
        item.task === occurrence.task_id && item.project_id === loop.project_id,
    ),
  );
  const replay = await call(`${endpoint}/start`, body);
  assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).occurrence, occurrence);
  const occupied = await call(`${endpoint}/start`, {
    ...body,
    requestId: 'preview-loop-start-request-2',
  });
  assert.equal(occupied.status, 409);
  assert.equal((await occupied.json()).occurrenceId, occurrence.id);
  const reused = await call(`${endpoint}/start`, { ...body, loopId: 'baren-loop-2' });
  assert.equal(reused.status, 409);
  assert.equal(await taskCount(), count + 1);
  const after = await (await call(`${endpoint}/list`)).json();
  assert.equal(after.history.length, before.history.length + 1);
});

test('loop start denies agents and invalid deadlines without changing synthetic work', async () => {
  setup('?role=member');
  const endpoint = `/api/v1/loops/${TEAM}`;
  const before = await (await call(`${endpoint}/list`)).json();
  const body = {
    loopId: 'baren-loop-1',
    requestId: 'preview-loop-validation-1',
    agentId: '',
    dueDay: addDays(today, -21),
  };
  assert.equal((await call(`${endpoint}/start`)).status, 405);
  assert.equal((await call(`${endpoint}/start`, { ...body, requestId: 'short' })).status, 400);
  assert.equal(
    (await call(`${endpoint}/start`, { ...body, dueDay: addDays(today, -20) })).status,
    400,
  );
  assert.equal((await call(`${endpoint}/start`, { ...body, loopId: 'missing' })).status, 404);
  const agent = await call(`${endpoint}/start`, {
    ...body,
    loopId: 'baren-loop-2',
    agentId: AGENT,
  });
  assert.equal(agent.status, 501);
  assert.match((await agent.json()).error, /No agent was started/);
  assert.deepEqual((await (await call(`${endpoint}/list`)).json()).history, before.history);
  assert.equal((await call(`${endpoint}/list?through=not-a-day`)).status, 400);
  const through = addDays(today, 98);
  const calendar = await (await call(`${endpoint}/list?through=${through}`)).json();
  assert.equal(calendar.items[0].slots.at(-1).day, through);
});

test('member human starts use flexible periods and historical details stay outside the board', async () => {
  setup('?role=member');
  const endpoint = `/api/v1/loops/${TEAM}`;
  const initial = await (await call(`${endpoint}/list`)).json();
  const historical = initial.history.find((item: { state: string }) => item.state === 'completed');
  const detail = await (
    await call('/api/v1/meta/task/get', { task_id: historical.task_id })
  ).json();
  assert.equal(detail.data.task_id, historical.task_id);
  assert.equal(detail.data.status, 'completed');
  const before = await (await call('/api/v1/meta/task/list', {})).json();
  assert.equal(before.data.total, 7);
  assert.ok(
    !before.data.items.some((item: { task_id: string }) => item.task_id === historical.task_id),
  );
  const body = {
    loopId: 'baren-loop-2',
    requestId: 'preview-flexible-member-request',
    agentId: '',
    dueDay: 'ignored-for-flexible-work',
  };
  const response = await call(`${endpoint}/start`, body);
  assert.equal(response.status, 201);
  const { occurrence } = await response.json();
  assert.equal(occurrence.due_day, '');
  assert.equal(occurrence.period, periodFor(occurrence.created_at, LOOP_TIMEZONE, 'weekly'));
  assert.equal((await call(`${endpoint}/start`, body)).status, 200);
  assert.equal((await (await call('/api/v1/meta/task/list', {})).json()).data.total, 8);
});

test('preview API never falls through and refuses runtime launch mutations', async () => {
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error('Network fallthrough');
  };
  setup();
  for (const path of [
    'https://example.invalid/api/v1/task/create',
    '/api/v1/unknown-write',
    `/api/v1/workbench/${TEAM}/cdesktop-handoff-launch`,
  ]) {
    const response = await call(path, { taskId: 'baren-task-1' });
    assert.equal(response.status, 501);
  }
  assert.equal(networkCalls, 0);
  assert.throws(() => new XMLHttpRequest().open('POST', '/api/v1/anything'), /disabled/);
  assert.equal(navigator.sendBeacon('/api/v1/anything'), false);
});

test('fixture authenticates synthetic identity and exposes a complete task detail context', async () => {
  setup();
  const auth = await (await call('/api/v1/meta/auth/verify', { user_key: 'fixture' })).json();
  assert.equal(auth.data.valid, true);
  assert.equal(auth.data.user.auth_provider, 'fixture');
  const context = await (
    await call(`/api/v1/workbench/${TEAM}/context-get`, { kind: 'task', id: 'baren-task-1' })
  ).json();
  assert.deepEqual(context.inherited, []);
  assert.deepEqual(context.references, []);
  assert.equal(typeof context.revision, 'number');
  const options = await (await call(`/api/v1/workbench/${TEAM}/options`)).json();
  assert.deepEqual(options.bindings, []);
});

test('task creation and board transitions update only fixture data, with stale revision rejection', async () => {
  setup();
  const created = await (
    await call('/api/v1/meta/task/create', { title: 'Preview validation task' })
  ).json();
  const taskId = created.data.task_id;
  const state = await (await call('/api/v1/meta/task/board-state', { task_id: taskId })).json();
  const moved = await call('/api/v1/meta/task/board-transition', {
    task_id: taskId,
    expected_revision: state.data.revision,
    status: 'review',
  });
  assert.equal(moved.status, 200);
  assert.equal(
    JSON.parse((await moved.json()).data.task.metadata_json).project_board.status,
    'review',
  );
  const stale = await call('/api/v1/meta/task/board-transition', {
    task_id: taskId,
    expected_revision: state.data.revision,
    status: 'done',
  });
  assert.equal(stale.status, 409);
});

test('coordinator dismiss does not mutate tasks and approval cannot replay', async () => {
  setup();
  const endpoint = `/api/v1/coordinator/${TEAM}`;
  const count = async () => (await (await call('/api/v1/meta/task/list', {})).json()).data.total;
  const initialCount = await count();
  let state = await (
    await call(`${endpoint}/message`, { revision: 1, text: 'Create a task' })
  ).json();
  state = await (
    await call(`${endpoint}/cancel`, { revision: state.revision, id: state.pending.id })
  ).json();
  assert.equal(await count(), initialCount);
  state = await (
    await call(`${endpoint}/message`, { revision: state.revision, text: 'Create a task' })
  ).json();
  const approval = { revision: state.revision, id: state.pending.id };
  assert.equal((await call(`${endpoint}/approve`, approval)).status, 200);
  assert.equal(await count(), initialCount + 1);
  assert.equal((await call(`${endpoint}/approve`, approval)).status, 409);
  assert.equal(await count(), initialCount + 1);
});

test('coordinator fixture exposes offline, error and recoverable revision conflict states', async () => {
  const endpoint = `/api/v1/coordinator/${TEAM}`;
  setup('?coordinator=offline');
  assert.equal((await (await call(`${endpoint}/state`)).json()).ready, false);
  setup('?coordinator=error');
  assert.equal((await call(`${endpoint}/state`)).status, 503);
  setup('?coordinator=conflict');
  const proposed = await (
    await call(`${endpoint}/message`, { revision: 1, text: 'Create a task' })
  ).json();
  const firstApproval = await call(`${endpoint}/approve`, {
    revision: proposed.revision,
    id: proposed.pending.id,
  });
  assert.equal(firstApproval.status, 409);
  const refreshed = await (await call(`${endpoint}/state`)).json();
  assert.equal(refreshed.pending.id, proposed.pending.id);
  assert.ok(refreshed.revision > proposed.revision);
  assert.equal(
    (
      await call(`${endpoint}/approve`, {
        revision: refreshed.revision,
        id: refreshed.pending.id,
      })
    ).status,
    200,
  );
});

test('empty/error/loading scenarios keep auth available while exercising page resource states', async () => {
  setup('?scenario=empty&role=member');
  assert.equal((await (await call('/api/v1/meta/task/list', {})).json()).data.total, 0);
  const memberAuth = await (await call('/api/v1/meta/auth/verify', {})).json();
  assert.equal(memberAuth.data.user.user_type, 'user');
  setup('?scenario=error');
  assert.equal((await call('/api/v1/meta/auth/verify', {})).status, 200);
  assert.equal((await call('/api/v1/meta/task/list', {})).status, 503);
  setup('?scenario=loading');
  assert.equal((await call('/api/v1/meta/auth/verify', {})).status, 200);
  const pending = await Promise.race([
    call('/api/v1/meta/task/list', {}).then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10)),
  ]);
  assert.equal(pending, true);
});
