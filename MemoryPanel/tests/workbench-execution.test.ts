import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { createExecutionService } from "../src/panel/workbench/execution.js";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
function setup() {
  const db = new DatabaseSync(":memory:"),
    board = new DatabaseSync(":memory:");
  board.exec(
    "CREATE TABLE projects(id,instance,team,created_by,archived);CREATE TABLE task_projects(instance,team,task,project_id);INSERT INTO projects VALUES('p','i','t','u',0);INSERT INTO task_projects VALUES('i','t','task','p');",
  );
  const task = {
    team_id: "t",
    creator_user_id: "u",
    title: "Title",
    description: "Task instructions",
    metadata_json: { project_board: { status: "ready" } },
  };
  let rev = 1;
  const invoke = vi.fn(async (a: string, b: any) => {
    if (a === "task/board-state")
      return { code: 0, data: { task, revision: String(rev) } };
    if (a === "task/board-transition") {
      if (b.expected_revision !== String(rev)) return { code: 409 };
      task.metadata_json.project_board.status = b.status;
      rev++;
      return { code: 0, data: { task, revision: String(rev) } };
    }
    return { code: 1 };
  });
  const launch = vi.fn(async (_b: any, id: string) => ({
    id,
    state: "running",
    lifecycle: "working",
    native: { taskId: "native-task" },
  }));
  const runner: any = {
    launch,
    read: vi.fn(async (_b: any, id: string) => ({
      id,
      state: "exited",
      lifecycle: "review",
      events: [
        {
          id: "event1",
          type: "worker_done",
          subject: "done",
          body: "evidence",
          payload: {},
        },
      ],
    })),
    workspace: vi.fn(async () => ({ snapshot: "s", truncated: false })),
  };
  const service = createExecutionService(
    db,
    () => board,
    { metaKernel: { invoke } } as any,
    runner,
  );
  const scope: any = {
    ctx: { instanceId: "i" },
    team: "t",
    user: "u",
    bindings: [{ id: "b", repo: "id:r", url: "http://localhost" }],
  };
  return { db, board, task, invoke, launch, service, scope, runner };
}
test("old Ready cards require explicit spec approval; concurrent dispatch has one durable claim", async () => {
  const x = setup();
  await x.service.bind(x.scope, "p", "b");
  expect((await x.service.get(x.scope, "task")).eligibility.eligible).toBe(
    false,
  );
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build and verify a bounded change",
  );
  const results = await Promise.allSettled([
    x.service.dispatch(x.scope, "task"),
    x.service.dispatch(x.scope, "task"),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(x.launch).toHaveBeenCalledTimes(1);
  expect(x.task.metadata_json.project_board.status).toBe("in_progress");
});
test("scope changes invalidate approval and owner mismatches fail closed", async () => {
  const x = setup();
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build and verify a bounded change",
  );
  x.task.description = "Different task";
  await expect(x.service.dispatch(x.scope, "task")).rejects.toThrow("stale");
  await expect(
    x.service.get({ ...x.scope, user: "other" }, "task"),
  ).rejects.toThrow("creator");
  expect(x.launch).not.toHaveBeenCalled();
});
test("unknown launch is retained; synchronization records deduplicated evidence and never automatically accepts", async () => {
  const x = setup();
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build and verify a bounded change",
  );
  x.launch.mockRejectedValueOnce(Error("timeout"));
  const result = await x.service.dispatch(x.scope, "task");
  expect(result.receipt?.state).toBe("unknown");
  await expect(x.service.dispatch(x.scope, "task")).rejects.toThrow("claimed");
  await x.service.sync(x.scope, "task");
  await x.service.sync(x.scope, "task");
  expect(x.task.metadata_json.project_board.status).toBe("review");
  expect(x.db.prepare("SELECT count(*) n FROM execution_events").get().n).toBe(
    1,
  );
  await expect(x.service.accept(x.scope, "task", "old")).rejects.toThrow(
    "current diff",
  );
  await x.service.accept(x.scope, "task", "s");
  expect(x.task.metadata_json.project_board.status).toBe("done");
});
test("Loop-linked task needs opt-in and shadow mode launches nothing", async () => {
  const x = setup();
  x.board.exec(
    "CREATE TABLE loop_occurrences(instance,team,task_id);INSERT INTO loop_occurrences VALUES('i','t','task');",
  );
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build and verify a bounded change",
  );
  await expect(x.service.dispatch(x.scope, "task")).rejects.toThrow("Loop");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build and verify a bounded change",
    true,
  );
  process.env.WORKBENCH_EXECUTION_MODE = "shadow";
  try {
    await expect(x.service.dispatch(x.scope, "task")).rejects.toThrow("shadow");
  } finally {
    delete process.env.WORKBENCH_EXECUTION_MODE;
  }
  expect(x.launch).not.toHaveBeenCalled();
});

