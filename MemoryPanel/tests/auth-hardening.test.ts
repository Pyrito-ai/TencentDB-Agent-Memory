import { test, expect, vi } from "vitest";
import { Hono } from "hono";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PanelAuthService, safeReturnPath } from "../src/panel/auth/service.js";
import { registerAuthRoutes } from "../src/panel/http/routes/auth.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";

async function service(overrides: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (action: string, body: any) =>
    action === "auth/verify"
      ? { code: 0, data: body.user_key === "existing-key" ? { valid: true, user: { user_id: "u1", username: "u" } } : { valid: false } }
      : { code: 0, data: {} },
  );
  const root = await mkdtemp(path.join(tmpdir(), "auth-"));
  const auth = new PanelAuthService({
    config: {
      userKeyEnabled: true,
      idpEnabled: false,
      sessionTtlSeconds: 60,
      sessionCookieName: "s",
      sessionSecure: false,
      sessionSecret: "",
      identityStorePath: path.join(root, "identities.json"),
      woa: { enabled: false },
      ...overrides,
    } as any,
    instances: { resolve: (id: string) => ({ instance_id: id, gateway_endpoint: "", api_key: "admin" }) } as any,
    metaKernel: { invoke } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
  });
  return { auth, invoke };
}

test("unknown user keys cannot create accounts unless sign-up is enabled", async () => {
  const { auth, invoke } = await service();
  await expect(auth.loginWithUserKey({ instanceId: "i", userKey: "unknown-key" })).rejects.toMatchObject({
    code: "USER_KEY_SIGNUP_DISABLED",
    status: 403,
  });
  expect(invoke).not.toHaveBeenCalledWith("user/create-with-key", expect.anything(), expect.anything());
  await expect(auth.loginWithUserKey({ instanceId: "i", userKey: "existing-key" })).resolves.toMatchObject({
    user_id: "u1",
    created: false,
  });
});

test("sign-up works only when explicitly enabled", async () => {
  const { auth, invoke } = await service({ userKeySignupEnabled: true });
  await auth.loginWithUserKey({ instanceId: "i", userKey: "unknown-key" }).catch(() => undefined);
  expect(invoke).toHaveBeenCalledWith("user/create-with-key", expect.objectContaining({ user_key: "unknown-key" }), expect.anything());
});

test("user_key endpoints are refused when user_key login is disabled", async () => {
  const { auth } = await service({ userKeyEnabled: false, idpEnabled: true, sessionSecret: "x".repeat(32) });
  await expect(auth.previewUserKeyLogin({ instanceId: "i", userKey: "existing-key" })).rejects.toMatchObject({
    code: "USER_KEY_DISABLED",
  });
});

test("return paths stay on this site", () => {
  for (const unsafe of ["//evil.com", "/\\evil.com", "/\tevil", "https://evil.com", ""])
    expect(safeReturnPath(unsafe)).toBe("/");
  expect(safeReturnPath("/workbench?task=1")).toBe("/workbench?task=1");
});

test("user_key probes are rate limited per client", async () => {
  const { auth } = await service();
  const api = new Hono();
  registerAuthRoutes(api, { auth, config: { auth: { sessionCookieName: "s" } } } as unknown as PanelDeps);
  const probe = (ip: string) =>
    api.request("/auth/user-key/preview", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ instance_id: "i", user_key: "unknown-key" }),
    });
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await probe("203.0.113.9")).status);
  expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
  expect(statuses[20]).toBe(429);
  expect((await probe("198.51.100.4")).status).toBe(200);
});
