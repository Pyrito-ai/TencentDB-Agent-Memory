import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMetadataStore } from '../src/metadata/store/sqlite-adapter.js';
import { MongoMetadataStore } from '../src/metadata/store/mongodb-adapter.js';
import { MetadataService } from '../src/metadata/service/metadata-service.js';
import { taskBoardRevision } from '../src/metadata/service/task-board.js';
const ctx = (userId: string) => ({ userId, token: '', isAdmin: false, isSystemAdmin: false });
function fixture() {
  const store = new SqliteMetadataStore(':memory:'); store.init();
  const owner = store.createUser({ username: 'Owner', auth_provider: 'local', external_id: 'Owner' });
  const worker = store.createUser({ username: 'Service', auth_provider: 'local', external_id: 'Service' });
  const stranger = store.createUser({ username: 'Stranger', auth_provider: 'local', external_id: 'Stranger' });
  const team = store.createTeam({ name: 'Team', owner_user_id: owner.user_id });
  store.addTeamMember({ team_id: team.team_id, user_id: worker.user_id });
  const task = store.createTask({ team_id: team.team_id, creator_user_id: owner.user_id,
    title: 'Task', metadata_json: JSON.stringify({ project_board: { status: 'ready', assignee: 'Human', dueDate: '2030-01-01' }, loop_id: 'keep' }) });
  return { store, service: new MetadataService(store), task, owner: ctx(owner.user_id), worker: ctx(worker.user_id), stranger: ctx(stranger.user_id) };
}
test('field-specific transition preserves metadata, compares revision, and changes revision each time', async () => {
  const f = fixture(); try {
    const initial = await f.service.getTaskBoardForCaller(f.task.task_id, f.owner);
    const next = await f.service.transitionTaskBoardForCaller(f.task.task_id, initial.revision, 'in_progress', f.owner);
    const metadata = JSON.parse(next.task.metadata_json);
    assert.equal(metadata.loop_id, 'keep'); assert.equal(metadata.project_board.assignee, 'Human');
    assert.equal(metadata.project_board.status, 'in_progress'); assert.notEqual(initial.revision, next.revision);
    await assert.rejects(f.service.transitionTaskBoardForCaller(f.task.task_id, initial.revision, 'review', f.owner), { code: 'revision_conflict' });
    const a = f.service.transitionTaskBoardForCaller(f.task.task_id, next.revision, 'review', f.owner);
    const b = f.service.transitionTaskBoardForCaller(f.task.task_id, next.revision, 'done', f.owner);
    const results = await Promise.allSettled([a,b]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  } finally { f.store.close(); }
});
test('active creator or explicit active service grant only; no admin bypass or autonomous Done', async () => {
  const f = fixture(); try {
    await assert.rejects(f.service.getTaskBoardForCaller(f.task.task_id, { ...f.stranger, isAdmin: true, isSystemAdmin: true }), { code: 'permission_denied' });
    await assert.rejects(f.service.getTaskBoardForCaller(f.task.task_id, f.worker), { code: 'permission_denied' });
    const granted = await f.service.grantTaskExecutionForCaller(f.task.task_id, taskBoardRevision(f.task), f.worker.userId, f.owner);
    const working = await f.service.transitionTaskBoardForCaller(f.task.task_id, granted.revision, 'in_progress', f.worker);
    await assert.rejects(f.service.transitionTaskBoardForCaller(f.task.task_id, working.revision, 'done', f.worker), { code: 'permission_denied' });
    const review = await f.service.transitionTaskBoardForCaller(f.task.task_id, working.revision, 'review', f.worker);
    const done = await f.service.transitionTaskBoardForCaller(f.task.task_id, review.revision, 'done', f.owner);
    await assert.rejects(f.service.transitionTaskBoardForCaller(f.task.task_id, done.revision, 'in_progress', f.worker), { code: 'permission_denied' });
    await f.service.grantTaskExecutionForCaller(f.task.task_id, done.revision, null, f.owner);
    await assert.rejects(f.service.getTaskBoardForCaller(f.task.task_id, f.worker), { code: 'permission_denied' });
    f.store.removeTeamMember(f.task.team_id, f.owner.userId);
    await assert.rejects(f.service.getTaskBoardForCaller(f.task.task_id, f.owner), { code: 'permission_denied' });
  } finally { f.store.close(); }
});
test('atomic store predicate rejects concurrent human edits, revoked grant, and membership removal', async () => {
  const f = fixture(); try {
    const grant = await f.service.grantTaskExecutionForCaller(f.task.task_id, taskBoardRevision(f.task), f.worker.userId, f.owner);
    await f.service.grantTaskExecutionForCaller(f.task.task_id, grant.revision, null, f.owner);
    assert.equal(f.store.compareAndSetTaskBoard(grant.task, grant.task.metadata_json, 'running', f.worker.userId), null);
    const latest = f.store.getTaskById(f.task.task_id)!;
    f.store.updateTask(f.task.task_id, { title: 'Changed brief' });
    assert.equal(f.store.compareAndSetTaskBoard(latest, latest.metadata_json, 'running', f.owner.userId), null);
    const edited = f.store.getTaskById(f.task.task_id)!;
    f.store.removeTeamMember(f.task.team_id, f.owner.userId);
    assert.equal(f.store.compareAndSetTaskBoard(edited, edited.metadata_json, 'running', f.owner.userId), null);
  } finally { f.store.close(); }
});
test('Mongo CAS filters exactly the revision-bearing snapshot and returns the atomic updated document', async () => {
  const f = fixture(); try {
    let current = { ...f.task }; let active = true;
    const collections = { meta_team_members: { findOne: async () => active ? {} : null },
      meta_tasks: { findOneAndUpdate: async (filter: Record<string, unknown>, patch: any, options: any) => {
        assert.equal(options.returnDocument, 'after'); assert.equal(options.includeResultMetadata, false);
        if (Object.entries(filter).some(([k,v]) => (current as any)[k] !== v && !((current as any)[k] == null && v == null))) return null;
        current = { ...current, ...patch.$set }; return current;
      } } };
    const fakeClient = { db: () => ({ collection: (name: string) => (collections as any)[name] }),
      startSession: () => ({ withTransaction: async (fn: () => unknown) => fn(), endSession: async () => {} }) };
    const mongo = new MongoMetadataStore(fakeClient as any, 'test');
    const next = await mongo.compareAndSetTaskBoard(f.task, '{"new":true}', 'running', f.owner.userId);
    assert.equal(next?.metadata_json, '{"new":true}');
    assert.equal(await mongo.compareAndSetTaskBoard(f.task, '{}', 'running', f.owner.userId), null);
    active = false;
    assert.equal(await mongo.compareAndSetTaskBoard(current, '{}', 'running', f.owner.userId), null);
  } finally { f.store.close(); }
});

test('schema rejects unknown fields, invalid revisions/statuses; malformed metadata fails closed', async () => {
  const { taskBoardTransitionSchema, taskExecutionGrantSchema, V3_SCHEMAS } = await import('../src/metadata/router/v3-meta-schemas.js');
  assert.ok(V3_SCHEMAS['/v3/meta/task/board-state']);
  assert.equal(taskBoardTransitionSchema.safeParse({ task_id: 't', expected_revision: 'old', status: 'done' }).success, false);
  assert.equal(taskBoardTransitionSchema.safeParse({ task_id: 't', expected_revision: 'a'.repeat(64), status: 'review', metadata_json: '{}' }).success, false);
  assert.equal(taskExecutionGrantSchema.safeParse({ task_id: 't', expected_revision: 'a'.repeat(64), service_user_id: null }).success, true);
  const f = fixture(); try {
    f.store.updateTask(f.task.task_id, { metadata_json: '[]' });
    await assert.rejects(f.service.getTaskBoardForCaller(f.task.task_id, f.owner), { code: 'invalid_request' });
  } finally { f.store.close(); }
});

test('legacy updates cannot forge grants or restore revoked authority and protected edits require CAS', async () => {
  const f = fixture(); try {
    const forged = JSON.stringify({ execution_service_grant: { service_user_id: f.worker.userId }, project_board: { status: 'ready' } });
    const unversioned = await f.service.updateTaskForCaller(f.task.task_id, { metadata_json: forged }, f.owner);
    assert.equal(JSON.parse(unversioned.metadata_json).execution_service_grant, undefined);
    const granted = await f.service.grantTaskExecutionForCaller(f.task.task_id, taskBoardRevision(unversioned), f.worker.userId, f.owner);
    await assert.rejects(f.service.updateTaskForCaller(f.task.task_id, { title: 'Stale' }, f.owner), { code: 'revision_conflict' });
    const revoked = await f.service.grantTaskExecutionForCaller(f.task.task_id, granted.revision, null, f.owner);
    await assert.rejects(f.service.updateTaskForCaller(f.task.task_id, { metadata_json: granted.task.metadata_json }, f.owner, granted.revision), { code: 'revision_conflict' });
    const updated = await f.service.updateTaskForCaller(f.task.task_id, { title: 'Fresh', description: 'Criteria', metadata_json: granted.task.metadata_json }, f.owner, revoked.revision);
    assert.equal(updated.title, 'Fresh'); assert.equal(updated.description, 'Criteria');
    assert.equal(JSON.parse(updated.metadata_json).execution_service_grant, undefined);
    await assert.rejects(f.service.getTaskBoardForCaller(f.task.task_id, f.worker), { code: 'permission_denied' });
  } finally { f.store.close(); }
});

test('creation cannot inject the reserved service grant namespace', async () => {
  const f = fixture(); try {
    const created = await f.service.createTaskForCaller({ team_id: f.task.team_id,
      creator_user_id: f.owner.userId, title: 'Injected grant', metadata_json: JSON.stringify({
        execution_service_grant: { service_user_id: f.worker.userId }, board_revision: 'fake', project_board: { status: 'ready' },
      }) }, f.owner);
    assert.deepEqual(JSON.parse(created.metadata_json), { project_board: { status: 'ready' } });
    await assert.rejects(f.service.getTaskBoardForCaller(created.task_id, f.worker), { code: 'permission_denied' });
  } finally { f.store.close(); }
});

test('archive requires active creator and protected revision, and invalidates outstanding execution snapshots', async () => {
  const f = fixture(); try {
    const grant = await f.service.grantTaskExecutionForCaller(f.task.task_id, taskBoardRevision(f.task), f.worker.userId, f.owner);
    await assert.rejects(f.service.archiveTaskForCaller(f.task.task_id, f.owner), { code: 'revision_conflict' });
    await assert.rejects(f.service.archiveTaskForCaller(f.task.task_id, f.worker, grant.revision), { code: 'permission_denied' });
    const archived = await f.service.archiveTaskForCaller(f.task.task_id, f.owner, grant.revision);
    assert.equal(archived.status, 'completed');
    assert.equal(f.store.compareAndSetTaskBoard(grant.task, grant.task.metadata_json, 'running', f.worker.userId), null);
    await assert.rejects(f.service.transitionTaskBoardForCaller(f.task.task_id, taskBoardRevision(archived), 'in_progress', f.worker), { code: 'permission_denied' });
    f.store.removeTeamMember(f.task.team_id, f.owner.userId);
    await assert.rejects(f.service.archiveTaskForCaller(f.task.task_id, f.owner, taskBoardRevision(archived)), { code: 'permission_denied' });
    await assert.rejects(f.service.getTaskBoardForCaller(f.task.task_id, f.worker), { code: 'permission_denied' });
    assert.equal(f.store.compareAndSetTaskBoard(archived, archived.metadata_json, 'running', f.worker.userId), null);
  } finally { f.store.close(); }
});
