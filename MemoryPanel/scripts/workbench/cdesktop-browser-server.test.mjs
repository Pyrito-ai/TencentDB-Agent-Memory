import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  isLocalRequest,
  parseBackend,
  parseConfiguration,
  startCdesktopBrowserServer,
} from "./cdesktop-browser-server.mjs";

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "cdesktop-browser-"));
  const root = path.join(base, "dist");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(root, "index.html"),
      "<!doctype html><title>cdesktop</title>",
    ),
    writeFile(
      path.join(root, "assets", "app-AbC12345.js"),
      "console.log('built')",
    ),
    writeFile(
      path.join(root, "assets", "app-AbC12345.js.map"),
      "private source",
    ),
    writeFile(path.join(root, ".env"), "private environment"),
    writeFile(path.join(root, "package.json"), '{"private":true}'),
    writeFile(path.join(root, "site.webmanifest"), '{"name":"cdesktop"}'),
    writeFile(path.join(root, "robots.txt"), "User-agent: *\nDisallow: /\n"),
    writeFile(path.join(root, "private-notes.txt"), "private notes"),
    writeFile(path.join(base, "secret.js"), "private content"),
  ]);
  await symlink(path.join(base, "secret.js"), path.join(root, "escape.js"));
  await symlink(path.join(root, "assets"), path.join(root, "linked-assets"));
  const requests = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts);
    requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body,
    });
    if (req.url === "/api/slow") return;
    if (req.url === "/api/disconnect") return req.socket.destroy();
    if (req.url === "/api/compressed") {
      const compressed = gzipSync('{"success":true,"data":[1,2,3]}');
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": compressed.length,
      });
      return res.end(compressed);
    }
    if (req.url === "/api/status") {
      res.writeHead(418, { "Content-Type": "application/json" });
      return res.end('{"success":false,"message":"exact backend result"}');
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Set-Cookie": "backend_secret=private; HttpOnly",
      "Content-Disposition": "attachment; filename=sample.bin",
      "X-Backend": "preserved",
      Connection: "close, x-internal-hop",
      "X-Internal-Hop": "remove me",
    });
    for (let offset = 0; offset < body.length; offset += 4096)
      res.write(body.subarray(offset, offset + 4096));
    res.end();
  });
  upstream.on("connection", (socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  upstream.on("upgrade", (req, socket, head) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url === "/api/slow") return;
    if (req.url === "/api/rejected") {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: echo\r\nSet-Cookie: should_not_reach_browser=1\r\n\r\n`,
    );
    // Immediate server bytes exercise the upstream upgrade head buffer.
    socket.write(Buffer.from([0x81, 2, 104, 105]));
    let pending = Buffer.alloc(0);
    function echo(data) {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 6) {
        const size = pending[1] & 0x7f;
        if (pending.length < size + 6) return;
        const payload = pending
          .subarray(6, size + 6)
          .map((byte, i) => byte ^ pending[2 + (i % 4)]);
        socket.write(Buffer.concat([Buffer.from([pending[0], size]), payload]));
        pending = pending.subarray(size + 6);
      }
    }
    socket.on("data", echo);
    if (head.length) echo(head);
    socket.on("error", () => socket.destroy());
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const instance = await startCdesktopBrowserServer({
    staticDir: root,
    port: 0,
    backend: `http://127.0.0.1:${upstream.address().port}`,
    ...options,
  });
  t.after(async () => {
    await instance.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  return { ...instance, root, requests, upstream };
}

function request(origin, route, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      origin,
      { method, path: route, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body)
      for (let i = 0; i < body.length; i += 8192)
        req.write(body.subarray(i, i + 8192));
    req.end();
  });
}

test("configuration fixes the listener to loopback and rejects nonlocal backends", () => {
  const config = parseConfiguration([], {});
  assert.equal(config.port, 5192);
  assert.equal(config.backend, "http://127.0.0.1:8131");
  assert.equal(parseBackend("http://localhost:8131").hostname, "127.0.0.1");
  assert.equal(parseBackend("http://[::1]:8131").hostname, "[::1]");
  for (const backend of [
    "https://127.0.0.1:8131",
    "http://example.com",
    "http://127.0.0.1/api",
    "http://user:pass@127.0.0.1",
    "http://127.0.0.1?upstream=foreign",
    "http://127.0.0.1#fragment",
  ])
    assert.throws(() => parseBackend(backend));
  for (const port of ["0", "65536", "-1", "51x", "1.5"])
    assert.throws(() => parseConfiguration(["--port", port], {}));
  assert.throws(() => parseConfiguration(["--host", "0.0.0.0"], {}));
  assert.deepEqual(
    parseConfiguration(
      [
        "--port",
        "5193",
        "--static-dir",
        "/tmp/dist",
        "--backend",
        "http://127.0.0.1:8132",
      ],
      {},
    ),
    {
      port: 5193,
      staticDir: "/tmp/dist",
      backend: "http://127.0.0.1:8132",
    },
  );
});

