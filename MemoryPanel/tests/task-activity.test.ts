import { beforeEach, afterEach, expect, test } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerTaskActivityRoutes } from '../src/panel/http/routes/task-activity.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
let root: string;
let app: Hono;
let active = true;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'task-board-test-')); active = true;
  app = new Hono();
  const deps = {
    instanceRegistry: { resolve: (id: string) => ({ instance_id: id, gateway_endpoint: 'http://core', api_key: 'test' }) },
    metaKernel: { invoke: async (action: string, body: any) => {
      const data = action === 'auth/verify' ? { valid: body.user_key !== 'invalid', user: { user_id: body.user_key } }
        : action === 'task/get' ? { team_id: 'team', creator_user_id: 'owner' }
        : action === 'team-member/get' ? { status: active && body.user_id !== 'outsider' ? 'active' : 'removed' } : null;
      return { code: 0, data };
    } },
  } as unknown as PanelDeps;
  registerTaskActivityRoutes(app, deps, root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function request(action: string, init: RequestInit = {}, who = 'owner', instance = 'default', task = 'task-a') {
  return app.request(`/task/activity/${task}/${action}`, { ...init, headers: { 'X-Tdai-Service-Id': instance, 'X-Tdai-User-Key': who, ...init.headers } });
}
test('persists concurrent human notes and scopes by task and instance', async () => {
  const add = (text: string) => request('note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  expect((await Promise.all([add('First decision'), add('Second decision')])).map(r => r.status)).toEqual([201, 201]);
  expect((await (await request('list')).json()).items).toHaveLength(2);
  expect((await (await request('list', {}, 'owner', 'other')).json()).items).toHaveLength(0);
  expect((await (await request('list', {}, 'owner', 'default', 'task-b')).json()).items).toHaveLength(0);
});
test('uploads and downloads exact bytes; never serves active content inline', async () => {
  const form = new FormData(); form.append('file', new Blob(['<script>alert(1)</script>']), '../report.html');
  const response = await request('upload', { method: 'POST', body: form }); expect(response.status).toBe(201);
  const file = await response.json();
  const download = await request(`download?id=${file.id}`);
  expect(await download.text()).toBe('<script>alert(1)</script>');
  expect(download.headers.get('content-type')).toBe('application/octet-stream');
  expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);
  expect((await request(`delete?id=${file.id}`, { method: 'POST' }, 'someone')).status).toBe(403);
  expect((await request(`delete?id=${file.id}`, { method: 'POST' })).status).toBe(200);
  expect((await request(`download?id=${file.id}`)).status).toBe(404);
});
test('enforces authentication and current membership on every request', async () => {
  expect((await request('list', {}, 'invalid')).status).toBe(401);
  expect((await request('list', {}, 'outsider')).status).toBe(403);
  const add = await request('note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Private' }) });
  const note = await add.json(); active = false;
  expect((await request('list')).status).toBe(403);
  expect((await request(`delete?id=${note.id}`, { method: 'POST' })).status).toBe(403);
});
test('rejects empty notes, oversized files and traversal IDs', async () => {
  expect((await request('note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ' ' }) })).status).toBe(400);
  expect((await request('download?id=../../secret')).status).toBe(404);
  const form = new FormData(); form.append('file', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), 'large.bin');
  expect((await request('upload', { method: 'POST', body: form })).status).toBe(400);
});
