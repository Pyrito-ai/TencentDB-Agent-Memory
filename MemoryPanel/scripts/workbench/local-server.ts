/** Single-owner loopback development host. Uses real Tencent auth and routes. */
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { loadPanelConfig } from "../../src/panel/config/panel-config.js";
import { buildPanelDeps } from "../../src/panel/panel-deps.js";
import { registerWorkbenchRoutes } from "../../src/panel/http/routes/workbench.js";
const config = JSON.parse(
  readFileSync(process.env.WORKBENCH_LOCAL_CONFIG!, "utf8"),
);
for (const [k, v] of Object.entries(config.env)) process.env[k] = String(v);
const ownerKey = readFileSync(config.ownerKeyFile, "utf8").trim();
const token = randomBytes(32).toString("hex");
const deps = buildPanelDeps(loadPanelConfig());
deps.kernelHttp.postEnvelope = async <T>(
  route: string,
  body: unknown,
  cred: any,
) => {
  if (!route.startsWith("/v3/meta/")) throw Error("Unsupported upstream route");
  const response = await fetch(
    config.tencentUrl + "/api/v1/meta/" + route.slice("/v3/meta/".length),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tdai-Service-Id": cred.instanceId,
        ...(cred.userKey ? { "X-Tdai-User-Key": cred.userKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw Error("Tencent authentication service unavailable.");
  return (await response.json()) as {
    code: number;
    message: string;
    data: T;
    request_id: string;
  };
};
const upstreamContext = {
  instanceId: config.instance,
  gatewayEndpoint: config.tencentUrl,
  gatewayApiKey: "server-managed",
  userKey: ownerKey,
};
const verified = await deps.metaKernel.invoke(
  "auth/verify",
  { user_key: ownerKey },
  upstreamContext,
);
if (!(verified.data as any)?.valid) throw Error("Owner authentication failed.");
const user = (verified.data as any).user;
const teams = await deps.metaKernel.invoke(
  "team/list",
  { user_id: user.user_id, limit: 100, offset: 0 },
  upstreamContext,
);
const items = (teams.data as any)?.items || [];
const app = new Hono();
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && origin !== config.browserOrigin)
    return c.json({ error: "Origin rejected" }, 403);
  if (c.req.header("sec-fetch-site") === "cross-site")
    return c.json({ error: "Cross-site request rejected" }, 403);
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/api/v1/local-session", (c) => {
  // Browser-only bootstrap, bound to the developer UI origin. Never expose owner credentials.
  if (!c.req.header("referer")?.startsWith(config.browserOrigin + "/"))
    return c.json({ error: "Open Workbench locally." }, 403);
  setCookie(c, "workbench_local", token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/api/v1",
    maxAge: 28800,
  });
  return c.json({
    instance: config.instance,
    teams: items.map((t: any) => ({
      id: t.team_id,
      name: t.name || t.team_name || t.team_id,
    })),
    user: Object.fromEntries(
      [
        "user_id",
        "auth_provider",
        "external_id",
        "username",
        "display_name",
        "email",
        "status",
        "created_at",
        "updated_at",
        "user_type",
      ]
        .filter((key) => user[key] !== undefined)
        .map((key) => [key, user[key]]),
    ),
  });
});
app.use("/api/v1/*", async (c, next) => {
  if (c.req.path === "/api/v1/local-session") return next();
  const supplied = Buffer.from(getCookie(c, "workbench_local") || "");
  const expected = Buffer.from(token);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return c.json(
      { error: "Open the live Workbench page to sign in locally." },
      401,
    );
  const req = c.req.raw;
  const headers = new Headers(req.headers);
  headers.set("X-Tdai-Service-Id", config.instance);
  headers.set("X-Tdai-User-Key", ownerKey);
  if (c.req.path.startsWith("/api/v1/workbench/"))
    return api.fetch(new Request(req, { headers }));
  const meta = c.req.path.match(
    /^\/api\/v1\/meta\/(task\/(?:list|create|board-state|board-transition|update))$/,
  );
  const project = c.req.path.match(
    /^\/api\/v1\/projects\/[^/]+\/(list|assign)$/,
  );
  if (
    (!meta || req.method !== "POST") &&
    (!project ||
      (project[1] === "list" ? req.method !== "GET" : req.method !== "POST"))
  )
    return c.json({ error: "Unsupported local development route" }, 404);
  const response = await fetch(config.tencentUrl + c.req.path, {
    method: req.method,
    headers: {
      "Content-Type": "application/json",
      "X-Tdai-Service-Id": config.instance,
      "X-Tdai-User-Key": ownerKey,
    },
    ...(req.method === "GET" ? {} : { body: await req.text() }),
    signal: AbortSignal.timeout(20000),
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
});
const api = new Hono();
const routes = new Hono();
async function boardRead(
  scope: { ctx: { instanceId: string; userKey?: string }; team: string },
  kind: "projects" | "loops",
) {
  if (!scope.ctx.userKey) throw Error("Authenticated Board lookup required");
  const response = await fetch(
    `${config.tencentUrl}/api/v1/${kind}/${encodeURIComponent(scope.team)}/list`,
    {
      headers: {
        "X-Tdai-Service-Id": scope.ctx.instanceId,
        "X-Tdai-User-Key": scope.ctx.userKey,
      },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw Error("Task Board lookup unavailable");
  return response.json() as Promise<any>;
}
registerWorkbenchRoutes(routes, deps, {
  boardLookup: {
    async project(scope, taskId) {
      const data = await boardRead(scope, "projects");
      const id = data.assignments.find(
        (x: any) => x.task === taskId,
      )?.project_id;
      return data.items.find((x: any) => x.id === id && !x.archived);
    },
    async byId(scope, projectId) {
      const data = await boardRead(scope, "projects");
      return data.items.find((x: any) => x.id === projectId && !x.archived);
    },
    async isLoopTask(scope, taskId) {
      const data = await boardRead(scope, "loops");
      return data.history.some((x: any) => x.task_id === taskId);
    },
  },
});
api.route("/api/v1", routes);
app.onError((_e, c) =>
  c.json(
    {
      error:
        "Live Workbench request failed. Check the local service configuration.",
    },
    502,
  ),
);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8123 }, () =>
  console.log(
    "Live Workbench listening on loopback. Tencent authentication verified.",
  ),
);