test("source IP, Host, Origin, and browser fetch-site are independently checked", () => {
  const make = (changes = {}) => ({
    socket: { remoteAddress: "127.0.0.1" },
    rawHeaders: ["Host", "127.0.0.1:5192"],
    headers: { host: "127.0.0.1:5192" },
    ...changes,
  });
  assert.equal(isLocalRequest(make(), 5192), true);
  assert.equal(
    isLocalRequest(make({ socket: { remoteAddress: "192.0.2.5" } }), 5192),
    false,
  );
  assert.equal(isLocalRequest(make({ rawHeaders: [] }), 5192), false);
  assert.equal(
    isLocalRequest(
      make({ rawHeaders: ["Host", "127.0.0.1:5192", "Host", "evil.example"] }),
      5192,
    ),
    false,
  );
  assert.equal(
    isLocalRequest(make({ headers: { host: "evil.example" } }), 5192),
    false,
  );
  assert.equal(
    isLocalRequest(
      make({ headers: { host: "127.0.0.1:5192", origin: "null" } }),
      5192,
    ),
    false,
  );
  assert.equal(
    isLocalRequest(
      make({
        headers: { host: "127.0.0.1:5192", origin: "https://evil.example" },
      }),
      5192,
    ),
    false,
  );
  assert.equal(
    isLocalRequest(
      make({
        headers: { host: "127.0.0.1:5192", "sec-fetch-site": "cross-site" },
      }),
      5192,
    ),
    false,
  );
});

