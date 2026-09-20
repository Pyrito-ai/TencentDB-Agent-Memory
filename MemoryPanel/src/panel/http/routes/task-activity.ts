import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, resolveCallerUserId } from './knowledge/common.js';
interface Activity {
  id: string; kind: 'note' | 'attachment'; author: string; createdAt: string;
  text?: string; name?: string; size?: number;
}
const MAX_FILE = 10 * 1024 * 1024;
const uuid = /^[a-f0-9-]{36}$/;
/** Mount TASK_BOARD_DATA_DIR on persistent storage. Every operation rechecks membership. */
export function registerTaskActivityRoutes(api: Hono, deps: PanelDeps, root = process.env.TASK_BOARD_DATA_DIR || path.resolve('data/task-board')): void {
  api.use('/task/activity/*', validatePanelMetaHeaders(deps));
  api.use('/task/activity/*', bodyLimit({ maxSize: MAX_FILE + 65536, onError: c => c.json({ error: 'Files must be 10 MB or smaller.' }, 413) }));
  api.all('/task/activity/:taskId/:action', async c => {
    const ctx = buildCtx(c);
    const caller = await resolveCallerUserId(deps, ctx);
    if (!caller) return c.json({ error: 'Unauthorized' }, 401);
    const taskId = c.req.param('taskId');
    const env = await deps.metaKernel.invoke('task/get', { task_id: taskId }, ctx);
    const task = env.code === 0 ? env.data as { team_id: string; creator_user_id: string } | null : null;
    if (!task) return c.json({ error: 'Task not found' }, 404);
    // Upstream task/get alone does not check team membership.
    const membership = await deps.metaKernel.invoke('team-member/get', { team_id: task.team_id, user_id: caller }, ctx);
    if (membership.code !== 0 || (membership.data as { status?: string } | null)?.status !== 'active') return c.json({ error: 'Forbidden' }, 403);
    const dir = path.join(root, createHash('sha256').update(JSON.stringify([ctx.instanceId, taskId])).digest('hex'));
    const action = c.req.param('action');
    c.header('Cache-Control', 'private, no-store');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const persist = async (item: Activity) => {
      const temp = path.join(dir, item.id + '.tmp');
      await writeFile(temp, JSON.stringify(item), { flag: 'wx', mode: 0o600 });
      await rename(temp, path.join(dir, item.id + '.json'));
    };
    const load = async (id: string): Promise<Activity | null> => {
      if (!uuid.test(id)) return null;
      try { return JSON.parse(await readFile(path.join(dir, id + '.json'), 'utf8')) as Activity; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    };
    if (action === 'list' && c.req.method === 'GET') {
      const names = (await readdir(dir)).filter(n => n.endsWith('.json'));
      const items = (await Promise.all(names.map(n => load(n.slice(0, -5))))).filter((v): v is Activity => v !== null);
      return c.json({ items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
    }
    if (action === 'note' && c.req.method === 'POST') {
      const body = await c.req.json().catch(() => null);
      if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 20000) return c.json({ error: 'A note must contain 1–20,000 characters.' }, 400);
      const item: Activity = { id: randomUUID(), kind: 'note', author: caller, createdAt: new Date().toISOString(), text: body.text.trim() };
      await persist(item);
      return c.json(item, 201);
    }
    if (action === 'upload' && c.req.method === 'POST') {
      const form = await c.req.parseBody().catch(() => null); const file = form?.file;
      if (!file || typeof file === 'string' || Array.isArray(file) || file.size === 0 || file.size > MAX_FILE) return c.json({ error: 'Choose a non-empty file up to 10 MB.' }, 400);
      const item: Activity = { id: randomUUID(), kind: 'attachment', author: caller, createdAt: new Date().toISOString(), name: file.name.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 255) || 'attachment', size: file.size };
      const bin = path.join(dir, item.id + '.bin');
      await writeFile(bin, Buffer.from(await file.arrayBuffer()), { flag: 'wx', mode: 0o600 });
      try { await persist(item); }
      catch (err) { await unlink(bin); throw err; }
      return c.json(item, 201);
    }
    const item = await load(c.req.query('id') || '');
    if (!item) return c.json({ error: 'Not found' }, 404);
    if (action === 'download' && c.req.method === 'GET' && item.kind === 'attachment') {
      return new Response(await readFile(path.join(dir, item.id + '.bin')), { headers: {
        'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name || 'attachment')}`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } });
    }
    if (action === 'delete' && c.req.method === 'POST') {
      if (item.author !== caller && task.creator_user_id !== caller) return c.json({ error: 'Forbidden' }, 403);
      if (item.kind === 'attachment') await unlink(path.join(dir, item.id + '.bin')).catch(err => { if (err.code !== 'ENOENT') throw err; });
      await unlink(path.join(dir, item.id + '.json'));
      return c.json({ ok: true });
    }
    return c.json({ error: 'Unsupported operation' }, 405);
  });
}
