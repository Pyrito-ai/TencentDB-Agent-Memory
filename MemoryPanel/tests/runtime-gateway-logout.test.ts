import { Hono } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';
import { registerAuthRoutes } from '../src/panel/http/routes/auth.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

let app: Hono, deps: PanelDeps;
const revokeUser = vi.fn(), destroySession = vi.fn(), getSession = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockImplementation(token => token === 'stored-idp-token'
    ? { instanceId: 'default', coreUserId: 'alice' } : null);
  deps = {
    config: { auth: { sessionCookieName: 'panel_session', sessionSecure: true } },
    runtimeGateway: { revokeUser },
    auth: { getSession, destroySession, listMethods: () => [] },
  } as unknown as PanelDeps;
  app = new Hono();
  registerAuthRoutes(app, deps);
});

test.each([
  ['/auth/logout', 'POST'], ['/auth/idp/woa/logout', 'GET'],
])('%s revokes the server-resolved IdP principal before destroying its session', async (route, method) => {
  const response = await app.request(route + '?instance_id=foreign&user_id=bob', {
    method, headers: { cookie: 'panel_session=stored-idp-token', 'X-Tdai-User-Key': 'untrusted-key' },
  });
  expect(response.status).toBe(method === 'GET' ? 302 : 200);
  expect(revokeUser).toHaveBeenCalledTimes(1);
  expect(revokeUser).toHaveBeenCalledWith('default', 'alice');
  expect(destroySession).toHaveBeenCalledWith('stored-idp-token');
  expect(revokeUser.mock.invocationCallOrder[0]!).toBeLessThan(destroySession.mock.invocationCallOrder[0]!);
  expect(response.headers.get('set-cookie')).toContain('panel_session=');
});

test('missing or expired sessions cannot revoke another principal', async () => {
  const response = await app.request('/auth/logout', { method: 'POST', headers: { cookie: 'panel_session=expired' } });
  expect(response.status).toBe(200);
  expect(revokeUser).not.toHaveBeenCalled();
  expect(destroySession).toHaveBeenCalledWith('expired');
});

test('gateway disabled preserves logout without requiring a session lookup', async () => {
  delete deps.runtimeGateway;
  expect((await app.request('/auth/logout', { method: 'POST' })).status).toBe(200);
  expect(getSession).not.toHaveBeenCalled();
  expect(destroySession).toHaveBeenCalled();
});
