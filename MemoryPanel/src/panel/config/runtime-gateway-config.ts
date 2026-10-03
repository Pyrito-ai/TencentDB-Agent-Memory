import { readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { RuntimeGatewayConfig } from '../runtime-gateway.js';

const httpsOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  } catch { return false; }
});

const schema = z.object({
  origin: httpsOrigin,
  appOrigins: z.array(httpsOrigin).min(1),
  socketPath: z.string().min(1).refine((value) =>
    isAbsolute(value) && normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value)),
  // The fixed Unix socket is the transport; no caller chooses a TCP upstream.
  upstreamOrigin: z.literal('http://127.0.0.1:5190'),
  ownerInstanceId: z.string().trim().min(1).max(200),
  ownerUserId: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535).default(8126),
  bindHost: z.enum(['127.0.0.1', '0.0.0.0', '::1']).default('0.0.0.0'),
}).strict().refine((config) =>
  !config.appOrigins.includes(config.origin) &&
  new Set(config.appOrigins).size === config.appOrigins.length);

/** Unset disables the gateway. An explicitly configured invalid file stops startup. */
export function loadRuntimeGatewayConfig(
  file = process.env.CDESKTOP_GATEWAY_CONFIG,
): RuntimeGatewayConfig | undefined {
  if (file === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // Configuration paths and parser input may contain sensitive deployment data.
    throw new Error('Invalid cdesktop browser gateway configuration.');
  }
}
