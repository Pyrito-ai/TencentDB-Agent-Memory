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
        "X-Tdai-User-Key": ownerKey,
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
    user: { id: user.user_id, name: user.name || user.user_name },
  });
});
app.use("/api/v1/workbench/*", async (c, next) => {
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
  const forwarded = new Request(req, { headers });
  return api.fetch(forwarded);
});
const api = new Hono();
const routes = new Hono();
registerWorkbenchRoutes(routes, deps);
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
