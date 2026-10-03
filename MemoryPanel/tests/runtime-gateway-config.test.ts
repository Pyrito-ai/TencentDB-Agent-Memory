import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadRuntimeGatewayConfig } from '../src/panel/config/runtime-gateway-config.js';

let root: string;
const valid = {
  origin: 'https://cdesktop.pyrito.com', appOrigins: ['https://app.pyrito.com'],
  socketPath: '/run/cdesktop/browser.sock', upstreamOrigin: 'http://127.0.0.1:5190',
  ownerInstanceId: 'default', ownerUserId: 'alice',
};
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'gateway-config-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function file(body: unknown) {
  const filename = path.join(root, 'gateway.json');
  await writeFile(filename, JSON.stringify(body)); return filename;
}

test('no environment setting leaves gateway disabled', () => {
  vi.stubEnv('CDESKTOP_GATEWAY_CONFIG', undefined);
  expect(loadRuntimeGatewayConfig()).toBeUndefined();
});
test('loads a single owner with a private second listener and fixed upstream', async () => {
  const filename = await file(valid);
  vi.stubEnv('CDESKTOP_GATEWAY_CONFIG', filename);
  expect(loadRuntimeGatewayConfig()).toEqual({ ...valid, port: 8126, bindHost: '0.0.0.0' });
});
test.each([
  { origin: 'http://cdesktop.pyrito.com' },
  { origin: 'https://app.pyrito.com' },
  { origin: 'https://cdesktop.pyrito.com/path' },
  { origin: 'https://name:secret@cdesktop.pyrito.com' },
  { origin: 'https://cdesktop.pyrito.com?token=secret' },
  { appOrigins: [] },
  { appOrigins: ['http://app.pyrito.com'] },
  { appOrigins: ['https://app.pyrito.com', 'https://app.pyrito.com'] },
  { socketPath: 'runtime.sock' },
  { socketPath: '/run/../tmp/runtime.sock' },
  { socketPath: '/run/invalid\u0000.sock' },
  { upstreamOrigin: 'http://127.0.0.1:8793' },
  { upstreamOrigin: 'https://attacker.example' },
  { ownerUserId: '' },
  { ownerInstanceId: '' },
  { port: 0 },
  { port: 65536 },
  { bindHost: 'attacker.example' },
  { arbitraryUpstream: 'https://attacker.example' },
])('rejects unsafe configuration without exposing its data: %j', async patch => {
  const filename = await file({ ...valid, ...patch });
  expect(() => loadRuntimeGatewayConfig(filename)).toThrow('Invalid cdesktop browser gateway configuration.');
});
test('explicit empty, missing, or unreadable config cannot silently disable the gateway', () => {
  expect(() => loadRuntimeGatewayConfig('')).toThrow('Invalid cdesktop browser gateway configuration.');
  expect(() => loadRuntimeGatewayConfig(path.join(root, 'missing'))).toThrow('Invalid cdesktop browser gateway configuration.');
});
test('malformed JSON does not leak source contents or file path', async () => {
  const filename = path.join(root, 'secret-config.json');
  await writeFile(filename, '{ credential: secret-value');
  let error: unknown;
  try { loadRuntimeGatewayConfig(filename); } catch (value) { error = value; }
  expect(String(error)).toBe('Error: Invalid cdesktop browser gateway configuration.');
});
