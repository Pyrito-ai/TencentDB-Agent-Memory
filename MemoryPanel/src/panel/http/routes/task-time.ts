import { registerLoops } from './loops.js';
import { registerProjects } from './projects.js';
import { migrateTimesheets, registerTimesheets } from './timesheets.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// Vite 5's built-in list predates node:sqlite; resolve it through Node itself.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, resolveCallerUserId } from './knowledge/common.js';

export function registerTaskTimeRoutes(api: Hono, deps: PanelDeps,
  root = process.env.TASK_BOARD_DATA_DIR || path.resolve('data/task-board')): () => void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(root, 'time.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS task_time (
      id TEXT PRIMARY KEY, instance TEXT NOT NULL, task TEXT NOT NULL, author TEXT NOT NULL,
      started INTEGER NOT NULL, ended INTEGER, seconds INTEGER, note TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('timer','manual')));
    CREATE INDEX IF NOT EXISTS task_time_scope ON task_time(instance,task);
    CREATE UNIQUE INDEX IF NOT EXISTS task_time_one_running ON task_time(instance,author) WHERE ended IS NULL;`);
  migrateTimesheets(db);
  registerProjects(api, deps, db);
  registerTimesheets(api, deps, db);
  registerLoops(api, deps, db);
  api.use('/task/time/*', validatePanelMetaHeaders(deps));
  api.use('/task/time/*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'Request too large' }, 413) }));
  api.all('/task/time/:taskId/:action', async c => {
    const ctx = buildCtx(c); const instance = ctx.instanceId; const taskId = c.req.param('taskId');
    const author = await resolveCallerUserId(deps, ctx);
    if (!author) return c.json({ error: 'Unauthorized' }, 401);
    const env = await deps.metaKernel.invoke('task/get', { task_id: taskId }, ctx);
    const task = env.code === 0 ? env.data as { team_id: string; title?: string } | null : null;
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const member = await deps.metaKernel.invoke('team-member/get', { team_id: task.team_id, user_id: author }, ctx);
    if (member.code !== 0 || (member.data as { status?: string } | null)?.status !== 'active') return c.json({ error: 'Forbidden' }, 403);
    db.prepare('UPDATE task_time SET team=?,title=? WHERE instance=? AND task=? AND team IS NULL').run(task.team_id,task.title||taskId,instance,taskId);
    const project=db.prepare('SELECT p.id,p.name FROM task_projects t JOIN projects p ON p.id=t.project_id AND p.instance=t.instance AND p.team=t.team WHERE t.instance=? AND t.team=? AND t.task=?').get(instance,task.team_id,taskId);
    c.header('Cache-Control', 'private, no-store');
    const action = c.req.param('action'); const now = Date.now();
    if (action === 'list' && c.req.method === 'GET') {
      const items = db.prepare('SELECT id,author,started,ended,seconds,note,kind,review_state,EXISTS(SELECT 1 FROM loop_time WHERE time_id=task_time.id) AS loop_linked FROM task_time WHERE instance=? AND task=? ORDER BY started DESC').all(instance,taskId);
      // Do not disclose another task's identity through the running-timer check.
      const otherRunning = !!db.prepare('SELECT 1 FROM task_time WHERE instance=? AND author=? AND task<>? AND ended IS NULL').get(instance,author,taskId);
      return c.json({ items, otherRunning, serverNow: now });
    }
    if (c.req.method !== 'POST') return c.json({ error: 'Method not allowed' }, 405);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'Invalid request' }, 400);
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 2000) return c.json({ error: 'Notes are limited to 2,000 characters.' }, 400);
    if (action === 'start') {
      const id = randomUUID();
      try { db.prepare("INSERT INTO task_time(id,instance,task,author,started,note,kind,team,title,project_id,project) VALUES(?,?,?,?,?,?,'timer',?,?,?,?)").run(id,instance,taskId,author,now,note,task.team_id,task.title||taskId,project?.id||'',project?.name||''); }
      catch (err) {
        if (String(err).includes('UNIQUE constraint failed')) return c.json({ error: 'You already have a running timer. Stop it before starting another.' }, 409);
        throw err;
      }
      return c.json({ id, started: now }, 201);
    }
    if (action === 'manual') {
      const seconds = body.seconds; const started = body.started;
      if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400 || !Number.isSafeInteger(started) || started < 0 || started + seconds * 1000 > now)
        return c.json({ error: 'Enter 1 minute to 24 hours of work ending in the past.' }, 400);
      const id = randomUUID();
      db.prepare("INSERT INTO task_time(id,instance,task,author,started,ended,seconds,note,kind,team,title,project_id,project) VALUES(?,?,?,?,?,?,?,?,'manual',?,?,?,?)")
        .run(id,instance,taskId,author,started,started+seconds*1000,seconds,note,task.team_id,task.title||taskId,project?.id||'',project?.name||'');
      return c.json({ id }, 201);
    }
    const id = typeof body.id === 'string' ? body.id : '';
    if (action === 'stop') {
      const result = db.prepare('UPDATE task_time SET ended=?, seconds=MAX(0,CAST((?-started)/1000 AS INTEGER)) WHERE id=? AND instance=? AND task=? AND author=? AND ended IS NULL').run(now,now,id,instance,taskId,author);
      if (!result.changes) return c.json({ error: 'Running timer not found or already stopped.' }, 409);
      return c.json({ ok: true });
    }
    if (action === 'delete') {
      const result = db.prepare("DELETE FROM task_time WHERE id=? AND instance=? AND task=? AND author=? AND ended IS NOT NULL AND review_state='pending' AND NOT EXISTS (SELECT 1 FROM loop_time WHERE time_id=task_time.id)").run(id,instance,taskId,author);
      if (!result.changes) return c.json({ error: 'Only your own pending completed entries not linked to a loop completion can be removed.' }, 403);
      return c.json({ ok: true });
    }
    return c.json({ error: 'Unknown action' }, 404);
  });
  return () => db.close();
}
