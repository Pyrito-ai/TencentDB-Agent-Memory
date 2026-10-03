import { createHash, randomBytes } from 'node:crypto';
import http, { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import type { Duplex } from 'node:stream';

/** A gateway exposes the owner's entire runtime, not an individual task sandbox. */
export interface RuntimeGatewayConfig {
  origin: string;
  appOrigins: readonly string[];
  socketPath: string;
  upstreamOrigin: string;
  ownerInstanceId: string;
  ownerUserId: string;
  port: number;
  bindHost?: string;
}
export interface RuntimeGatewayGrant {
  instanceId: string;
  userId: string;
  teamId: string;
  taskId: string;
  handoffId: string;
  bindingId: string;
  workspaceId: string;
  sessionId: string;
  /** Must re-read current authorization, runtime binding, and handoff validity. */
  validate: () => Promise<boolean>;
}
export interface RuntimeGateway {
  readonly config: Readonly<RuntimeGatewayConfig>;
  issueGrant(grant: RuntimeGatewayGrant): Promise<{ bootstrapUrl: string; ticket: string; expiresAt: string }>;
  revokeUser(instanceId: string, userId: string): void;
  revokeAll(): void;
  start(): Server;
  close(): Promise<void>;
}

const COOKIE = '__Host-pyrito-runtime';
const TICKET_TTL = 60_000;
const IDLE_TTL = 15 * 60_000;
const HARD_TTL = 60 * 60_000;
// A 10s cache plus a 1s sweep and a bounded 4s lookup keeps socket checks <=15s.
const VALIDATION_CACHE = 10_000;
const VALIDATION_TIMEOUT = 4_000;
const IO_TIMEOUT = 60_000;
const REQUEST_TIMEOUT = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const INLINE_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/tiff']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

type Ticket = { grant: RuntimeGatewayGrant; expiresAt: number; epoch: number };
type Session = {
  grant: RuntimeGatewayGrant;
  hardExpiresAt: number;
  idleExpiresAt: number;
  lastValidatedAt: number;
  validation?: Promise<boolean>;
  revoked: boolean;
  cancel: Set<() => void>;
};

function exactOrigin(value: string, protocol = 'https:'): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Runtime gateway origin must be an exact origin.'); }
  if (parsed.protocol !== protocol || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error(`Runtime gateway origin must be an exact ${protocol} origin.`);
  }
  return parsed;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function secret(): string { return randomBytes(32).toString('base64url'); }
function safePath(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(raw)) return null;
  const path = raw.split('?')[0]!;
  // Reject encoded separators and double encoding before any downstream URL normalization.
  if (/%(?:2f|5c|25)/i.test(path)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(path); decodeURIComponent(raw); } catch { return null; }
  if (/[\\\x00-\x1f\x7f]/.test(decoded) || decoded.includes('//') || decoded.split('/').some(p => p === '.' || p === '..')) return null;
  return decoded;
}
function connectionHeaders(message: IncomingMessage): Set<string> {
  return new Set((message.headers.connection ?? '').split(',').map(name => name.trim().toLowerCase()));
}
function isPrivatePath(path: string): boolean { return path === '/_pyrito' || path.startsWith('/_pyrito/'); }
function isPreviewPath(path: string): boolean { return path === '/api/preview' || path.startsWith('/api/preview/'); }
function isAttachmentPath(path: string): boolean {
  return /^\/api\/(?:attachments\/[^/]+\/file|workspaces\/[^/]+\/attachments\/file(?:\/.*)?)$/.test(path);
}
function safeIncoming(req: IncomingMessage, host: string): boolean {
  if (req.headers.host !== host || !safePath(req.url)) return false;
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    // Browsers use one field per header. Reject ambiguous duplicate framing/auth fields.
    if (seen.has(name) && ['host', 'origin', 'cookie', 'authorization', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'sec-fetch-site', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'].includes(name)) return false;
    seen.add(name);
    if (/[\r\n\x00]/.test(req.rawHeaders[i + 1]!)) return false;
  }
  if (req.headers['transfer-encoding'] && req.headers['transfer-encoding'] !== 'chunked') return false;
  if (req.headers['transfer-encoding'] && req.headers['content-length']) return false;
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && !['same-origin', 'same-site', 'none'].includes(String(fetchSite))) return false;
  return true;
}
function requestHeaders(req: IncomingMessage, upstream: URL, upgrade = false): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const connection = connectionHeaders(req);
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_HEADERS.has(name) || connection.has(name) ||
        ['host', 'origin', 'cookie', 'cookie2', 'authorization', 'referer', 'forwarded', 'x-real-ip'].includes(name) ||
        name.startsWith('x-forwarded-') || name.startsWith('proxy-')) continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  headers.origin = upstream.origin;
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
  return headers;
}
function boundedValidation(validate: () => Promise<boolean>): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false), VALIDATION_TIMEOUT);
    timeout.unref();
    Promise.resolve().then(validate).then(value => { clearTimeout(timeout); resolve(value === true); }, () => { clearTimeout(timeout); resolve(false); });
  });
}

