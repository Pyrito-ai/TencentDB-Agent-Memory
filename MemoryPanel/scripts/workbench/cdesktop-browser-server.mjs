#!/usr/bin/env node
/** Serve a compiled cdesktop UI and its fixed local API. Never bind publicly. */
import http from "node:http";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_ORIGIN = "http://127.0.0.1:5190";
const DEFAULT_STATIC_DIR = fileURLToPath(
  new URL(
    "../../../../cdesktop-workbench/packages/local-web/dist/",
    import.meta.url,
  ),
);
const MIME = new Map(
  Object.entries({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
  }),
);
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const IDENTITY_HEADERS = new Set([
  "cookie",
  "cookie2",
  "forwarded",
  "via",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "fastly-client-ip",
]);

function parsePort(value, allowZero = false) {
  if (!/^\d+$/.test(String(value))) throw new Error("Port must be an integer.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < (allowZero ? 0 : 1) || port > 65535)
    throw new Error("Port must be between 1 and 65535.");
  return port;
}

export function parseBackend(value) {
  const backend = new URL(value);
  if (
    backend.protocol !== "http:" ||
    backend.username ||
    backend.password ||
    backend.pathname !== "/" ||
    backend.search ||
    backend.hash ||
    !["127.0.0.1", "[::1]", "localhost"].includes(backend.hostname)
  )
    throw new Error(
      "Backend must be an HTTP loopback origin without credentials or a path.",
    );
  // Avoid relying on DNS for even the localhost spelling.
  if (backend.hostname === "localhost") backend.hostname = "127.0.0.1";
  return backend;
}

export function parseConfiguration(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const options = {
    staticDir: env.CDESKTOP_BROWSER_STATIC_DIR || DEFAULT_STATIC_DIR,
    port: env.CDESKTOP_BROWSER_PORT || "5192",
    backend: env.CDESKTOP_BROWSER_BACKEND || "http://127.0.0.1:8131",
  };
  const flags = new Map([
    ["--static-dir", "staticDir"],
    ["--port", "port"],
    ["--backend", "backend"],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const key = flags.get(argv[i]);
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--"))
      throw new Error(
        "Usage: cdesktop-browser-server.mjs [--static-dir DIR] [--port PORT] [--backend http://127.0.0.1:8131]",
      );
    options[key] = argv[++i];
  }
  options.port = parsePort(options.port);
  options.backend = parseBackend(options.backend).origin;
  return options;
}

export function isLocalRequest(req, port) {
  const source = req.socket.remoteAddress;
  if (
    source !== "127.0.0.1" &&
    source !== "::1" &&
    source !== "::ffff:127.0.0.1"
  )
    return false;
  const hosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    "127.0.0.1:5190",
  ]);
  const hostCount = req.rawHeaders.filter(
    (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "host",
  ).length;
  const originCount = req.rawHeaders.filter(
    (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "origin",
  ).length;
  if (hostCount !== 1 || originCount > 1 || !hosts.has(req.headers.host))
    return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  return (
    origin === undefined ||
    origin === EXPECTED_ORIGIN ||
    [...hosts].some((host) => origin === `http://${host}`)
  );
}

function requestPath(req) {
  if (
    !req.url?.startsWith("/") ||
    req.url.startsWith("//") ||
    req.url.includes("#")
  )
    throw new Error("Invalid request target");
  const raw = req.url.split("?", 1)[0];
  const decoded = decodeURIComponent(raw);
  if (
    /[\\\u0000-\u001f\u007f%]/.test(decoded) ||
    decoded.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Invalid path");
  return decoded;
}

function apiPath(value) {
  return value === "/api" || value.startsWith("/api/");
}

function filterHeaders(headers, request = false) {
  const dropped = new Set(HOP_HEADERS);
  for (const value of String(headers.connection || "").split(","))
    dropped.add(value.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      if (dropped.has(name) || name === "set-cookie" || name === "set-cookie2")
        return false;
      if (
        request &&
        (IDENTITY_HEADERS.has(name) ||
          name.startsWith("x-forwarded-") ||
          name.startsWith("x-original-") ||
          name.startsWith("x-rewrite-"))
      )
        return false;
      return true;
    }),
  );
}

function upstreamHeaders(req, websocket = false) {
  const headers = filterHeaders(req.headers, true);
  headers.host = new URL(EXPECTED_ORIGIN).host;
  headers.origin = EXPECTED_ORIGIN;
  if (websocket) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

function reply(res, status, message, method) {
  if (res.destroyed) return;
  if (res.headersSent) return res.destroy();
  const body = Buffer.from(`${message}\n`);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(method === "HEAD" ? undefined : body);
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`,
  );
}

function allowedFile(relative) {
  const parts = relative.split("/");
  if (
    path.extname(relative).toLowerCase() === ".txt" &&
    relative !== "robots.txt"
  )
    return false;
  if (
    parts.some(
      (part) =>
        part.startsWith(".") ||
        ["src", "node_modules", "private", "scripts"].includes(part),
    )
  )
    return false;
  if (
    /^(?:package(?:-lock)?|tsconfig(?:\.[^.]+)?|jsconfig|composer)\.json$/i.test(
      parts.at(-1),
    )
  )
    return false;
  return MIME.has(path.extname(relative).toLowerCase());
}

async function openStatic(root, relative) {
  let candidate = root;
  for (const component of relative.split("/")) {
    candidate = path.join(candidate, component);
    if ((await lstat(candidate)).isSymbolicLink()) {
      const error = new Error("Symlinks are not served");
      error.code = "EACCES";
      throw error;
    }
  }
  const actual = await realpath(candidate);
  if (!actual.startsWith(root + path.sep)) {
    const error = new Error("Path escapes static root");
    error.code = "EACCES";
    throw error;
  }
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = await file.stat();
  if (!stat.isFile()) {
    await file.close();
    const error = new Error("Not a file");
    error.code = "ENOENT";
    throw error;
  }
  return { file, stat };
}

/** Start on IPv4 loopback only. Port 0 is supported for isolated tests. */
export async function startCdesktopBrowserServer(options = {}) {
  const port = parsePort(options.port ?? 5192, true);
  const backend = parseBackend(options.backend ?? "http://127.0.0.1:8131");
  const root = await realpath(
    path.resolve(options.staticDir ?? DEFAULT_STATIC_DIR),
  );
  const index = await openStatic(root, "index.html");
  await index.file.close();
  const httpIdleTimeoutMs = options.httpIdleTimeoutMs ?? 120_000;
  const websocketIdleTimeoutMs = options.websocketIdleTimeoutMs ?? 30 * 60_000;
  const upgradeTimeoutMs = options.upgradeTimeoutMs ?? 15_000;
  const sockets = new Set();
  let listeningPort;

  function proxyHttp(req, res) {
    const upstream = http.request(backend, {
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req),
      agent: false,
    });
    const abort = () => upstream.destroy();
    req.once("aborted", abort);
    req.once("error", abort);
    res.once("close", abort);
    upstream.setTimeout(httpIdleTimeoutMs, () => {
      reply(res, 504, "Local API timed out", req.method);
      upstream.destroy();
    });
    upstream.once("error", () =>
      reply(res, 502, "Local API unavailable", req.method),
    );
    upstream.once("response", (incoming) => {
      incoming.once("error", () => res.destroy());
      incoming.once("aborted", () => res.destroy());
      const headers = filterHeaders(incoming.headers);
      headers["cache-control"] = "no-store";
      headers["x-content-type-options"] = "nosniff";
      res.writeHead(incoming.statusCode, headers);
      incoming.pipe(res);
    });
    req.pipe(upstream);
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return reply(res, 405, "Method not allowed", req.method);
    }
    let relative = pathname.replace(/^\/+/, "") || "index.html";
    const extension = path.extname(relative);
    // Only extensionless navigation paths can fall back to the SPA document.
    if (
      !extension &&
      !relative.startsWith("assets/") &&
      !relative.split("/").some((part) => part.startsWith("."))
    ) {
      if (
        !String(req.headers.accept || "")
          .split(",")
          .some((part) => part.trim().startsWith("text/html"))
      )
        return reply(res, 404, "Not found", req.method);
      relative = "index.html";
    }
    if (!allowedFile(relative)) return reply(res, 404, "Not found", req.method);
    let opened;
    try {
      opened = await openStatic(root, relative);
    } catch (error) {
      return reply(
        res,
        ["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(error.code)
          ? 404
          : 500,
        "Static file unavailable",
        req.method,
      );
    }
    const { file, stat } = opened;
    if (res.destroyed) {
      await file.close();
      return;
    }
    const hashed =
      relative.startsWith("assets/") &&
      /[-.][A-Za-z0-9_-]{8,}\.[^.]+$/.test(relative);
    res.writeHead(200, {
      "Content-Type": MIME.get(path.extname(relative).toLowerCase()),
      "Content-Length": stat.size,
      "Cache-Control": hashed
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (req.method === "HEAD") {
      await file.close();
      res.end();
      return;
    }
    const stream = file.createReadStream();
    res.once("close", () => stream.destroy());
    stream.once("error", () => res.destroy());
    stream.pipe(res);
  }

  const server = http.createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    if (!isLocalRequest(req, listeningPort))
      return reply(res, 403, "Local request required", req.method);
    let pathname;
    try {
      pathname = requestPath(req);
    } catch {
      return reply(res, 400, "Invalid request path", req.method);
    }
    if (apiPath(pathname)) return proxyHttp(req, res);
    serveStatic(req, res, pathname).catch(() =>
      reply(res, 500, "Static file unavailable", req.method),
    );
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (!isLocalRequest(req, listeningPort))
      return rejectUpgrade(socket, 403, "Local request required");
    let pathname;
    try {
      pathname = requestPath(req);
    } catch {
      return rejectUpgrade(socket, 400, "Invalid request path");
    }
    if (!apiPath(pathname)) return rejectUpgrade(socket, 404, "Not found");
    if (
      req.method !== "GET" ||
      String(req.headers.upgrade).toLowerCase() !== "websocket"
    )
      return rejectUpgrade(socket, 400, "WebSocket upgrade required");
    const upstream = http.request(backend, {
      method: "GET",
      path: req.url,
      headers: upstreamHeaders(req, true),
      agent: false,
    });
    let upgraded = false;
    let peer;
    const handshakeTimer = setTimeout(() => {
      rejectUpgrade(socket, 504, "Local API timed out");
      upstream.destroy();
    }, upgradeTimeoutMs);
    handshakeTimer.unref();
    socket.once("close", () => {
      clearTimeout(handshakeTimer);
      upstream.destroy();
      peer?.destroy();
    });
    upstream.once("error", () => {
      clearTimeout(handshakeTimer);
      if (upgraded) socket.destroy();
      else rejectUpgrade(socket, 502, "Local API unavailable");
    });
    upstream.once("response", (response) => {
      clearTimeout(handshakeTimer);
      response.resume();
      rejectUpgrade(socket, 502, "Local API rejected WebSocket upgrade");
    });
    upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
      clearTimeout(handshakeTimer);
      peer = upstreamSocket;
      if (
        socket.destroyed ||
        response.statusCode !== 101 ||
        String(response.headers.upgrade).toLowerCase() !== "websocket"
      ) {
        upstreamSocket.destroy();
        return rejectUpgrade(socket, 502, "Invalid WebSocket upgrade");
      }
      upgraded = true;
      const headers = filterHeaders(response.headers);
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map(
          (entry) => `${name}: ${entry}`,
        ),
      );
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`,
      );
      upstreamSocket.on("error", () => socket.destroy());
      upstreamSocket.once("close", () => socket.destroy());
      socket.setTimeout(websocketIdleTimeoutMs, () => socket.destroy());
      upstreamSocket.setTimeout(websocketIdleTimeoutMs, () =>
        upstreamSocket.destroy(),
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      listeningPort = server.address().port;
      resolve();
    });
  });
  return {
    server,
    origin: `http://127.0.0.1:${listeningPort}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      }),
  };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const instance = await startCdesktopBrowserServer(parseConfiguration());
    console.log(`cdesktop browser server listening on ${instance.origin}`);
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        instance.close().then(
          () => {
            process.exitCode = 0;
          },
          () => {
            process.exitCode = 1;
          },
        );
      });
  } catch (error) {
    console.error(`cdesktop browser server failed: ${error.message}`);
    process.exitCode = 1;
  }
}
