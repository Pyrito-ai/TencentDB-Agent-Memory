import { test, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionService } from "../src/panel/workbench/execution.js";
import { SqliteMetadataStore } from "../../MemoryCore/src/metadata/store/sqlite-adapter.js";
import {
  MetadataService,
  MetadataError,
} from "../../MemoryCore/src/metadata/service/metadata-service.js";
import { authenticateV3 } from "../../MemoryCore/src/metadata/router/auth.js";
import { V3_SCHEMAS } from "../../MemoryCore/src/metadata/router/v3-meta-schemas.js";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
function setup() {
  const core = new SqliteMetadataStore(":memory:");
  core.init();
  const owner = core.createUser({
    username: "Owner",
    auth_provider: "local",
    external_id: "owner",
    default_key_value: "fixture-owner",
  });
  const delegate = core.createUser({
    username: "Service",
    auth_provider: "local",
    external_id: "service",
    default_key_value: "fixture-service",
  });
  const team = core.createTeam({ name: "Team", owner_user_id: owner.user_id });
  core.addTeamMember({ team_id: team.team_id, user_id: delegate.user_id });
  const task = core.createTask({
    team_id: team.team_id,
    creator_user_id: owner.user_id,
    title: "Contract task",
    description: "Implement one accessible screen",
    metadata_json: JSON.stringify({
      project_board: {
        status: "ready",
        acceptanceCriteria: "Verify keyboard navigation",
        assignee: owner.user_id,
      },
      untouched: "preserve",
    }),
  });
  const metadata = new MetadataService(core, "contract");
  const db = new DatabaseSync(":memory:"),
    board = new DatabaseSync(":memory:");
  board.exec(
    "CREATE TABLE projects(id,instance,team,created_by,archived);CREATE TABLE task_projects(instance,team,task,project_id);",
  );
  board
    .prepare("INSERT INTO projects VALUES(?,?,?,?,0)")
    .run("p", "contract", team.team_id, owner.user_id);
  board
    .prepare("INSERT INTO task_projects VALUES(?,?,?,?)")
    .run("contract", team.team_id, task.task_id, "p");
  const invoke = vi.fn(async (action: string, body: any, context: any) => {
    const auth = await authenticateV3(context.userKey, metadata);
    if (!auth.ok || !auth.ctx) return { code: 401 };
    const schema = V3_SCHEMAS[`/v3/meta/${action}` as keyof typeof V3_SCHEMAS];
    if (!schema?.safeParse(body).success) return { code: 400 };
    try {
      let data: unknown;
      if (action === "task/board-state")
        data = await metadata.getTaskBoardForCaller(body.task_id, auth.ctx);
      else if (action === "task/execution-grant")
        data = await metadata.grantTaskExecutionForCaller(
          body.task_id,
          body.expected_revision,
          body.service_user_id,
          auth.ctx,
        );
      else if (action === "task/board-transition")
        data = await metadata.transitionTaskBoardForCaller(
          body.task_id,
          body.expected_revision,
          body.status,
          auth.ctx,
        );
      else throw Error(`Unexpected ${action}`);
      return JSON.parse(JSON.stringify({ code: 0, data }));
    } catch (e) {
      if (!(e instanceof MetadataError)) throw e;
      return {
        code:
          e.code === "permission_denied"
            ? 403
            : e.code === "revision_conflict"
              ? 409
              : 400,
        message: e.message,
      };
    }
  });
  const runner = {
    launch: vi.fn(
      async (_binding: any, id: string, _agent?: string, _prompt?: string) => ({
        id,
        state: "running",
        lifecycle: "working",
        native: { taskId: "orca-task" },
      }),
    ),
    read: vi.fn(async (_binding: any, id: string) => ({
      id,
      state: "exited",
      lifecycle: "review",
      events: [
        {
          id: "done",
          type: "worker_done",
          subject: "Done",
          body: "Validated artifact",
          payload: {},
        },
      ],
    })),
    workspace: vi.fn(async () => ({
      snapshot: "review-snapshot",
      truncated: false,
    })),
  };
  const service = createExecutionService(
    db,
    () => board,
    { metaKernel: { invoke } } as any,
    runner as any,
  );
  const scope: any = {
    ctx: { instanceId: "contract", userKey: "fixture-owner" },
    team: team.team_id,
    user: owner.user_id,
    bindings: [
      {
        id: "b",
        repo: "id:r",
        url: "http://localhost",
        instance: "contract",
        team: team.team_id,
        user: owner.user_id,
      },
    ],
  };
  const delegated = {
    ...scope,
    ctx: { ...scope.ctx, userKey: "fixture-service" },
  };
  const root = mkdtempSync(join(tmpdir(), "workbench-core-contract-")),
    config = join(root, "principals.json");
  writeFileSync(
    config,
    JSON.stringify([
      {
        instance: "contract",
        team: team.team_id,
        owner: owner.user_id,
        serviceUser: delegate.user_id,
        keyFile: join(root, "unused"),
      },
    ]),
  );
  const previous = process.env.WORKBENCH_SERVICE_PRINCIPALS_FILE;
  process.env.WORKBENCH_SERVICE_PRINCIPALS_FILE = config;
  const ownerAuth = {
    userId: owner.user_id,
    token: "fixture-owner",
    isAdmin: false,
    isSystemAdmin: false,
  };
  return {
    core,
    metadata,
    db,
    task,
    delegate,
    ownerAuth,
    service,
    scope,
    delegated,
    runner,
    invoke,
    status: () =>
      JSON.parse(core.getTaskById(task.task_id)!.metadata_json).project_board
        .status,
    close: () => {
      if (previous === undefined)
        delete process.env.WORKBENCH_SERVICE_PRINCIPALS_FILE;
      else process.env.WORKBENCH_SERVICE_PRINCIPALS_FILE = previous;
      core.close();
      db.close();
      board.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("real Core grant and serialized task support execution, review, and human-only acceptance", async () => {
  const f = setup();
  try {
    await f.service.bind(f.scope, "p", "b");
    expect(
      (await f.service.get(f.scope, f.task.task_id)).eligibility.eligible,
    ).toBe(false);
    await f.service.approve(
      f.scope,
      f.task.task_id,
      "codex",
      "Implement and verify bounded work",
      false,
      true,
    );
    const granted = await f.metadata.getTaskBoardForCaller(
      f.task.task_id,
      f.ownerAuth,
    );
    expect(typeof granted.task.metadata_json).toBe("string");
    expect(
      JSON.parse(granted.task.metadata_json).execution_service_grant
        .service_user_id,
    ).toBe(f.delegate.user_id);
    await f.service.dispatch(f.delegated, f.task.task_id);
    expect(f.runner.launch).toHaveBeenCalledTimes(1);
    expect(f.status()).toBe("in_progress");
    expect(f.runner.launch.mock.calls[0]?.[3]).toContain(
      "Verify keyboard navigation",
    );
    await f.service.sync(f.delegated, f.task.task_id);
    expect(f.status()).toBe("review");
    expect(f.core.getTaskById(f.task.task_id)?.status).toBe("running");
    await expect(
      f.service.accept(f.delegated, f.task.task_id, "review-snapshot"),
    ).rejects.toThrow("acceptance denied");
    await expect(
      f.service.accept(f.scope, f.task.task_id, "old-snapshot"),
    ).rejects.toThrow("current diff");
    await f.service.accept(f.scope, f.task.task_id, "review-snapshot");
    expect(f.status()).toBe("done");
    expect(f.core.getTaskById(f.task.task_id)?.status).toBe("completed");
    expect(
      JSON.parse(f.core.getTaskById(f.task.task_id)!.metadata_json).untouched,
    ).toBe("preserve");
  } finally {
    f.close();
  }
});
test("Core grant revocation and changed approved scope prevent native launch", async () => {
  const f = setup();
  try {
    await f.service.bind(f.scope, "p", "b");
    await f.service.approve(
      f.scope,
      f.task.task_id,
      "claude",
      "Implement approved scope",
      false,
      true,
    );
    let current = await f.metadata.getTaskBoardForCaller(
      f.task.task_id,
      f.ownerAuth,
    );
    await f.metadata.grantTaskExecutionForCaller(
      f.task.task_id,
      current.revision,
      null,
      f.ownerAuth,
    );
    await expect(
      f.service.dispatch(f.delegated, f.task.task_id),
    ).rejects.toThrow("creator access");
    current = await f.metadata.getTaskBoardForCaller(
      f.task.task_id,
      f.ownerAuth,
    );
    await f.metadata.updateTaskForCaller(
      f.task.task_id,
      { description: "Different scope" },
      f.ownerAuth,
      current.revision,
    );
    await expect(f.service.dispatch(f.scope, f.task.task_id)).rejects.toThrow(
      "stale",
    );
    expect(f.runner.launch).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
test("revocation between Panel snapshot and Core reservation defeats dispatch atomically", async () => {
  const f = setup();
  try {
    await f.service.bind(f.scope, "p", "b");
    await f.service.approve(
      f.scope,
      f.task.task_id,
      "codex",
      "Implement approved scope",
      false,
      true,
    );
    const original = f.invoke.getMockImplementation()!;
    let revoked = false;
    f.invoke.mockImplementation(async (action, body, context) => {
      if (action === "task/board-transition" && !revoked) {
        revoked = true;
        const fresh = await f.metadata.getTaskBoardForCaller(
          f.task.task_id,
          f.ownerAuth,
        );
        await f.metadata.grantTaskExecutionForCaller(
          f.task.task_id,
          fresh.revision,
          null,
          f.ownerAuth,
        );
      }
      return original(action, body, context);
    });
    await expect(
      f.service.dispatch(f.delegated, f.task.task_id),
    ).rejects.toThrow("creator access");
    expect(revoked).toBe(true);
    expect(f.runner.launch).not.toHaveBeenCalled();
    expect(f.status()).toBe("ready");
    const saved = f.db
      .prepare("SELECT body FROM execution_records WHERE task=?")
      .get(f.task.task_id);
    expect(JSON.parse(String(saved!.body)).receipt.lifecycle).toBe("failed");
  } finally {
    f.close();
  }
});