test("runtime capacity is shared across distinct approved tasks", async () => {
  const x = setup();
  x.board.exec("INSERT INTO task_projects VALUES('i','t','task2','p');");
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "First bounded implementation",
  );
  await x.service.approve(
    x.scope,
    "task2",
    "codex",
    "Second bounded implementation",
  );
  const results = await Promise.allSettled([
    x.service.dispatch(x.scope, "task"),
    x.service.dispatch(x.scope, "task2"),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(x.launch).toHaveBeenCalledTimes(1);
});
test("Core compare-and-set conflict prevents any native launch", async () => {
  const x = setup();
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build a bounded implementation",
  );
  const base = x.invoke.getMockImplementation()!;
  x.invoke.mockImplementation(async (a, b) =>
    a === "task/board-transition" ? { code: 409 } : base(a, b),
  );
  const result = await x.service.dispatch(x.scope, "task");
  expect(x.launch).not.toHaveBeenCalled();
  expect(result.receipt?.lifecycle).toBe("failed");
  expect(
    x.db.prepare("SELECT count(*) n FROM execution_runtime_claims").get().n,
  ).toBe(0);
});
test("raw serialized metadata, changed criteria and archived tasks are gated", async () => {
  const x = setup();
  (x.task as any).metadata_json = JSON.stringify({
    project_board: {
      status: "ready",
      acceptanceCriteria: "Verify screen readers",
    },
  });
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build a bounded implementation",
  );
  expect((await x.service.get(x.scope, "task")).eligibility.eligible).toBe(
    true,
  );
  (x.task as any).metadata_json = JSON.stringify({
    project_board: {
      status: "ready",
      acceptanceCriteria: "Different criteria",
    },
  });
  expect(
    (await x.service.get(x.scope, "task")).eligibility.reasons.join(),
  ).toContain("stale");
  (x.task as any).status = "completed";
  expect(
    (await x.service.get(x.scope, "task")).eligibility.reasons.join(),
  ).toContain("Archived");
});

test("background service requires explicit grant, active mode and fresh membership; no owner keys persisted", async () => {
  const x = setup(),
    root = mkdtempSync(path.join(tmpdir(), "execution-service-"));
  const cfg = path.join(root, "principals.json"),
    key = path.join(root, "key");
  writeFileSync(key, "test-service-credential");
  writeFileSync(
    cfg,
    JSON.stringify([
      {
        instance: "i",
        team: "t",
        owner: "u",
        serviceUser: "svc",
        keyFile: key,
      },
    ]),
  );
  process.env.WORKBENCH_SERVICE_PRINCIPALS_FILE = cfg;
  let active = true;
  const base = x.invoke.getMockImplementation()!;
  x.invoke.mockImplementation(async (a, b) =>
    a === "auth/verify"
      ? { code: 0, data: { valid: true, user: { user_id: "svc" } } }
      : a === "team-member/get"
        ? { code: 0, data: { status: active ? "active" : "removed" } }
        : a === "task/execution-grant"
          ? { code: 0, data: {} }
          : base(a, b),
  );
  const service = createExecutionService(
    x.db,
    () => x.board,
    {
      metaKernel: { invoke: x.invoke },
      instanceRegistry: {
        resolve: () => ({
          gateway_endpoint: "http://localhost",
          api_key: "gateway",
        }),
      },
    } as any,
    x.runner,
  );
  x.scope.bindings[0] = {
    ...x.scope.bindings[0],
    instance: "i",
    team: "t",
    user: "u",
  };
  try {
    await service.bind(x.scope, "p", "b");
    await service.approve(
      x.scope,
      "task",
      "codex",
      "Build the bounded background change",
      false,
      true,
    );
    expect(x.invoke).toHaveBeenCalledWith(
      "task/execution-grant",
      expect.objectContaining({ service_user_id: "svc" }),
      x.scope.ctx,
    );
    process.env.WORKBENCH_EXECUTION_MODE = "shadow";
    await service.poll(() => x.scope.bindings);
    expect(x.launch).not.toHaveBeenCalled();
    process.env.WORKBENCH_EXECUTION_MODE = "active";
    active = false;
    await service.poll(() => x.scope.bindings);
    expect(x.launch).not.toHaveBeenCalled();
    active = true;
    await service.poll(() => x.scope.bindings);
    expect(x.launch).toHaveBeenCalledTimes(1);
    await service.poll(() => x.scope.bindings);
    expect(x.launch).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(x.db.prepare("SELECT * FROM execution_records").all()),
    ).not.toContain("test-service-credential");
  } finally {
    delete process.env.WORKBENCH_EXECUTION_MODE;
    delete process.env.WORKBENCH_SERVICE_PRINCIPALS_FILE;
    rmSync(root, { recursive: true, force: true });
  }
});

