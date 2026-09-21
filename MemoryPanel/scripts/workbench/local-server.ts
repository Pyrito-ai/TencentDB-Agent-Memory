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
const publicUser = (value: any) =>
  Object.fromEntries(
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
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
async function verifyOwner() {
  const result = await deps.metaKernel.invoke(
    "auth/verify",
    { user_key: ownerKey },
    upstreamContext,
  );
  if (!(result.data as any)?.valid) throw Error("Owner authentication failed");
  return publicUser((result.data as any).user);
}
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
// Both the standalone Workbench and the full development console use this owner session.
for (const route of ["/api/v1/local-session", "/api/v1/auth/session"]) {
  app.get(route, async (c) => {
    if (!c.req.header("referer")?.startsWith(config.browserOrigin + "/"))
      return c.json({ error: "Open the local development page." }, 403);
    const currentUser = await verifyOwner();
    setCookie(c, "workbench_local", token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/api/v1",
      maxAge: 28800,
    });
    if (route.endsWith("/auth/session"))
      return c.json({
        authenticated: true,
        instance_id: config.instance,
        user: currentUser,
      });
    return c.json({
      instance: config.instance,
      teams: items.map((t: any) => ({
        id: t.team_id,
        name: t.name || t.team_name || t.team_id,
      })),
      user: currentUser,
    });
  });
}
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
  if (c.req.path === "/api/v1/meta/auth/verify" && c.req.method === "POST") {
    return c.json({
      code: 0,
      message: "ok",
      data: { valid: true, user: await verifyOwner() },
      request_id: "local-owner-session",
    });
  }
  const req = c.req.raw;
  const headers = new Headers(req.headers);
  headers.set("X-Tdai-Service-Id", config.instance);
  headers.set("X-Tdai-User-Key", ownerKey);
  if (c.req.path.startsWith("/api/v1/workbench/"))
    return api.fetch(new Request(req, { headers }));
  const meta = c.req.path.match(
    /^\/api\/v1\/meta\/(task\/(?:list|create|board-state|board-transition|update))$/,
  );
  const readMeta = c.req.path.match(
    /^\/api\/v1\/meta\/(?:team|team-member|agent|task|task-agent|asset|participation-log|acl)\/(?:list|get|list-accessible|check)$/,
  );
  const readPanel =
    req.method === "GET" &&
    (c.req.path === "/api/v1/meta/instances" ||
      /^\/api\/v1\/(?:projects|areas|loops|task-time|task-activity|timesheets)\/[^/]+\/(?:list|summary|settings|entries)$/.test(
        c.req.path,
      ));
  const project = c.req.path.match(
    /^\/api\/v1\/projects\/[^/]+\/(list|assign)$/,
  );
  if (
    !readPanel &&
    !(readMeta && req.method === "POST") &&
    (!meta || req.method !== "POST") &&
    (!project ||
      (project[1] === "list" ? req.method !== "GET" : req.method !== "POST"))
  )
    return c.json({ error: "Unsupported local development route" }, 404);
  const response = await fetch(
    config.tencentUrl + c.req.path + new URL(c.req.url).search,
    {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "X-Tdai-Service-Id": config.instance,
        "X-Tdai-User-Key": ownerKey,
      },
      ...(req.method === "GET" ? {} : { body: await req.text() }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return c.json(
      {
        error:
          response.status === 404
            ? "This feature is not available on the connected Tencent backend yet. Deploy the Workbench branch backend with the frontend."
            : "The connected Tencent backend returned an unexpected response.",
      },
      502,
    );
  }
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