export function createRuntimeGateway(config: RuntimeGatewayConfig): RuntimeGateway {
  const external = exactOrigin(config.origin);
  const appOrigins = config.appOrigins.map(origin => exactOrigin(origin).origin);
  const upstream = exactOrigin(config.upstreamOrigin, 'http:');
  const bindHost = config.bindHost ?? '127.0.0.1';
  if (!appOrigins.length || !isAbsolute(config.socketPath) || config.socketPath.includes('\0') ||
      upstream.origin !== 'http://127.0.0.1:5190' || !['127.0.0.1', '::1', '0.0.0.0'].includes(bindHost) ||
      !Number.isInteger(config.port) || config.port < 0 || config.port > 65535 ||
      !config.ownerInstanceId?.trim() || !config.ownerUserId?.trim()) throw new Error('Invalid runtime gateway configuration.');
  // Copy all config values used by request handlers; caller mutation cannot widen access.
  const snapshotConfig = Object.freeze({ ...config, appOrigins: Object.freeze([...appOrigins]) });
  const socketPath = config.socketPath;
  const port = config.port;
  const ownerInstanceId = config.ownerInstanceId;
  const ownerUserId = config.ownerUserId;
  const allowedApps = new Set(appOrigins);
  const tickets = new Map<string, Ticket>();
  const sessions = new Map<string, Session>();
  const connections = new Set<Duplex>();
  let epoch = 0;
  let started = false;
  let closed = false;
  let sweep: ReturnType<typeof setInterval> | undefined;

  function securityHeaders(): OutgoingHttpHeaders {
    return {
      'cache-control': 'no-store',
      'content-security-policy': `frame-ancestors ${appOrigins.join(' ')}; frame-src 'none'; object-src 'none';`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
  }
  function respond(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' });
    res.end(message);
  }
  function socketError(socket: Duplex, status: number): void {
    if (socket.destroyed) return;
    const body = status === 502 ? 'Runtime unavailable. Reload Workbench and reconnect.' : 'Runtime access denied. Reload Workbench to reconnect.';
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
  }
  function revoke(session: Session): void {
    if (session.revoked) return;
    session.revoked = true;
    for (const cancel of session.cancel) cancel();
    session.cancel.clear();
  }
  function active(session: Session, now = Date.now()): boolean {
    return !session.revoked && now < session.idleExpiresAt && now < session.hardExpiresAt;
  }
  async function validateSession(session: Session): Promise<boolean> {
    if (!active(session)) { revoke(session); return false; }
    if (session.validation) return session.validation;
    if (Date.now() - session.lastValidatedAt < VALIDATION_CACHE) return true;
    const checkStarted = Date.now();
    session.validation = boundedValidation(session.grant.validate).then(ok => {
      if (!ok || !active(session)) { revoke(session); return false; }
      session.lastValidatedAt = checkStarted;
      return true;
    }).finally(() => { session.validation = undefined; });
    return session.validation;
  }
  function readCookie(req: IncomingMessage): string | null {
    const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (values.length !== 1) return null;
    const value = values[0]!.slice(COOKIE.length + 1);
    return OPAQUE.test(value) ? value : null;
  }
  async function authenticate(req: IncomingMessage): Promise<{ session: Session; token: string } | null> {
    const token = readCookie(req);
    const session = token ? sessions.get(hash(token)) : undefined;
    if (!token || !session || !await validateSession(session) || !active(session)) return null;
    // Activity comes only from authenticated browser HTTP/upgrade requests, never socket frames/sweeps.
    session.idleExpiresAt = Math.min(Date.now() + IDLE_TTL, session.hardExpiresAt);
    return { session, token };
  }
  function cookie(token: string, session: Session): string {
    return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((Math.min(session.idleExpiresAt, session.hardExpiresAt) - Date.now()) / 1000))}`;
  }
  function upstreamHeaders(message: IncomingMessage, session: Session, token: string, path: string): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {};
    const connection = connectionHeaders(message);
    for (const [name, value] of Object.entries(message.headers)) {
      if (value === undefined || HOP_HEADERS.has(name) || connection.has(name) ||
          ['set-cookie', 'set-cookie2', 'x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'cache-control', 'referrer-policy'].includes(name) || name.startsWith('access-control-')) continue;
      headers[name] = value;
    }
    const upstreamPolicies: string[] = [];
    for (let i = 0; i < message.rawHeaders.length; i += 2) {
      if (message.rawHeaders[i]!.toLowerCase() !== 'content-security-policy') continue;
      const policy = message.rawHeaders[i + 1]!.split(';').filter(rule => !/^\s*frame-ancestors(?:\s|$)/i.test(rule)).join(';');
      if (policy.trim()) upstreamPolicies.push(policy);
    }
    Object.assign(headers, securityHeaders());
    // A CSP policy list retains upstream restrictions while our separate policy also applies.
    if (upstreamPolicies.length) headers['content-security-policy'] = [...upstreamPolicies, String(headers['content-security-policy'])].join(', ');
    headers['set-cookie'] = cookie(token, session);
    if (isAttachmentPath(path)) {
      // Native attachments are untrusted content, even when produced by the owner's worker.
      // Keep raster images inline; force HTML/SVG/PDF/unknown types out of the authenticated origin.
      const mime = String(headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      headers['content-security-policy'] = `${String(securityHeaders()['content-security-policy'])} sandbox; default-src 'none';`;
      if (!INLINE_ATTACHMENT_TYPES.has(mime)) {
        headers['content-type'] = 'application/octet-stream';
        const disposition = String(headers['content-disposition'] ?? '');
        headers['content-disposition'] = /^(?:inline|attachment)(?:;|$)/i.test(disposition) ? disposition.replace(/^(?:inline|attachment)/i, 'attachment') : 'attachment';
      }
    }
    if (headers.location) {
      const location = String(headers.location);
      const relative = location.startsWith(upstream.origin + '/') ? location.slice(upstream.origin.length) : location;
      if (!safePath(relative) || isPrivatePath(safePath(relative)!)) throw new Error('Invalid upstream redirect.');
      headers.location = relative;
    }
    return headers;
  }
  async function exchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { respond(res, 405, 'Use the Workbench reconnect action.'); return; }
    if (!allowedApps.has(String(req.headers.origin ?? ''))) { respond(res, 403, 'Runtime access denied.'); return; }
    if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] ?? ''))) {
      respond(res, 415, 'Expected a Workbench session form.'); return;
    }
    if (Number(req.headers['content-length'] ?? 0) > 1024) { respond(res, 413, 'Session form is too large.'); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    const bodyTimeout = setTimeout(() => { respond(res, 408, 'Session form timed out.'); req.destroy(); }, 10_000);
    bodyTimeout.unref();
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += bytes.length;
        if (size > 1024) { respond(res, 413, 'Session form is too large.'); return; }
        chunks.push(bytes);
      }
    } finally { clearTimeout(bodyTimeout); }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const rawTicket = fields.get('ticket');
    if (fields.size !== 1 || !rawTicket || !OPAQUE.test(rawTicket)) { respond(res, 400, 'Invalid session form.'); return; }
    const key = hash(rawTicket);
    const ticket = tickets.get(key);
    // Consume before the asynchronous authorization check: concurrent redemption cannot replay.
    tickets.delete(key);
    if (!ticket || ticket.expiresAt <= Date.now() || ticket.epoch !== epoch) { respond(res, 401, 'Session link expired. Reload Workbench to reconnect.'); return; }
    const validationStarted = Date.now();
    if (!await boundedValidation(ticket.grant.validate) || ticket.epoch !== epoch || ticket.expiresAt <= Date.now() || closed) {
      respond(res, 403, 'Runtime authorization expired. Reload Workbench to reconnect.'); return;
    }
    const now = Date.now();
    const token = secret();
    const session: Session = { grant: ticket.grant, hardExpiresAt: now + HARD_TTL, idleExpiresAt: now + IDLE_TTL, lastValidatedAt: validationStarted, revoked: false, cancel: new Set() };
    // Old sessions are evicted rather than allowing unbounded owner-issued state.
    while (sessions.size >= 256) { const entry = sessions.entries().next().value!; revoke(entry[1]); sessions.delete(entry[0]); }
    sessions.set(hash(token), session);
    res.writeHead(303, { ...securityHeaders(), 'set-cookie': cookie(token, session), location: `/workspaces/${ticket.grant.workspaceId}?embed=1&sessionId=${ticket.grant.sessionId}` });
    res.end();
  }
  function proxy(req: IncomingMessage, res: ServerResponse, session: Session, token: string): void {
    if (!active(session)) { respond(res, 401, 'Runtime session expired. Reload Workbench to reconnect.'); return; }
    const upstreamRequest = http.request({ socketPath, path: req.url, method: req.method, headers: requestHeaders(req, upstream), agent: false });
    const cancel = () => { upstreamRequest.destroy(); res.destroy(); };
    session.cancel.add(cancel);
    const totalTimeout = setTimeout(() => { respond(res, 504, 'Runtime request timed out. Reload Workbench and reconnect.'); upstreamRequest.destroy(); }, REQUEST_TIMEOUT);
    totalTimeout.unref();
    const cleanup = () => { clearTimeout(totalTimeout); session.cancel.delete(cancel); };
    upstreamRequest.setTimeout(IO_TIMEOUT, () => { respond(res, 504, 'Runtime request timed out. Reload Workbench and reconnect.'); upstreamRequest.destroy(); });
    upstreamRequest.on('error', () => { cleanup(); if (!res.destroyed) respond(res, 502, 'Runtime unavailable. Reload Workbench and reconnect.'); });
    res.on('close', () => { cleanup(); upstreamRequest.destroy(); });
    req.on('aborted', cancel);
    req.on('error', cancel);
    upstreamRequest.on('response', upstreamResponse => {
      if (!active(session)) { revoke(session); return; }
      try { res.writeHead(upstreamResponse.statusCode ?? 502, upstreamHeaders(upstreamResponse, session, token, safePath(req.url)!)); }
      catch { upstreamResponse.destroy(); respond(res, 502, 'Runtime returned an invalid response. Reload Workbench and reconnect.'); return; }
      upstreamResponse.on('error', () => res.destroy());
      upstreamResponse.on('aborted', () => res.destroy());
      upstreamResponse.pipe(res);
    });
    req.pipe(upstreamRequest);
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: true }, (req, res) => {
    void (async () => {
      if (!safeIncoming(req, external.host)) { respond(res, 403, 'Runtime request rejected.'); return; }
      const path = safePath(req.url)!;
      if (path === '/_pyrito/session' && req.url === '/_pyrito/session') { await exchange(req, res); return; }
      if (isPrivatePath(path)) { respond(res, 404, 'Not found.'); return; }
      if (isPreviewPath(path)) { respond(res, 403, 'Runtime previews are unavailable in this gateway.'); return; }
      if (!['GET', 'HEAD'].includes(req.method ?? '') && req.headers.origin !== external.origin) { respond(res, 403, 'Runtime origin rejected.'); return; }
      // Also reject explicitly foreign Origins on read requests (ordinary navigation omits Origin).
      if (req.headers.origin !== undefined && req.headers.origin !== external.origin) { respond(res, 403, 'Runtime origin rejected.'); return; }
      const authenticated = await authenticate(req);
      if (!authenticated) { respond(res, 401, 'Runtime session expired. Reload Workbench to reconnect.'); return; }
      proxy(req, res, authenticated.session, authenticated.token);
    })().catch(() => { if (!res.destroyed) respond(res, 502, 'Runtime unavailable. Reload Workbench and reconnect.'); });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = IO_TIMEOUT;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  server.on('connection', socket => { connections.add(socket); socket.on('error', () => {}); socket.on('close', () => connections.delete(socket)); });
  server.on('clientError', (_error, socket) => socketError(socket, 400));
  server.on('upgrade', (req, socket, head) => {
    // Buffer early frames while asynchronous authorization and the upstream handshake run.
    socket.pause();
    void (async () => {
      if (!safeIncoming(req, external.host) || isPrivatePath(safePath(req.url)!) || isPreviewPath(safePath(req.url)!) || req.method !== 'GET' || req.headers.origin !== external.origin ||
          String(req.headers.upgrade).toLowerCase() !== 'websocket' || !connectionHeaders(req).has('upgrade') || req.headers['sec-websocket-version'] !== '13' ||
          typeof req.headers['sec-websocket-key'] !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'])) { socketError(socket, 403); return; }
      const authenticated = await authenticate(req);
      if (!authenticated) { socketError(socket, 401); return; }
      if (socket.destroyed) return;
      const { session, token } = authenticated;
      if (!active(session)) { socketError(socket, 401); return; }
      const upstreamRequest: ClientRequest = http.request({ socketPath, path: req.url, method: 'GET', headers: requestHeaders(req, upstream, true), agent: false });
      let upgraded: Duplex | undefined;
      const cancel = () => { upstreamRequest.destroy(); upgraded?.destroy(); socket.destroy(); };
      session.cancel.add(cancel);
      const timeout = setTimeout(() => { socketError(socket, 502); upstreamRequest.destroy(); }, 10_000);
      timeout.unref();
      const cleanup = () => { clearTimeout(timeout); session.cancel.delete(cancel); };
      socket.on('close', () => { cleanup(); upstreamRequest.destroy(); upgraded?.destroy(); });
      socket.on('error', cancel);
      upstreamRequest.on('error', () => { cleanup(); if (!upgraded) socketError(socket, 502); });
      upstreamRequest.on('response', response => { response.destroy(); cleanup(); socketError(socket, 502); });
      upstreamRequest.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        upgraded = upstreamSocket;
        clearTimeout(timeout);
        upstreamSocket.on('error', cancel);
        upstreamSocket.on('close', () => { cleanup(); socket.destroy(); });
        const expectedAccept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        const selectedProtocol = response.headers['sec-websocket-protocol'];
        const offeredProtocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
        if (!active(session) || response.statusCode !== 101 || String(response.headers.upgrade).toLowerCase() !== 'websocket' ||
            !connectionHeaders(response).has('upgrade') || response.headers['sec-websocket-accept'] !== expectedAccept ||
            (selectedProtocol !== undefined && (typeof selectedProtocol !== 'string' || !offeredProtocols.includes(selectedProtocol)))) { socketError(socket, 502); upstreamSocket.destroy(); return; }
        let headers: OutgoingHttpHeaders;
        try { headers = upstreamHeaders(response, session, token, safePath(req.url)!); }
        catch { socketError(socket, 502); upstreamSocket.destroy(); return; }
        headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
        const lines = ['HTTP/1.1 101 Switching Protocols'];
        for (const [name, value] of Object.entries(headers)) for (const part of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${part}`);
        socket.write(lines.join('\r\n') + '\r\n\r\n');
        upstreamSocket.setTimeout?.(0);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
      upstreamRequest.end();
    })().catch(() => socketError(socket, 502));
  });

  const manager: RuntimeGateway = {
    config: snapshotConfig,
    async issueGrant(grant) {
      if (closed || grant.instanceId !== ownerInstanceId || grant.userId !== ownerUserId) throw new Error('Runtime access is restricted to the configured owner.');
      if (!UUID.test(grant.workspaceId) || !UUID.test(grant.sessionId) || typeof grant.validate !== 'function' ||
          [grant.teamId, grant.taskId, grant.handoffId, grant.bindingId].some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid runtime binding.');
      // Snapshot identifiers and the closure before waiting so callers cannot mutate the grant.
      const snapshot = { ...grant };
      const issuedEpoch = epoch;
      if (!await boundedValidation(snapshot.validate) || issuedEpoch !== epoch || closed) throw new Error('Runtime authorization is no longer valid.');
      const now = Date.now();
      for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
      while (tickets.size >= 1024) tickets.delete(tickets.keys().next().value!);
      const ticket = secret();
      const expiresAt = now + TICKET_TTL;
      tickets.set(hash(ticket), { grant: snapshot, expiresAt, epoch });
      return { bootstrapUrl: `${external.origin}/_pyrito/session`, ticket, expiresAt: new Date(expiresAt).toISOString() };
    },
    revokeUser(instanceId, userId) { if (instanceId === ownerInstanceId && userId === ownerUserId) manager.revokeAll(); },
    revokeAll() { epoch++; tickets.clear(); for (const session of sessions.values()) revoke(session); sessions.clear(); },
    start() {
      if (closed) throw new Error('Runtime gateway is closed.');
      if (!started) {
        started = true;
        sweep = setInterval(() => {
          const now = Date.now();
          for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
          for (const [key, session] of sessions) {
            if (!active(session, now)) { revoke(session); sessions.delete(key); }
            else if (session.cancel.size && now - session.lastValidatedAt >= VALIDATION_CACHE) void validateSession(session);
          }
        }, 1000);
        sweep.unref();
        server.listen(port, bindHost);
      }
      return server;
    },
    async close() {
      closed = true;
      if (sweep) clearInterval(sweep);
      manager.revokeAll();
      for (const socket of connections) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
  return manager;
}
