import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SqliteMetadataStore } from '../src/metadata/store/sqlite-adapter.js';
import { MetadataService } from '../src/metadata/service/metadata-service.js';
import { handleV3MetaRoute } from '../src/metadata/router/v3-meta-router.js';

test('real HTTP routes enforce identity, scoped grant, conditional updates, human acceptance and revocation', async () => {
  const store = new SqliteMetadataStore(':memory:'); store.init();
  const owner = store.createUser({ username: 'Owner', auth_provider: 'local', external_id: 'owner', default_key_value: 'test-owner-key' });
  const worker = store.createUser({ username: 'Service', auth_provider: 'local', external_id: 'service', default_key_value: 'test-service-key' });
  const team = store.createTeam({ name: 'Team', owner_user_id: owner.user_id });
  store.addTeamMember({ team_id: team.team_id, user_id: worker.user_id });
  const task = store.createTask({ team_id: team.team_id, creator_user_id: owner.user_id, title: 'HTTP task', metadata_json: JSON.stringify({ project_board: { status: 'ready', assignee: owner.user_id }, untouched: true }) });
  const other = store.createTask({ team_id: team.team_id, creator_user_id: owner.user_id, title: 'Not granted' });
  const service = new MetadataService(store, 'test');
  const server = createServer(async (req, res) => {
    try {
      const handled = await handleV3MetaRoute(req, res, req.url!, req.method!, async <T>() => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString()) as T;
      }, (_res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
      { getMetadataService: id => id === 'test' ? service : undefined, logger: { debug() {}, warn() {}, error() {}, info() {} } });
      if (!handled) { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const post = async (route: string, body: object, key = 'test-owner-key', instance = 'test') => {
    const r = await fetch(`http://127.0.0.1:${address.port}/v3/meta/task/${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tdai-service-id': instance, 'x-tdai-user-key': key }, body: JSON.stringify(body) });
    return { status: r.status, envelope: await r.json() as any };
  };
  try {
    assert.equal((await post('board-state', { task_id: task.task_id }, '')).status, 401);
    assert.equal((await post('board-state', { task_id: task.task_id }, 'test-service-key')).status, 403);
    assert.equal((await post('board-state', { task_id: task.task_id }, 'test-owner-key', 'other')).status, 503);
    const state = (await post('board-state', { task_id: task.task_id })).envelope.data;
    const grant = await post('execution-grant', { task_id: task.task_id, expected_revision: state.revision, service_user_id: worker.user_id });
    assert.equal(grant.status, 200);
    assert.equal((await post('board-state', { task_id: other.task_id }, 'test-service-key')).status, 403);
    assert.equal((await post('archive', { task_id: task.task_id })).status, 409);
    const working = await post('board-transition', { task_id: task.task_id, expected_revision: grant.envelope.data.revision, status: 'in_progress' }, 'test-service-key');
    assert.equal(working.status, 200);
    assert.equal(JSON.parse(working.envelope.data.task.metadata_json).untouched, true);
    assert.equal((await post('board-transition', { task_id: task.task_id, expected_revision: grant.envelope.data.revision, status: 'review' }, 'test-service-key')).status, 409);
    assert.equal((await post('board-transition', { task_id: task.task_id, expected_revision: working.envelope.data.revision, status: 'done' }, 'test-service-key')).status, 403);
    const edited = await post('update', { task_id: task.task_id, expected_revision: working.envelope.data.revision, title: 'Updated title' });
    assert.equal(edited.status, 200); assert.equal(edited.envelope.data.title, 'Updated title');
    const fresh = (await post('board-state', { task_id: task.task_id })).envelope.data;
    const revoked = await post('execution-grant', { task_id: task.task_id, expected_revision: fresh.revision, service_user_id: null });
    assert.equal(revoked.status, 200);
    assert.equal((await post('board-state', { task_id: task.task_id }, 'test-service-key')).status, 403);
    assert.equal((await post('board-transition', { task_id: task.task_id, expected_revision: fresh.revision, status: 'review' }, 'test-service-key')).status, 403);
    store.removeTeamMember(team.team_id, owner.user_id);
    assert.equal((await post('board-state', { task_id: task.task_id })).status, 403);
  } finally {
    server.close(); await once(server, 'close'); store.close();
  }
});
