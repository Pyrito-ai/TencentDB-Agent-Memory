import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { registerWorkbenchRoutes } from '../src/panel/http/routes/workbench.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import type { RuntimeGateway, RuntimeGatewayGrant } from '../src/panel/runtime-gateway.js';
import type { Binding } from '../src/panel/workbench/runner-client.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
let root: string, close: () => void, app: Hono, db: InstanceType<typeof DatabaseSync>;
let deps: PanelDeps, gateway: RuntimeGateway, bindings: Binding[], handoff: any;
let active: boolean, credentialValid: boolean, creator: string, taskTeam: string;
let profileActive: boolean, wikiAllowed: boolean, sessionActive: boolean;
const read = vi.fn(), launch = vi.fn(), issueGrant = vi.fn(), revokeUser = vi.fn(), projects = vi.fn();

function save(owner = 'alice') {
  db.prepare('INSERT OR REPLACE INTO cdesktop_handoffs VALUES(?,?,?,?,?)')
    .run('default', 'team', 'task', owner, JSON.stringify(handoff));
}
function request(action = 'browser-session', body: unknown = { taskId: 'task' }, key = 'alice-key', method = 'POST') {
  return app.request(`/workbench/team/cdesktop-${action}`, {
    method,
    headers: { 'X-Tdai-Service-Id': 'default', ...(key ? { 'X-Tdai-User-Key': key } : { cookie: 'session=valid-idp' }), 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}
async function issued() {
  const response = await request();
  expect(response.status).toBe(200);
  return issueGrant.mock.calls.at(-1)![0] as RuntimeGatewayGrant;
}

beforeEach(async () => {
  vi.resetAllMocks();
  active = credentialValid = profileActive = wikiAllowed = sessionActive = true;
  creator = 'alice'; taskTeam = 'team';
  root = await mkdtemp(path.join(tmpdir(), 'browser-session-'));
  const id = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID();
  handoff = {
    id, binding: 'cd1', agent: 'codex', spec: 'An already approved saved task.',
    receipt: { id, state: 'running', workspaceId, sessionId,
      webUrl: `http://127.0.0.1:5190/workspaces/${workspaceId}?embed=1&sessionId=${sessionId}` },
  };
  bindings = [{ id: 'cd1', label: 'My local runtime', instance: 'default', team: 'team', user: 'alice',
    repo: 'trial-repo', url: 'http://127.0.0.1:8793', token: 's'.repeat(32), webUrl: 'http://127.0.0.1:5190' }];
  read.mockImplementation(async () => ({ ...handoff.receipt }));
  projects.mockResolvedValue({ items: [{ id: 'repo1', name: 'Repo one' }] });
  issueGrant.mockResolvedValue({ bootstrapUrl: 'https://cdesktop.pyrito.com/_pyrito/session', ticket: 'opaque-ticket', expiresAt: '2026-10-03T10:01:00.000Z' });
  gateway = { config: { origin: 'https://cdesktop.pyrito.com', appOrigins: ['https://app.pyrito.com'], socketPath: '/run/runtime.sock',
    upstreamOrigin: 'http://127.0.0.1:5190', ownerInstanceId: 'default', ownerUserId: 'alice', port: 8126 },
    issueGrant, revokeUser, revokeAll: vi.fn(), start: vi.fn(), close: vi.fn() } as unknown as RuntimeGateway;
  deps = {
    runtimeGateway: gateway,
    config: { auth: { sessionCookieName: 'session' } },
    auth: { resolveSession: () => sessionActive ? { coreUserId: 'alice', userKey: 'alice-key', instanceId: 'default' } : null },
    instanceRegistry: { resolve: (instance_id: string) => ({ instance_id, gateway_endpoint: 'https://meta.example', api_key: 'server-only-key' }) },
    metaKernel: { invoke: vi.fn(async (action: string, body: any) => ({ code: 0, data:
      action === 'auth/verify' ? { valid: credentialValid && ['alice-key', 'bob-key'].includes(body.user_key), user: { user_id: body.user_key === 'bob-key' ? 'bob' : 'alice', user_type: 'system_admin' } } :
      action === 'team-member/get' ? { status: active ? 'active' : 'removed', role: 'admin' } :
      action === 'task/get' ? { task_id: body.task_id, team_id: taskTeam, creator_user_id: creator, title: 'Task' } :
      action === 'agent/get' ? { agent_id: body.agent_id, team_id: 'team', owner_user_id: 'alice', visibility: 'private', status: profileActive ? 'active' : 'inactive', name: 'Agent', prompt: 'Rules' } :
      action === 'asset/get' ? { asset_id: body.asset_id, team_id: 'team', asset_type: 'llm_wiki' } :
      action === 'acl/check' ? { allowed: wikiAllowed } : null,
    })) },
    knowledgeClientFactory: () => ({
      wikiGet: async (wiki_id: string) => ({ wiki_id, team_id: 'team', version: '1' }),
      wikiPageRead: async (_id: string, refs: string[]) => ({ items: refs.map(ref => ({ ref, content: 'Saved context' })) }),
    }),
  } as unknown as PanelDeps;
  app = new Hono();
  close = registerWorkbenchRoutes(app, deps, { root, boardRoot: root, cdesktopBindings: bindings,
    runner: { read, launch, launchDirect: launch, projects } as any });
  db = new DatabaseSync(path.join(root, 'runs.sqlite'));
  save();
});

afterEach(async () => { db.close(); close(); await rm(root, { recursive: true, force: true }); });

test('issues only the saved session, reads the receipt, and never launches or changes the handoff', async () => {
  const before = db.prepare('SELECT body FROM cdesktop_handoffs').get()!.body;
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ bootstrapUrl: 'https://cdesktop.pyrito.com/_pyrito/session', ticket: 'opaque-ticket', expiresAt: '2026-10-03T10:01:00.000Z' });
  const grant = issueGrant.mock.calls[0]![0] as RuntimeGatewayGrant;
  expect(grant).toMatchObject({ instanceId: 'default', userId: 'alice', teamId: 'team', taskId: 'task',
    handoffId: handoff.id, bindingId: 'cd1', workspaceId: handoff.receipt.workspaceId, sessionId: handoff.receipt.sessionId });
  expect(await grant.validate()).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(bindings[0], handoff.id);
  expect(launch).not.toHaveBeenCalled();
  expect(db.prepare('SELECT body FROM cdesktop_handoffs').get()!.body).toBe(before);
});

test('wrong keys never get a grant', async () => {
  expect((await request('browser-session', { taskId: 'task' }, 'wrong-key')).status).toBe(401);
  expect(issueGrant).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

test.each(['inactive', 'creator', 'team', 'owner', 'runtime-owner', 'runtime-instance'])('denies %s despite admin role', async reason => {
  if (reason === 'inactive') active = false;
  if (reason === 'creator') creator = 'bob';
  if (reason === 'team') taskTeam = 'other';
  if (reason === 'owner') save('bob');
  if (reason === 'runtime-owner') (gateway.config as any).ownerUserId = 'bob';
  if (reason === 'runtime-instance') (gateway.config as any).ownerInstanceId = 'other';
  expect((await request()).status).toBe(403);
  expect(issueGrant).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
});

test.each(['user', 'team', 'instance', 'webUrl'])('denies a foreign binding %s', async field => {
  (bindings[0] as any)[field] = field === 'webUrl' ? 'https://foreign.example' : 'other';
  expect((await request()).status).toBe(403);
  expect(read).not.toHaveBeenCalled(); expect(issueGrant).not.toHaveBeenCalled();
});

test.each(['workspaceId', 'sessionId', 'id', 'webUrl', 'web-path', 'web-session', 'missing'])('rejects incoherent saved receipt %s', async field => {
  if (field === 'missing') delete handoff.receipt;
  else if (field === 'webUrl') handoff.receipt.webUrl = 'https://evil.example/';
  else if (field === 'web-path') handoff.receipt.webUrl = handoff.receipt.webUrl.replace(handoff.receipt.workspaceId, randomUUID());
  else if (field === 'web-session') handoff.receipt.webUrl = handoff.receipt.webUrl.replace(handoff.receipt.sessionId, randomUUID());
  else handoff.receipt[field] = field === 'id' ? randomUUID() : 'not-a-uuid';
  save();
  expect((await request()).status).toBe(409);
  expect(issueGrant).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
});

test.each(['workspaceId', 'sessionId', 'id', 'webUrl'])('rejects a mismatched live receipt %s', async field => {
  read.mockResolvedValue({ ...handoff.receipt, [field]: field === 'webUrl' ? 'https://foreign.example/' : randomUUID() });
  expect((await request()).status).toBe(409); expect(issueGrant).not.toHaveBeenCalled();
});

test.each(['binding', 'workspaceId', 'sessionId', 'origin', 'url', 'userId'])('refuses client-selected %s', async field => {
  expect((await request('browser-session', { taskId: 'task', [field]: 'attacker-choice' })).status).toBe(400);
  expect(read).not.toHaveBeenCalled(); expect(issueGrant).not.toHaveBeenCalled();
});

test.each(['credential', 'membership', 'creator', 'saved-owner', 'saved-row', 'binding', 'binding-token', 'receipt', 'configured-owner'])('revalidation denies changed %s', async reason => {
  const grant = await issued();
  if (reason === 'credential') credentialValid = false;
  if (reason === 'membership') active = false;
  if (reason === 'creator') creator = 'bob';
  if (reason === 'saved-owner') save('bob');
  if (reason === 'saved-row') { handoff.spec = 'Changed saved launch'; save(); }
  if (reason === 'binding') bindings[0]!.user = 'bob';
  if (reason === 'binding-token') bindings[0]!.token = 'changed-server-credential';
  if (reason === 'receipt') read.mockResolvedValue({ ...handoff.receipt, sessionId: randomUUID() });
  if (reason === 'configured-owner') (gateway.config as any).ownerUserId = 'bob';
  expect(await grant.validate()).toBe(false);
  expect(launch).not.toHaveBeenCalled();
});

test('managed-project binding access is checked again against the current runner catalogue', async () => {
  bindings[0]!.manageProjects = true; bindings[0]!.repo = 'managed';
  handoff.binding = 'cd1:repo1'; save();
  const grant = await issued();
  expect(read.mock.calls[0]![0]).toMatchObject({ id: 'cd1:repo1', repo: 'id:repo1' });
  projects.mockResolvedValue({ items: [] });
  expect(await grant.validate()).toBe(false);
  expect(launch).not.toHaveBeenCalled();
});

test('normal handoff status syncs preserve browser access without relaunching or rewriting the row', async () => {
  const grant = await issued();
  handoff.receipt = { ...handoff.receipt, state: 'exited', processStatus: 'completed',
    output: 'Task completed', notice: 'Worker exited', lifecycle: 'review', stage: 'finished' };
  handoff.error = 'Previous transient runner error';
  bindings[0]!.label = 'Renamed local runtime';
  save();
  const syncedBody = db.prepare('SELECT body FROM cdesktop_handoffs').get()!.body;
  expect(await grant.validate()).toBe(true);
  delete handoff.error; save();
  expect(await grant.validate()).toBe(true);
  expect(JSON.parse(String(syncedBody)).receipt.output).toBe('Task completed');
  expect(db.prepare('SELECT body FROM cdesktop_handoffs').get()!.body).toBe(JSON.stringify(handoff));
  expect(launch).not.toHaveBeenCalled();
});

test.each(['id', 'workspaceId', 'sessionId'])('a saved receipt identity change still revokes browser access: %s', async field => {
  const grant = await issued();
  handoff.receipt[field] = randomUUID(); save();
  expect(await grant.validate()).toBe(false);
  expect(launch).not.toHaveBeenCalled();
});

test('profile access is enforced at issuance and revalidation', async () => {
  handoff.profile = { id: 'profile', name: 'Agent', prompt: 'Rules', description: '', updatedAt: '' }; save();
  const grant = await issued(); profileActive = false;
  expect(await grant.validate()).toBe(false);
  expect((await request()).status).toBe(409);
});

test('linked Wiki access is enforced at issuance and revalidation', async () => {
  handoff.context = { references: [{ kind: 'wiki_page', wikiId: 'wiki', ref: 'brief.md' }] }; save();
  const grant = await issued(); wikiAllowed = false;
  expect(await grant.validate()).toBe(false);
  expect((await request()).status).toBe(409);
});

test('saved bundle scope cannot substitute another owner', async () => {
  handoff.profile = { id: 'profile', name: 'Agent', prompt: 'Rules', description: '', updatedAt: '' };
  handoff.context = { references: [] };
  const files = [{ path: 'manifest.json', content: JSON.stringify({ instanceId: 'default', teamId: 'team', userId: 'bob', taskId: 'task', agent: { id: 'profile' } }) }];
  handoff.bundle = { files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') }; save();
  expect((await request()).status).toBe(409); expect(issueGrant).not.toHaveBeenCalled();
});

test('expired IdP session invalidates the browser grant even when its core key remains valid', async () => {
  expect((await request('browser-session', { taskId: 'task' }, '')).status).toBe(200);
  const grant = issueGrant.mock.calls[0]![0] as RuntimeGatewayGrant;
  sessionActive = false;
  expect(await grant.validate()).toBe(false);
});

test('revokes only the signed-in caller even after membership removal', async () => {
  active = false;
  expect((await request('browser-revoke', { userId: 'bob' })).status).toBe(200);
  expect(revokeUser).toHaveBeenCalledTimes(1);
  expect(revokeUser).toHaveBeenCalledWith('default', 'alice');
  expect((await request('browser-revoke', {}, 'wrong-key')).status).toBe(401);
  expect(revokeUser).toHaveBeenCalledTimes(1);
});

test('gateway absent preserves options and prevents issuing browser access', async () => {
  const configured = await (await request('options', undefined, 'alice-key', 'GET')).json();
  expect(configured.browserGateway).toEqual({ origin: 'https://cdesktop.pyrito.com' });
  expect(configured.bindings[0].webUrl).toBe('http://127.0.0.1:5190');
  delete deps.runtimeGateway;
  expect((await request()).status).toBe(503);
  expect(await (await request('options', undefined, 'alice-key', 'GET')).json()).not.toHaveProperty('browserGateway');
  expect((await request('browser-revoke', {})).status).toBe(200);
});

test('upstream errors do not leak credentials and cannot issue a grant', async () => {
  read.mockRejectedValue(new Error('server-only-key ' + bindings[0]!.token));
  const response = await request();
  expect(response.status).toBe(409);
  expect(await response.text()).not.toMatch(/server-only-key|ssssssss/);
  expect(issueGrant).not.toHaveBeenCalled();
});