test("serves built files, HEAD, and HTML navigation fallback with correct cache and MIME", async (t) => {
  const server = await fixture(t);
  assert.equal(server.server.address().address, "127.0.0.1");
  const home = await request(server.origin, "/");
  assert.equal(home.status, 200);
  assert.match(home.headers["content-type"], /^text\/html/);
  assert.equal(home.headers["cache-control"], "no-cache");
  const head = await request(server.origin, "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers["content-length"]), home.body.length);
  const page = await request(
    server.origin,
    "/projects/example/tasks?panel=details",
    { headers: { Accept: "text/html,application/xhtml+xml" } },
  );
  assert.deepEqual(page.body, home.body);
  const asset = await request(server.origin, "/assets/app-AbC12345.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.body.toString(), "console.log('built')");
  assert.match(asset.headers["cache-control"], /immutable/);
  assert.match(asset.headers["content-type"], /^text\/javascript/);
  assert.match(
    (await request(server.origin, "/site.webmanifest")).headers["content-type"],
    /^application\/manifest\+json/,
  );
  assert.equal((await request(server.origin, "/robots.txt")).status, 200);
  assert.equal(
    (
      await request(server.origin, "/projects/example", {
        headers: { Accept: "application/json" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(server.origin, "/assets/missing.js", {
        headers: { Accept: "text/html" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(server.origin, "/assets/missing", {
        headers: { Accept: "text/html" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(server.origin, "/projects/example", {
        method: "POST",
        headers: { Accept: "text/html" },
      })
    ).status,
    405,
  );
});

test("denies foreign browser requests, bad hosts, traversal, sources, private files, and symlinks", async (t) => {
  const server = await fixture(t);
  for (const headers of [
    { Host: "evil.example" },
    { Host: "127.0.0.1:9999" },
    { Origin: "https://evil.example" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
  ])
    assert.equal(
      (await request(server.origin, "/api/config", { headers })).status,
      403,
    );
  for (const route of [
    "/../secret.js",
    "/assets/%2e%2e/secret.js",
    "/assets/..%2fsecret.js",
    "/assets/%255csecret.js",
    "/assets/%00.js",
    "/assets/%zz",
    "//evil.example/api/config",
    "http://evil.example/api/config",
  ])
    assert.equal((await request(server.origin, route)).status, 400, route);
  for (const route of [
    "/.env",
    "/.git/config",
    "/package.json",
    "/private-notes.txt",
    "/src/app.ts",
    "/assets/app-AbC12345.js.map",
    "/escape.js",
    "/linked-assets/app-AbC12345.js",
  ])
    assert.equal(
      (
        await request(server.origin, route, {
          headers: { Accept: "text/html" },
        })
      ).status,
      404,
      route,
    );
  assert.equal(server.requests.length, 0);
});

test("streams non-GET binary request and response, remaps local origin, and removes identity headers", async (t) => {
  const server = await fixture(t);
  const body = Buffer.alloc(512 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = i % 256;
  const result = await request(
    server.origin,
    "/api/attachments?mode=original",
    {
      method: "PUT",
      body,
      headers: {
        Host: "127.0.0.1:5190",
        Origin: "http://127.0.0.1:5190",
        "Content-Type": "application/octet-stream",
        Cookie: "gateway_session=secret",
        Forwarded: "for=203.0.113.5",
        "X-Forwarded-For": "203.0.113.5",
        "X-Forwarded-Host": "evil.example",
        "X-Real-IP": "203.0.113.5",
        "CF-Connecting-IP": "203.0.113.5",
        Connection: "close, x-hop",
        "X-Hop": "remove",
        Authorization: "Bearer user-owned-session",
        "X-Application": "keep",
      },
    },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, body);
  assert.equal(result.headers["content-type"], "application/octet-stream");
  assert.equal(
    result.headers["content-disposition"],
    "attachment; filename=sample.bin",
  );
  assert.equal(result.headers["x-backend"], "preserved");
  assert.equal(result.headers["x-internal-hop"], undefined);
  assert.equal(result.headers["set-cookie"], undefined);
  const [received] = server.requests;
  assert.equal(received.method, "PUT");
  assert.equal(received.url, "/api/attachments?mode=original");
  assert.deepEqual(received.body, body);
  assert.equal(received.headers.host, "127.0.0.1:5190");
  assert.equal(received.headers.origin, "http://127.0.0.1:5190");
  for (const name of [
    "cookie",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-real-ip",
    "cf-connecting-ip",
    "x-hop",
  ])
    assert.equal(received.headers[name], undefined, name);
  assert.equal(received.headers.authorization, "Bearer user-owned-session");
  assert.equal(received.headers["x-application"], "keep");
});

test("preserves backend JSON status and compressed bytes without parsing envelopes", async (t) => {
  const server = await fixture(t);
  const result = await request(server.origin, "/api/status");
  assert.equal(result.status, 418);
  assert.equal(
    result.body.toString(),
    '{"success":false,"message":"exact backend result"}',
  );
  const compressed = await request(server.origin, "/api/compressed");
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.deepEqual(
    compressed.body,
    gzipSync('{"success":true,"data":[1,2,3]}'),
  );
});

test("times out a stalled local API with a bounded gateway response", async (t) => {
  const server = await fixture(t, { httpIdleTimeoutMs: 30 });
  assert.equal((await request(server.origin, "/api/slow")).status, 504);
  assert.equal((await request(server.origin, "/api/disconnect")).status, 502);
  assert.equal((await request(server.origin, "/")).status, 200);
});

function rawWebSocket(origin, overrides = {}, route = "/api/events?watch=1") {
  return new Promise((resolve, reject) => {
    const parsed = new URL(origin);
    const socket = net.connect(Number(parsed.port), "127.0.0.1");
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const frame = Buffer.from([0x81, 0x84, 1, 2, 3, 4, 113, 107, 109, 99]); // masked "ping"
    let data = Buffer.alloc(0);
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("WebSocket test timed out"));
    });
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers = data.subarray(0, end).toString();
      if (!headers.startsWith("HTTP/1.1 101") || data.length >= end + 4 + 10) {
        socket.destroy();
        resolve({ headers, body: data.subarray(end + 4) });
      }
    });
    socket.once("connect", () => {
      const headers = {
        Host: "127.0.0.1:5190",
        Origin: "http://127.0.0.1:5190",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Protocol": "echo, other",
        Cookie: "gateway_session=secret",
        "X-Forwarded-For": "203.0.113.5",
        ...overrides,
      };
      // Include a frame with the handshake to exercise the client head buffer.
      socket.write(
        Buffer.concat([
          Buffer.from(
            `GET ${route} HTTP/1.1\r\n${Object.entries(headers)
              .map(([name, value]) => `${name}: ${value}`)
              .join("\r\n")}\r\n\r\n`,
          ),
          frame,
        ]),
      );
    });
  });
}

test("proxies WebSocket handshake, selected protocol, both head buffers, and echo bytes", async (t) => {
  const server = await fixture(t);
  const result = await rawWebSocket(server.origin);
  assert.match(result.headers, /^HTTP\/1.1 101/);
  assert.match(result.headers, /sec-websocket-protocol: echo\r\n/i);
  assert.doesNotMatch(result.headers, /set-cookie/i);
  assert.deepEqual(
    result.body,
    Buffer.from([0x81, 2, 104, 105, 0x81, 4, 112, 105, 110, 103]),
  );
  const [received] = server.requests;
  assert.equal(received.url, "/api/events?watch=1");
  assert.equal(received.headers.host, "127.0.0.1:5190");
  assert.equal(received.headers.origin, "http://127.0.0.1:5190");
  assert.equal(received.headers["sec-websocket-protocol"], "echo, other");
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers["x-forwarded-for"], undefined);
});

test("WebSocket foreign origins and invalid Host are rejected before upstream connect", async (t) => {
  const server = await fixture(t);
  for (const overrides of [
    { Origin: "https://evil.example" },
    { Host: "evil.example" },
  ])
    assert.match(
      (await rawWebSocket(server.origin, overrides)).headers,
      /^HTTP\/1.1 403/,
    );
  assert.equal(server.requests.length, 0);
});

test("WebSocket upgrade rejects non-API routes and handles upstream rejection and timeout", async (t) => {
  const server = await fixture(t, { upgradeTimeoutMs: 30 });
  assert.match(
    (await rawWebSocket(server.origin, {}, "/assets/app-AbC12345.js")).headers,
    /^HTTP\/1.1 404/,
  );
  assert.equal(server.requests.length, 0);
  assert.match(
    (await rawWebSocket(server.origin, {}, "/api/rejected")).headers,
    /^HTTP\/1.1 502/,
  );
  assert.match(
    (await rawWebSocket(server.origin, {}, "/api/slow")).headers,
    /^HTTP\/1.1 504/,
  );
  assert.equal((await request(server.origin, "/")).status, 200);
});
