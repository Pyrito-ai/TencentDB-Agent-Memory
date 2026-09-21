import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerWorkbenchRoutes } from "../src/panel/http/routes/workbench.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";
let app: Hono, close: () => void, root: string, active: boolean;
const launch = vi.fn(),
  read = vi.fn(),
  plan = vi.fn(),
  review = vi.fn();
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workbench-"));
  active = true;
  const board = new DatabaseSync(path.join(root, "time.sqlite"));
  board.exec(
    "CREATE TABLE projects(id,instance,team,created_by,archived);CREATE TABLE task_projects(instance,team,task,project_id);INSERT INTO projects VALUES('p','default','team','alice',0);INSERT INTO task_projects VALUES('default','team','task','p');",
  );
  board.close();
  plan.mockResolvedValue({
    summary: "Bounded work",
    workers: [
      {
        title: "Fix tests",
        agent: "codex",
        spec: "Own tests only. Verify with test runner.",
      },
    ],
  });
  review.mockResolvedValue("Evidence incomplete.");
  launch.mockImplementation(async (_b, id) => ({
    id,
    state: "running",
    terminal: "t1",
  }));
  read.mockImplementation(async (_b, id) => ({
    id,
    state: "exited",
    output: "Tests passed",
  }));
  const deps = {
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: "",
        api_key: "",
      }),
    },
    metaKernel: {
      invoke: async (action: string, b: any) => ({
        code: 0,
        data:
          action === "auth/verify"
            ? { valid: b.user_key !== "invalid", user: { user_id: b.user_key } }
            : action === "team-member/get"
              ? {
                  status:
                    active && b.user_id !== "outsider" ? "active" : "removed",
                }
              : action === "task/board-state"
                ? {
                    task: {
                      task_id: b.task_id,
                      team_id: "team",
                      creator_user_id: "alice",
                      title: "Task",
                      description: "Acceptance",
                      metadata: { project_board: { status: "ready" } },
                    },
                    revision: "1",
                  }
                : action === "task/get"
                  ? {
                      team_id: b.task_id === "foreign" ? "other" : "team",
                      title: "Task",
                      description: "Acceptance",
                    }
                  : null,
      }),
    },
  } as unknown as PanelDeps;
  app = new Hono();
  close = registerWorkbenchRoutes(app, deps, {
    root,
    boardRoot: root,
    bindings: [
      {
        id: "r1",
        label: "My runtime",
        instance: "default",
        team: "team",
        user: "alice",
        repo: "id:repo1",
        url: "http://127.0.0.1:8791",
        token: "x".repeat(32),
      },
    ],
    runner: { launch, read },
    coordinator: { plan, review },
  });
});
afterEach(async () => {
  close();
  await rm(root, { recursive: true, force: true });
});
function req(
  action: string,
  body?: unknown,
  user = "alice",
  instance = "default",
  team = "team",
) {
  return app.request(`/workbench/${team}/${action}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Tdai-Service-Id": instance,
      "X-Tdai-User-Key": user,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function make() {
  await req("execution-bind", { projectId: "p", binding: "r1" });
  await req("execution-approve", {
    taskId: "task",
    agent: "codex",
    spec: "Own tests only. Verify with test runner.",
  });
  return (
    await req("plan", {
      binding: "r1",
      taskId: "task",
      objective: "Fix the flaky tests",
    })
  ).json();
}
test("planning cannot execute; approval launches once with server-owned binding", async () => {
  const run = await make();
  expect(launch).not.toHaveBeenCalled();
  const body = { id: run.id, workerId: run.workers[0].id };
  const result = await Promise.all([
    req("dispatch", body),
    req("dispatch", body),
  ]);
  expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(launch.mock.calls[0]?.[0].repo).toBe("id:repo1");
  expect((await req("dispatch", body)).status).toBe(409);
});
test("invalid, removed and other users cannot inspect or launch another run", async () => {
  const run = await make();
  expect((await req("runs", undefined, "invalid")).status).toBe(401);
  expect((await req("runs", undefined, "outsider")).status).toBe(403);
  expect((await (await req("runs", undefined, "bob")).json()).items).toEqual(
    [],
  );
  expect(
    (await req("dispatch", { id: run.id, workerId: run.workers[0].id }, "bob"))
      .status,
  ).toBe(404);
  expect((await req("refresh", { id: run.id }, "alice", "other")).status).toBe(
    404,
  );
  active = false;
  expect((await req("refresh", { id: run.id })).status).toBe(403);
  expect(launch).not.toHaveBeenCalled();
});
test("runtime credentials are never returned and arbitrary runtime cannot be selected", async () => {
  const o = await (await req("options")).json();
  expect(JSON.stringify(o)).not.toContain("xxxxxxxx");
  expect(o.bindings).toEqual([{ id: "r1", label: "My runtime" }]);
  expect(
    (await req("plan", { binding: "evil", objective: "Perform this work" }))
      .status,
  ).toBe(403);
  expect(
    (
      await req("plan", {
        binding: "r1",
        objective: "Perform this work",
        taskId: "foreign",
      })
    ).status,
  ).toBe(404);
  expect(plan).not.toHaveBeenCalled();
});
test("uncertain launch cannot retry; refresh reconciles without a second execution", async () => {
  launch.mockRejectedValueOnce(Error("timeout"));
  const run = await make();
  const body = { id: run.id, workerId: run.workers[0].id };
  const dispatched = await (await req("dispatch", body)).json();
  expect(dispatched.workers[0].state).toBe("unknown");
  expect((await req("dispatch", body)).status).toBe(409);
  const refreshed = await (await req("refresh", { id: run.id })).json();
  expect(refreshed.workers[0].state).toBe("exited");
  expect(launch).toHaveBeenCalledTimes(1);
});
test("review is advisory and task context is scoped", async () => {
  const run = await (
    await req("plan", {
      binding: "r1",
      objective: "Fix the flaky tests",
      taskId: "local",
    })
  ).json();
  expect(plan.mock.calls[0]?.[1]).toContain("Acceptance");
  const r = await (await req("review", { id: run.id })).json();
  expect(r.review).toBe("Evidence incomplete.");
  expect(launch).not.toHaveBeenCalled();
});
test("provider failures never disclose diagnostics", async () => {
  plan.mockRejectedValue(Error("secret-provider-token"));
  const r = await req("plan", {
    binding: "r1",
    objective: "Fix the flaky tests",
  });
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain("secret-provider-token");
});

test("persistent conversation accepts follow-ups without launching or duplicating messages", async () => {
  const chat = vi
    .fn()
    .mockResolvedValue({ reply: "Let us discuss the scope.", workers: [] });
  // Reopen with the same store and extended dependencies to exercise persisted messages.
  close();
  const deps = {
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: "",
        api_key: "",
      }),
    },
    metaKernel: {
      invoke: async (action: string, b: any) => ({
        code: 0,
        data:
          action === "auth/verify"
            ? { valid: true, user: { user_id: b.user_key } }
            : action === "task/board-state"
              ? {
                  task: {
                    task_id: b.task_id,
                    team_id: "team",
                    creator_user_id: "alice",
                    title: "Task",
                    description: "Acceptance",
                    metadata: { project_board: { status: "ready" } },
                  },
                  revision: "1",
                }
              : action === "task/get"
                ? { team_id: "team", title: "Task", description: "Acceptance" }
                : { status: "active" },
      }),
    },
  } as unknown as PanelDeps;
  app = new Hono();
  close = registerWorkbenchRoutes(app, deps, {
    root,
    boardRoot: root,
    bindings: [
      {
        id: "r1",
        label: "Runtime",
        instance: "default",
        team: "team",
        user: "alice",
        repo: "id:repo",
        url: "http://localhost",
        token: "x".repeat(32),
      },
    ],
    coordinator: { plan, review, chat },
    runner: { launch, read } as any,
  });
  const start = await (
    await req("start", {
      binding: "r1",
      objective: "Discuss the workspace layout",
    })
  ).json();
  expect(start.messages).toHaveLength(2);
  expect(start.workers).toHaveLength(0);
  expect(launch).not.toHaveBeenCalled();
  const body = {
    id: start.id,
    text: "Keep the conversation visible",
    operation: "11111111-1111-4111-8111-111111111111",
  };
  expect((await req("message", body)).status).toBe(200);
  expect((await req("message", body)).status).toBe(200);
  expect(chat).toHaveBeenCalledTimes(2);
  close();
  app = new Hono();
  close = registerWorkbenchRoutes(app, deps, {
    root,
    boardRoot: root,
    bindings: [],
    coordinator: { plan, review, chat },
    runner: { launch, read } as any,
  });
  const saved = await (await req("runs")).json();
  expect(saved.items[0].messages).toHaveLength(4);
  expect(
    chat.mock.calls[1]?.[0].some(
      (m: any) => m.text === "Keep the conversation visible",
    ),
  ).toBe(true);
});

test("workspace inspection and review decisions remain owner-scoped and reject stale diffs", async () => {
  const workspace = vi.fn().mockResolvedValue({
    files: [],
    branch: "test",
    base: "abc",
    diff: "change",
    snapshot: "current",
    truncated: false,
  });
  const file = vi.fn().mockResolvedValue({ path: "test.ts", content: "safe" });
  close();
  const deps = {
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: "",
        api_key: "",
      }),
    },
    metaKernel: {
      invoke: async (action: string, b: any) => ({
        code: 0,
        data:
          action === "auth/verify"
            ? { valid: true, user: { user_id: b.user_key } }
            : action === "task/board-state"
              ? {
                  task: {
                    task_id: b.task_id,
                    team_id: "team",
                    creator_user_id: "alice",
                    title: "Task",
                    description: "Acceptance",
                    metadata: { project_board: { status: "ready" } },
                  },
                  revision: "1",
                }
              : action === "task/get"
                ? { team_id: "team", title: "Task", description: "Acceptance" }
                : { status: "active" },
      }),
    },
  } as unknown as PanelDeps;
  app = new Hono();
  close = registerWorkbenchRoutes(app, deps, {
    root,
    boardRoot: root,
    bindings: [
      {
        id: "r1",
        label: "Runtime",
        instance: "default",
        team: "team",
        user: "alice",
        repo: "id:repo",
        url: "http://localhost",
        token: "x".repeat(32),
      },
    ],
    coordinator: { plan, review } as any,
    runner: { launch, read, workspace, file } as any,
  });
  const run = await make(),
    body = { id: run.id, workerId: run.workers[0].id };
  await req("dispatch", body);
  expect((await req("workspace", body, "bob")).status).toBe(404);
  expect(workspace).not.toHaveBeenCalled();
  expect(
    (await req("decision", { ...body, decision: "approved", snapshot: "old" }))
      .status,
  ).toBe(409);
  expect(
    (
      await req("decision", {
        ...body,
        decision: "approved",
        snapshot: "current",
      })
    ).status,
  ).toBe(200);
  workspace.mockResolvedValueOnce({
    files: [],
    branch: "test",
    base: "abc",
    diff: "new",
    snapshot: "new",
    truncated: false,
  });
  await req("workspace", body);
  const list = await (await req("runs")).json();
  expect(list.items[0].workers[0].review.stale).toBe(true);
  workspace.mockResolvedValueOnce({
    files: [],
    branch: "test",
    base: "abc",
    diff: "partial",
    snapshot: "current",
    truncated: true,
  });
  expect(
    (
      await req("decision", {
        ...body,
        decision: "approved",
        snapshot: "current",
      })
    ).status,
  ).toBe(409);
});

test("managed projects require owner scope and confirmation before selecting or creating", async () => {
  close();
  const deps = {
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: "",
        api_key: "",
      }),
    },
    metaKernel: {
      invoke: async (action: string, b: any) => ({
        code: 0,
        data:
          action === "auth/verify"
            ? { valid: true, user: { user_id: b.user_key } }
            : action === "task/board-state"
              ? {
                  task: {
                    task_id: b.task_id,
                    team_id: "team",
                    creator_user_id: "alice",
                    title: "Task",
                    description: "Acceptance",
                    metadata: { project_board: { status: "ready" } },
                  },
                  revision: "1",
                }
              : action === "task/get"
                ? { team_id: "team", title: "Task", description: "Acceptance" }
                : { status: "active" },
      }),
    },
  } as unknown as PanelDeps;
  const projects = vi
    .fn()
    .mockResolvedValue({ items: [{ id: "p1", name: "First project" }] });
  const createProject = vi
    .fn()
    .mockResolvedValue({ id: "p2", name: "New project" });
  const chat = vi.fn().mockResolvedValue({
    reply: "Proposed new project",
    workers: [],
    project: { action: "create", name: "New project" },
  });
  app = new Hono();
  close = registerWorkbenchRoutes(app, deps, {
    root,
    boardRoot: root,
    bindings: [
      {
        id: "owner",
        label: "Owner runtime",
        instance: "default",
        team: "team",
        user: "alice",
        repo: "managed",
        url: "http://localhost",
        token: "x".repeat(32),
        manageProjects: true,
      },
    ],
    runner: { launch, read, projects, createProject } as any,
    coordinator: { chat, plan, review },
  });
  expect(
    (await (await req("options")).json()).bindings.map((b: any) => b.id),
  ).toEqual(["owner", "owner:p1"]);
  const start = await (
    await req("start", { binding: "owner", objective: "Create a new project" })
  ).json();
  expect(start.projectProposal.name).toBe("New project");
  expect(createProject).not.toHaveBeenCalled();
  expect((await req("project-apply", { id: start.id }, "bob")).status).toBe(
    404,
  );
  const applied = await (await req("project-apply", { id: start.id })).json();
  expect(applied.binding).toBe("owner:p2");
  expect(applied.projectProposal).toBeUndefined();
  expect(createProject).toHaveBeenCalledTimes(1);
  expect(launch).not.toHaveBeenCalled();
  expect(
    (await req("project-create", { runtime: "owner", name: "../escape" }))
      .status,
  ).toBe(400);
  expect(
    (
      await req(
        "project-create",
        { runtime: "owner", name: "Valid project" },
        "bob",
      )
    ).status,
  ).toBe(403);
});
