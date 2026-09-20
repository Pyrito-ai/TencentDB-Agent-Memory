import { registerTaskTimeRoutes } from '../src/panel/http/routes/task-time.js';
/** Synthetic local-only API for the browser fixture; never points at a real kernel. */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { registerTaskActivityRoutes } from '../src/panel/http/routes/task-activity.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const api = new Hono();
const deps = {
 instanceRegistry: { resolve: (id: string) => ({ instance_id: id, gateway_endpoint: '', api_key: '' }) },
 metaKernel: { invoke: async (action: string, body: any) => ({ code: 0, data:
  action === 'auth/verify' ? { valid: body.user_key === 'john', user: { user_id: 'john' } } :
  action === 'task/get' ? { team_id: 'preview', creator_user_id: 'john' } :
  action === 'team-member/get' ? { status: 'active' } : null }) },
} as unknown as PanelDeps;
const root = await mkdtemp(path.join(tmpdir(), 'board-preview-'));
registerTaskActivityRoutes(api, deps, root);
registerTaskTimeRoutes(api, deps, root);
const app = new Hono();app.route('/api/v1', api);
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8123 });
console.log('Synthetic task activity API: http://127.0.0.1:8123');