test("follow-up receipts are idempotent and prior completion cannot approve new instructions", async () => {
  const x = setup();
  x.runner.send = vi.fn(async (_b: any, id: string) => ({
    id,
    state: "running",
    lifecycle: "working",
  }));
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build a bounded implementation",
  );
  await x.service.dispatch(x.scope, "task");
  await x.service.sync(x.scope, "task");
  x.runner.read.mockImplementationOnce(async (_b: any, id: string) => ({
    id,
    state: "running",
    lifecycle: "working",
    events: [
      { id: "event1", type: "worker_done", subject: "prior", body: "prior" },
    ],
  }));
  await x.service.send(x.scope, "task", "Simplify the header", "operation-one");
  await x.service.send(x.scope, "task", "Simplify the header", "operation-one");
  expect(x.runner.send).toHaveBeenCalledTimes(1);
  await expect(
    x.service.send(x.scope, "task", "Different request", "operation-one"),
  ).rejects.toThrow("different");
  const result = await x.service.sync(x.scope, "task");
  expect(result.receipt?.lifecycle).toBe("unknown");
  expect(result.canAccept).toBe(false);
  await expect(x.service.accept(x.scope, "task", "s")).rejects.toThrow(
    "Review",
  );
});

test("explicit revision continues one native job and replays do not duplicate it", async () => {
  const x = setup();
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build a bounded implementation",
  );
  await x.service.dispatch(x.scope, "task");
  await x.service.sync(x.scope, "task");
  x.runner.continue = vi.fn(
    async (_b: any, id: string, _spec: string, operation: string) => ({
      id,
      state: "running",
      lifecycle: "working",
      native: {
        runId: "run",
        taskId: "revision-task",
        dispatchId: "new-dispatch",
      },
      lastOperation: { id: operation, action: "continue", status: "accepted" },
    }),
  );
  const revised = await x.service.continue(
    x.scope,
    "task",
    "Revise the header and verify accessibility",
    "revision-one",
  );
  expect(x.runner.continue).toHaveBeenCalledTimes(1);
  expect(revised.spec).toContain("Revise the header");
  expect(revised.receipt?.native?.taskId).toBe("revision-task");
  expect(x.task.metadata_json.project_board.status).toBe("in_progress");
  await x.service.continue(
    x.scope,
    "task",
    "Revise the header and verify accessibility",
    "revision-one",
  );
  expect(x.runner.continue).toHaveBeenCalledTimes(1);
  await expect(
    x.service.continue(
      x.scope,
      "task",
      "Different revision instructions",
      "revision-one",
    ),
  ).rejects.toThrow("different");
  expect(x.db.prepare("SELECT count(*) n FROM execution_history").get().n).toBe(
    1,
  );
});
test("refused completed send preserves review and does not acquire runtime capacity", async () => {
  const x = setup();
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(
    x.scope,
    "task",
    "codex",
    "Build a bounded implementation",
  );
  await x.service.dispatch(x.scope, "task");
  await x.service.sync(x.scope, "task");
  x.runner.send = vi.fn();
  const result = await x.service.send(
    x.scope,
    "task",
    "Please simplify this",
    "send-to-completed",
  );
  expect(result.receipt?.lastOperation?.status).toBe("refused");
  expect(x.runner.send).not.toHaveBeenCalled();
  expect(x.task.metadata_json.project_board.status).toBe("review");
  expect(
    x.db.prepare("SELECT count(*) n FROM execution_runtime_claims").get().n,
  ).toBe(0);
});
test("invalid background Wiki approval changes no Core execution grants", async () => {
  const x = setup();
  await x.service.bind(x.scope, "p", "b");
  await expect(
    x.service.approve(
      x.scope,
      "task",
      "codex",
      "Build a bounded implementation",
      false,
      true,
      [{ kind: "wiki_page", wikiId: "wiki", ref: "page" }],
    ),
  ).rejects.toThrow("interactive");
  expect(x.invoke.mock.calls.some(([a]) => a === "task/execution-grant")).toBe(
    false,
  );
});

