import { test, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerCoordinatorRoutes } from "../src/panel/http/routes/coordinator.js";
import { validatePanelMetaHeaders } from "../src/panel/http/middleware/validate-panel-headers.js";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function fixture() {
  const app = new Hono(),
    root = mkdtempSync(path.join(tmpdir(), "coordinator-"));
  const model = vi.fn(),
    dispatch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: "created", api_key: "SECRET_SENTINEL_92847" }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
  const deps: any = {
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: "",
        api_key: "",
      }),
    },
    metaKernel: {
      invoke: async (a: string, b: any) => ({
        code: 0,
        data:
          a === "auth/verify"
            ? { valid: true, user: { user_id: b.user_key } }
            : a === "team-member/get"
              ? { status: b.user_id === "outsider" ? "removed" : "active" }
              : a === "task/get"
                ? { team_id: b.task_id === "foreign" ? "other" : "team" }
                : null,
      }),
    },
  };
  const close = registerCoordinatorRoutes(app, deps, { root, model, dispatch });
  cleanup.push(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });
  const req = (op: string, body?: any, user = "alice") =>
    app.request("/coordinator/team/" + op, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Tdai-Service-Id": "default",
        "X-Tdai-User-Key": user,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { req, model, dispatch };
}
test("read results feed the model with secrets removed and per-user history", async () => {
  const { req, model, dispatch } = fixture();
  model
    .mockResolvedValueOnce({
      reply: "",
      action: { name: "projects/list", args: {} },
    })
    .mockResolvedValueOnce({ reply: "One project." });
  const r = await req("message", { revision: 0, text: "List projects" });
  expect(r.status).toBe(200);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(JSON.stringify(model.mock.calls)).not.toContain(
    "SECRET_SENTINEL_92847",
  );
  expect(
    (await (await req("state", undefined, "bob")).json()).messages,
  ).toEqual([]);
  expect((await req("state", undefined, "outsider")).status).toBe(403);
});
test("cookie-authenticated actions retain the resolved credential through internal dispatch", async () => {
  const app = new Hono(),
    root = mkdtempSync(path.join(tmpdir(), "coordinator-cookie-"));
  const model = vi
    .fn()
    .mockResolvedValueOnce({
      reply: "",
      action: { name: "projects/list", args: {} },
    })
    .mockResolvedValueOnce({ reply: "Found the session project." });
  const resolveSession = vi.fn((instance: string, cookie?: string) =>
    instance === "default" && cookie === "valid-session"
      ? { userKey: "session-user-key", coreUserId: "alice" }
      : null,
  );
  const deps: any = {
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: "",
        api_key: "",
      }),
    },
    config: { auth: { sessionCookieName: "panel_session" } },
    auth: { resolveSession },
    metaKernel: {
      invoke: async (action: string, body: any) => ({
        code: 0,
        data:
          action === "auth/verify"
            ? {
                valid: body.user_key === "session-user-key",
                user: { user_id: "alice" },
              }
            : action === "team-member/get"
              ? { status: "active" }
              : null,
      }),
    },
  };
  const actionCredential = vi.fn();
  app.use("/projects/*", validatePanelMetaHeaders(deps));
  app.get("/projects/team/list", (c) => {
    actionCredential(c.get("panelMeta").userKey);
    return c.json({ items: [{ name: "Session project" }] });
  });
  const close = registerCoordinatorRoutes(app, deps, { root, model });
  cleanup.push(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });
  const response = await app.request("/coordinator/team/message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tdai-Service-Id": "default",
      Cookie: "panel_session=valid-session",
    },
    body: JSON.stringify({ revision: 0, text: "List projects" }),
  });
  expect(response.status).toBe(200);
  expect(resolveSession).toHaveBeenCalledWith("default", "valid-session");
  expect(actionCredential).toHaveBeenCalledOnce();
  expect(actionCredential).toHaveBeenCalledWith("session-user-key");
  expect(model).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(model.mock.calls[1])).toContain("Session project");
});
test("writes require approval, reject stale or forged proposals and execute once", async () => {
  const { req, model, dispatch } = fixture();
  model.mockResolvedValue({
    reply: "Create project Example",
    action: { name: "projects/create", args: { name: "Example" } },
  });
  const s = await (
    await req("message", { revision: 0, text: "Create Example" })
  ).json();
  expect(dispatch).not.toHaveBeenCalled();
  expect(
    (await req("approve", { revision: s.revision, id: "forged" })).status,
  ).toBe(409);
  const r = await req("approve", { revision: s.revision, id: s.pending.id });
  expect(r.status).toBe(200);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(
    (await req("approve", { revision: s.revision, id: s.pending.id })).status,
  ).toBe(409);
});
test("model cannot invoke arbitrary paths or access foreign task data", async () => {
  const { req, model, dispatch } = fixture();
  model.mockResolvedValueOnce({
    reply: "",
    action: { name: "http://evil.test", args: {} },
  });
  expect((await req("message", { revision: 0, text: "List" })).status).toBe(
    502,
  );
  expect(dispatch).not.toHaveBeenCalled();
  const s = await (await req("state")).json();
  model.mockResolvedValueOnce({
    reply: "",
    action: { name: "meta/task/get", args: { task_id: "foreign" } },
  });
  expect(
    (await req("message", { revision: s.revision, text: "Read foreign" }))
      .status,
  ).toBe(502);
  expect(dispatch).not.toHaveBeenCalled();
});
test("uncertain write cannot be automatically replayed", async () => {
  const { req, model, dispatch } = fixture();
  model.mockResolvedValue({
    reply: "Create",
    action: { name: "projects/create", args: { name: "Example" } },
  });
  const s = await (
    await req("message", { revision: 0, text: "Create" })
  ).json();
  dispatch.mockRejectedValueOnce(Error("network"));
  const r = await (
    await req("approve", { revision: s.revision, id: s.pending.id })
  ).json();
  expect(r.pending.status).toBe("unknown");
  expect(
    (await req("approve", { revision: r.revision, id: s.pending.id })).status,
  ).toBe(409);
  expect(dispatch).toHaveBeenCalledOnce();
});

test("read filters reach GET routes and explicit foreign teams are rejected", async () => {
  const { req, model, dispatch } = fixture();
  model
    .mockResolvedValueOnce({
      reply: "",
      action: {
        name: "timesheets/list",
        args: { from: "2026-09-01", to: "2026-09-30" },
      },
    })
    .mockResolvedValueOnce({ reply: "Listed." });
  await req("message", { revision: 0, text: "List September time" });
  expect(dispatch.mock.calls[0][0]).toBe(
    "/timesheets/team/list?from=2026-09-01&to=2026-09-30",
  );
  const s = await (await req("state")).json();
  model.mockResolvedValueOnce({
    reply: "",
    action: { name: "knowledge/wiki/list", args: { team_id: "other" } },
  });
  expect(
    (await req("message", { revision: s.revision, text: "Read other team" }))
      .status,
  ).toBe(502);
  expect(dispatch).toHaveBeenCalledOnce();
});