for (const result of ["accepted", "refused"] as const) {
  test(`lost continuation ${result} receipt reconciles without launching another revision`, async () => {
    const x = setup();
    await x.service.bind(x.scope, "p", "b");
    await x.service.approve(
      x.scope,
      "task",
      "codex",
      "Build a bounded implementation",
    );
    await x.service.dispatch(x.scope, "task");
    await x.service.sync(x.scope, "task");
    x.runner.continue = vi.fn(async () => {
      throw Error("lost response");
    });
    const pending = await x.service.continue(
      x.scope,
      "task",
      "Revise the header and verify",
      "lost-revision",
    );
    expect(pending.pendingContinuation).toEqual({
      operation: "lost-revision",
      spec: "Revise the header and verify",
    });
    expect(JSON.stringify(pending.pendingContinuation)).not.toContain(
      "priorBody",
    );
    x.runner.read.mockImplementation(async (_b: any, id: string) => ({
      id,
      state: result === "accepted" ? "running" : "exited",
      lifecycle: result === "accepted" ? "working" : "review",
      lastOperation: {
        id: "lost-revision",
        action: "continue",
        status: result,
      },
      native: { runId: "r", taskId: result === "accepted" ? "new" : "old" },
    }));
    const reconciled = await x.service.sync(x.scope, "task");
    expect(reconciled.pendingContinuation).toBeUndefined();
    expect(reconciled.spec).toBe(
      result === "accepted"
        ? "Revise the header and verify"
        : "Build a bounded implementation",
    );
    expect(x.task.metadata_json.project_board.status).toBe(
      result === "accepted" ? "in_progress" : "review",
    );
    await x.service.continue(
      x.scope,
      "task",
      "Revise the header and verify",
      "lost-revision",
    );
    expect(x.runner.continue).toHaveBeenCalledTimes(1);
  });
}
test("oversized rendered task and disabled revisions invoke no worker", async () => {
  const x = setup();
  x.task.description = "X".repeat(51000);
  await x.service.bind(x.scope, "p", "b");
  await x.service.approve(x.scope, "task", "codex", "Bounded instructions");
  const result = await x.service.dispatch(x.scope, "task");
  expect(result.receipt?.lifecycle).toBe("failed");
  expect(x.launch).not.toHaveBeenCalled();
  expect(x.task.metadata_json.project_board.status).toBe("ready");
  process.env.WORKBENCH_EXECUTION_MODE = "off";
  try {
    await expect(
      x.service.continue(x.scope, "task", "Revise the header", "off-revision"),
    ).rejects.toThrow("disabled");
  } finally {
    delete process.env.WORKBENCH_EXECUTION_MODE;
  }
});

for (const mismatch of ["worker", "action"] as const) {
  test(`pending revision rejects wrong ${mismatch} receipt before recovery effects`, async () => {
    const x = setup();
    await x.service.bind(x.scope, "p", "b");
    await x.service.approve(
      x.scope,
      "task",
      "codex",
      "Build a bounded implementation",
    );
    await x.service.dispatch(x.scope, "task");
    await x.service.sync(x.scope, "task");
    x.runner.continue = vi.fn(async () => {
      throw Error("lost response");
    });
    await x.service.continue(
      x.scope,
      "task",
      "Revise the header and verify",
      "identity-revision",
    );
    x.runner.read.mockImplementation(async (_b: any, id: string) => ({
      id: mismatch === "worker" ? "unrelated-worker" : id,
      state: "exited",
      lifecycle: "review",
      lastOperation: {
        id: "identity-revision",
        action: mismatch === "action" ? "send" : "continue",
        status: "refused",
      },
    }));
    const result = await x.service.sync(x.scope, "task");
    expect(result.pendingContinuation?.operation).toBe("identity-revision");
    expect(result.receipt?.lifecycle).toBe("unknown");
    expect(x.task.metadata_json.project_board.status).toBe("in_progress");
    expect(
      x.db.prepare("SELECT count(*) n FROM execution_runtime_claims").get().n,
    ).toBe(1);
  });
}
