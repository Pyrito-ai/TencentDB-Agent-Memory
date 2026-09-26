import {
  collectWorkbenchContext,
  type WikiContextReference,
} from "./context.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PanelDeps } from "../panel-deps.js";
import type { MetaCallContext } from "../kernel/types.js";
import type { Binding, Runner, Receipt } from "./runner-client.js";

export class ExecutionError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export interface ExecutionScope {
  ctx: MetaCallContext;
  team: string;
  user: string;
  bindings: Binding[];
}
export interface ExecutionProject {
  id: string;
  created_by: string;
  archived?: number;
  [key: string]: unknown;
}
export interface BoardLookup {
  project(
    scope: ExecutionScope,
    taskId: string,
  ): Promise<ExecutionProject | undefined>;
  byId(
    scope: ExecutionScope,
    projectId: string,
  ): Promise<ExecutionProject | undefined>;
  isLoopTask(scope: ExecutionScope, taskId: string): Promise<boolean>;
}
interface RecordData {
  taskId: string;
  projectId: string;
  binding: string;
  agent: "codex" | "claude";
  spec: string;
  specHash: string;
  approvedAt: number;
  loopOptIn: boolean;
  background?: boolean;
  contextReferences?: WikiContextReference[];
  contextText?: string;
  contextHash?: string;
  workerId?: string;
  receipt?: Receipt;
  projectionPending?: string;
  acceptedSnapshot?: string;
  followupAfterEvents?: string[];
  pendingMessage?: { operation: string; text: string; replyTo?: string };
  pendingContinuation?: {
    operation: string;
    spec: string;
    launchSpec: string;
    priorBody: string;
    boardRevision?: string;
  };
}
const backgroundSchema = z.array(
  z.object({
    instance: z.string(),
    team: z.string(),
    owner: z.string(),
    serviceUser: z.string(),
    keyFile: z.string(),
  }),
);
const backgroundConfigs = () =>
  process.env.WORKBENCH_SERVICE_PRINCIPALS_FILE
    ? backgroundSchema.parse(
        JSON.parse(
          readFileSync(process.env.WORKBENCH_SERVICE_PRINCIPALS_FILE, "utf8"),
        ),
      )
    : [];
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function createExecutionService(
  db: DatabaseSync,
  board: () => DatabaseSync | undefined,
  deps: PanelDeps,
  runner: Runner,
  lookup?: BoardLookup,
) {
  const principal = (s: ExecutionScope) =>
    backgroundConfigs().find(
      (x) =>
        x.instance === s.ctx.instanceId &&
        x.team === s.team &&
        x.owner === s.user,
    );
  db.exec(`CREATE TABLE IF NOT EXISTS execution_bindings(instance TEXT,team TEXT,owner TEXT,project TEXT,binding TEXT,PRIMARY KEY(instance,team,owner,project));
 CREATE TABLE IF NOT EXISTS execution_records(instance TEXT,team TEXT,owner TEXT,task TEXT,body TEXT,PRIMARY KEY(instance,team,task));
 CREATE TABLE IF NOT EXISTS execution_claims(instance TEXT,team TEXT,task TEXT,worker TEXT UNIQUE,PRIMARY KEY(instance,team,task));
 CREATE TABLE IF NOT EXISTS execution_runtime_claims(runtime TEXT PRIMARY KEY,worker TEXT UNIQUE);
 CREATE TABLE IF NOT EXISTS execution_operations(instance TEXT,team TEXT,task TEXT,pid INTEGER,token TEXT,PRIMARY KEY(instance,team,task));
 CREATE TABLE IF NOT EXISTS execution_messages(instance TEXT,team TEXT,task TEXT,operation TEXT,hash TEXT,body TEXT,PRIMARY KEY(instance,team,task,operation));
 CREATE TABLE IF NOT EXISTS execution_history(worker TEXT PRIMARY KEY,body TEXT);
 CREATE TABLE IF NOT EXISTS execution_events(instance TEXT,team TEXT,task TEXT,event TEXT,body TEXT,PRIMARY KEY(instance,team,task,event));`);
  async function locked<T>(
    s: ExecutionScope,
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db
        .prepare(
          "SELECT pid FROM execution_operations WHERE instance=? AND team=? AND task=?",
        )
        .get(s.ctx.instanceId, s.team, id);
      if (previous) {
        let dead = false;
        try {
          process.kill(Number(previous.pid), 0);
        } catch (e) {
          dead = (e as NodeJS.ErrnoException).code === "ESRCH";
        }
        if (dead)
          db.prepare(
            "DELETE FROM execution_operations WHERE instance=? AND team=? AND task=?",
          ).run(s.ctx.instanceId, s.team, id);
      }
      db.prepare("INSERT INTO execution_operations VALUES(?,?,?,?,?)").run(
        s.ctx.instanceId,
        s.team,
        id,
        process.pid,
        token,
      );
      db.exec("COMMIT");
    } catch {
      db.exec("ROLLBACK");
      throw new ExecutionError("Task has an operation in progress.");
    }
    try {
      return await operation();
    } finally {
      db.prepare(
        "DELETE FROM execution_operations WHERE instance=? AND team=? AND task=? AND token=?",
      ).run(s.ctx.instanceId, s.team, id, token);
    }
  }
  function load(s: ExecutionScope, id: string): RecordData | undefined {
    const r = db
      .prepare(
        "SELECT body FROM execution_records WHERE instance=? AND team=? AND owner=? AND task=?",
      )
      .get(s.ctx.instanceId, s.team, s.user, id);
    return r ? JSON.parse(String(r.body)) : undefined;
  }
  function save(s: ExecutionScope, r: RecordData) {
    db.prepare(
      "INSERT INTO execution_records VALUES(?,?,?,?,?) ON CONFLICT(instance,team,task) DO UPDATE SET body=excluded.body WHERE execution_records.owner=excluded.owner",
    ).run(s.ctx.instanceId, s.team, s.user, r.taskId, JSON.stringify(r));
  }
  async function snapshot(s: ExecutionScope, id: string) {
    const e = await deps.metaKernel.invoke(
      "task/board-state",
      { task_id: id },
      s.ctx,
    );
    const v = e.data as { task: Record<string, any>; revision: string } | null;
    if (
      e.code !== 0 ||
      !v?.task ||
      v.task.team_id !== s.team ||
      v.task.creator_user_id !== s.user
    )
      throw new ExecutionError(
        "Task creator access and current Core execution APIs are required.",
        403,
      );
    return v;
  }
  async function project(s: ExecutionScope, id: string) {
    if (lookup) return lookup.project(s, id);
    const b = board();
    if (!b) throw new ExecutionError("Task Board storage is unavailable.", 503);
    return b
      .prepare(
        "SELECT p.* FROM task_projects t JOIN projects p ON p.id=t.project_id AND p.instance=t.instance AND p.team=t.team WHERE t.instance=? AND t.team=? AND t.task=? AND p.archived=0",
      )
      .get(s.ctx.instanceId, s.team, id);
  }
  function bindingFor(s: ExecutionScope, p: string) {
    return db
      .prepare(
        "SELECT binding FROM execution_bindings WHERE instance=? AND team=? AND owner=? AND project=?",
      )
      .get(s.ctx.instanceId, s.team, s.user, p)?.binding as string | undefined;
  }
  function metadata(task: Record<string, any>) {
    let m = task.metadata_json ?? task.metadata;
    if (typeof m === "string") {
      try {
        return JSON.parse(m);
      } catch {
        return {};
      }
    }
    return m || {};
  }
  function runtimeKey(b: Binding) {
    return hash({
      instance: b.instance,
      team: b.team,
      user: b.user,
      url: b.url,
    });
  }
  function specHash(
    task: Record<string, any>,
    p: string,
    b: Binding,
    r: Pick<RecordData, "spec" | "agent">,
  ) {
    return hash({
      title: task.title,
      description: task.description,
      project: p,
      binding: b.id,
      repo: b.repo,
      url: b.url,
      agent: r.agent,
      spec: r.spec,
      criteria: metadata(task)?.project_board?.acceptanceCriteria,
      plannedStart: metadata(task)?.project_board?.plannedStart,
    });
  }
  function status(task: Record<string, any>) {
    return metadata(task)?.project_board?.status || "backlog";
  }
  async function get(s: ExecutionScope, id: string) {
    const v = await snapshot(s, id),
      p = await project(s, id),
      r = load(s, id),
      binding = p ? bindingFor(s, String(p.id)) : undefined,
      b = s.bindings.find((x) => x.id === binding && x.repo !== "managed");
    const reasons: string[] = [];
    if (v.task.status === "completed" || v.task.status === "archived")
      reasons.push("Archived or completed tasks cannot execute.");
    const plannedStart = metadata(v.task)?.project_board?.plannedStart;
    if (
      typeof plannedStart === "string" &&
      plannedStart > new Date().toISOString().slice(0, 10)
    )
      reasons.push("Planned start has not arrived.");
    if (
      b &&
      db
        .prepare("SELECT 1 FROM execution_runtime_claims WHERE runtime=?")
        .get(runtimeKey(b))
    )
      reasons.push("Runtime capacity is occupied by an existing execution.");
    if (!p) reasons.push("Assign an active Tencent project.");
    if (!b) reasons.push("Map this project to an authorized Orca repository.");
    if (!r) reasons.push("Approve this task specification explicitly.");
    if (status(v.task) !== "ready") reasons.push("Task must be Ready.");
    if (r && p && b && r.specHash !== specHash(v.task, String(p.id), b, r))
      reasons.push("Task or project changed; approval is stale.");
    let loopTask = false;
    if (lookup) loopTask = await lookup.isLoopTask(s, id);
    else {
      const linked = board()
        ?.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='loop_occurrences'",
        )
        .get();
      loopTask = !!(
        linked &&
        board()!
          .prepare(
            "SELECT 1 FROM loop_occurrences WHERE instance=? AND team=? AND task_id=?",
          )
          .get(s.ctx.instanceId, s.team, id)
      );
    }
    if (loopTask && !r?.loopOptIn)
      reasons.push("Loop execution requires explicit opt-in.");
    if (
      db
        .prepare(
          "SELECT 1 FROM execution_claims WHERE instance=? AND team=? AND task=?",
        )
        .get(s.ctx.instanceId, s.team, id)
    )
      reasons.push(
        "An execution is already claimed; synchronize the existing attempt.",
      );
    if (
      process.env.WORKBENCH_EXECUTION_MODE === "off" ||
      process.env.WORKBENCH_EXECUTION_MODE === "shadow"
    )
      reasons.push(
        `Execution mode is ${process.env.WORKBENCH_EXECUTION_MODE}.`,
      );
    return {
      ...r,
      pendingContinuation: r?.pendingContinuation
        ? {
            operation: r.pendingContinuation.operation,
            spec: r.pendingContinuation.spec,
          }
        : undefined,
      taskId: id,
      taskTitle: v.task.title,
      taskDescription: v.task.description,
      acceptanceCriteria: metadata(v.task)?.project_board?.acceptanceCriteria,
      spec: r?.spec || v.task.description || "",
      projectId: p?.id,
      binding,
      eligibility: { eligible: !reasons.length, reasons },
      canApprove: !!p && !!b && !r?.workerId,
      canBind: !!p,
      canAccept:
        r?.receipt?.lifecycle === "review" &&
        !r.followupAfterEvents &&
        !r.pendingContinuation &&
        !r.pendingMessage &&
        status(v.task) === "review",
      backgroundReady: !!principal(s),
      backgroundReason: principal(s)
        ? undefined
        : "Dedicated scoped service credentials are not configured.",
    };
  }
  async function bind(s: ExecutionScope, projectId: string, binding: string) {
    const p = lookup
      ? await lookup.byId(s, projectId)
      : board()
          ?.prepare(
            "SELECT * FROM projects WHERE id=? AND instance=? AND team=? AND archived=0",
          )
          .get(projectId, s.ctx.instanceId, s.team);
    if (
      !p ||
      p.created_by !== s.user ||
      !s.bindings.some((b) => b.id === binding && b.repo !== "managed")
    )
      throw new ExecutionError(
        "Only the project creator may map their authorized runtime.",
        403,
      );
    const old = bindingFor(s, projectId);
    if (old && old !== binding) {
      const records = db
        .prepare(
          "SELECT body FROM execution_records WHERE instance=? AND team=? AND owner=?",
        )
        .all(s.ctx.instanceId, s.team, s.user);
      if (
        records.some((row) => {
          const r = JSON.parse(String(row.body)) as RecordData;
          return (
            r.projectId === projectId &&
            r.workerId &&
            !["failed", "stopped"].includes(r.receipt?.lifecycle || "")
          );
        })
      )
        throw new ExecutionError(
          "Stop and reconcile existing project executions before remapping.",
        );
    }
    db.prepare(
      "INSERT INTO execution_bindings VALUES(?,?,?,?,?) ON CONFLICT(instance,team,owner,project) DO UPDATE SET binding=excluded.binding",
    ).run(s.ctx.instanceId, s.team, s.user, projectId, binding);
    return { projectId, binding };
  }
  async function approve(
    s: ExecutionScope,
    id: string,
    agent: "codex" | "claude",
    spec: string,
    loopOptIn = false,
    background = false,
    contextReferences: WikiContextReference[] = [],
  ) {
    const v = await snapshot(s, id),
      p = await project(s, id);
    if (!p) throw new ExecutionError("Assign a project first.");
    const binding = bindingFor(s, String(p.id)),
      b = s.bindings.find((x) => x.id === binding && x.repo !== "managed");
    if (!b) throw new ExecutionError("Map a runtime first.");
    if (load(s, id)?.workerId)
      throw new ExecutionError(
        "Existing execution must be reconciled; reapproval cannot relaunch it.",
      );
    if (background && contextReferences.length)
      throw new ExecutionError(
        "Selected Wiki context currently requires interactive approval and dispatch.",
      );
    const context = contextReferences.length
      ? await collectWorkbenchContext(deps, s.ctx, {
          teamId: s.team,
          userId: s.user,
          taskId: id,
          references: contextReferences,
        })
      : undefined;
    if (background || load(s, id)?.background) {
      const p = principal(s);
      if (!p)
        throw new ExecutionError("Background execution is not configured.");
      const grant = await deps.metaKernel.invoke(
        "task/execution-grant",
        {
          task_id: id,
          expected_revision: v.revision,
          service_user_id: background ? p.serviceUser : null,
        },
        s.ctx,
      );
      if (grant.code !== 0)
        throw new ExecutionError(
          "Could not authorize the scoped execution service.",
        );
    }
    const r: RecordData = {
      contextReferences,
      contextText: context?.text,
      contextHash: context ? hash(context) : undefined,
      background,
      taskId: id,
      projectId: String(p.id),
      binding: b.id,
      agent,
      spec,
      specHash: specHash(v.task, String(p.id), b, { agent, spec }),
      approvedAt: Date.now(),
      loopOptIn,
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        db
          .prepare(
            "SELECT 1 FROM execution_claims WHERE instance=? AND team=? AND task=?",
          )
          .get(s.ctx.instanceId, s.team, id)
      )
        throw new ExecutionError("Task already claimed.");
      save(s, r);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return get(s, id);
  }
  async function projectReceipt(s: ExecutionScope, r: RecordData) {
    if (["review", "failed", "stopped"].includes(r.receipt?.lifecycle || ""))
      db.prepare("DELETE FROM execution_runtime_claims WHERE worker=?").run(
        r.workerId!,
      );
    for (const e of r.receipt?.events || [])
      db.prepare(
        "INSERT OR IGNORE INTO execution_events VALUES(?,?,?,?,?)",
      ).run(s.ctx.instanceId, s.team, r.taskId, e.id, JSON.stringify(e));
    const v = await snapshot(s, r.taskId),
      p = await project(s, r.taskId),
      b = s.bindings.find((b) => b.id === r.binding);
    if (
      !p ||
      !b ||
      bindingFor(s, String(p.id)) !== r.binding ||
      r.specHash !== specHash(v.task, String(p.id), b, r)
    ) {
      r.projectionPending =
        "Task changed; review execution against approved scope manually.";
      save(s, r);
      return;
    }
    if (v.task.status === "completed" || v.task.status === "archived") {
      r.projectionPending =
        "Task archived; execution evidence retained without reopening.";
      save(s, r);
      return;
    }
    const current = status(v.task),
      target =
        r.receipt?.lifecycle === "review"
          ? "review"
          : r.receipt?.state === "running"
            ? "in_progress"
            : undefined;
    if (
      target &&
      ((target === "in_progress" && current === "ready") ||
        (target === "review" && ["ready", "in_progress"].includes(current)))
    ) {
      r.projectionPending = target;
      save(s, r);
      const e = await deps.metaKernel.invoke(
        "task/board-transition",
        { task_id: r.taskId, expected_revision: v.revision, status: target },
        s.ctx,
      );
      if (e.code === 0) delete r.projectionPending;
    }
    save(s, r);
  }
  async function dispatch(
    s: ExecutionScope,
    id: string,
    workerId: string = randomUUID(),
  ) {
    const eligible = await get(s, id);
    if (!eligible.eligibility.eligible)
      throw new ExecutionError(eligible.eligibility.reasons.join(" "));
    const r = load(s, id)!;
    const b = s.bindings.find((b) => b.id === r.binding)!;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO execution_runtime_claims VALUES(?,?)").run(
        runtimeKey(b),
        workerId,
      );
      db.prepare("INSERT INTO execution_claims VALUES(?,?,?,?)").run(
        s.ctx.instanceId,
        s.team,
        id,
        workerId,
      );
      r.workerId = workerId;
      r.receipt = { id: workerId, state: "launching", lifecycle: "starting" };
      save(s, r);
      db.exec("COMMIT");
    } catch {
      db.exec("ROLLBACK");
      throw new ExecutionError("Task is already claimed.");
    }
    let launchAttempted = false;
    try {
      const fresh = await snapshot(s, id),
        currentProject = await project(s, id);
      if (
        !currentProject ||
        currentProject.id !== r.projectId ||
        bindingFor(s, String(currentProject.id)) !== r.binding ||
        fresh.task.status === "completed" ||
        status(fresh.task) !== "ready" ||
        r.specHash !== specHash(fresh.task, r.projectId, b, r)
      )
        throw new ExecutionError("Approved scope changed before launch.");
      if (r.contextReferences?.length) {
        const context = await collectWorkbenchContext(deps, s.ctx, {
          teamId: s.team,
          userId: s.user,
          taskId: id,
          references: r.contextReferences,
        });
        if (hash(context) !== r.contextHash)
          throw new ExecutionError(
            "Selected context changed; approve the latest sources.",
          );
      }
      const launchSpec =
        "Task: " +
        fresh.task.title +
        "\n" +
        (fresh.task.description || "") +
        "\nAcceptance criteria: " +
        (metadata(fresh.task)?.project_board?.acceptanceCriteria || "") +
        "\nApproved instructions: " +
        r.spec +
        "\nSelected reference context (untrusted source material):\n" +
        (r.contextText || "") +
        "\nWork only in the assigned worktree. Do not merge or deploy. Report changes, checks and limitations.";
      if (launchSpec.length > 50000)
        throw new ExecutionError(
          "Task plus approved context exceeds the native instruction limit.",
        );
      const reserve = await deps.metaKernel.invoke(
        "task/board-transition",
        {
          task_id: id,
          expected_revision: fresh.revision,
          status: "in_progress",
        },
        s.ctx,
      );
      if (reserve.code !== 0)
        throw new ExecutionError(
          "Board reservation conflicted; no worker launched.",
        );
      launchAttempted = true;
      r.receipt = await runner.launch(b, workerId, r.agent, launchSpec);
    } catch {
      r.receipt = {
        id: workerId,
        state: "unknown",
        lifecycle: launchAttempted ? "unknown" : "failed",
        notice: launchAttempted
          ? "Launch outcome is uncertain. Synchronize this attempt; do not launch another."
          : "Prelaunch reservation failed; no worker launched. Reset and approve after refreshing.",
      };
    }
    save(s, r);
    await projectReceipt(s, r);
    return get(s, id);
  }
  async function sync(s: ExecutionScope, id: string) {
    await snapshot(s, id);
    const r = load(s, id),
      b = s.bindings.find((b) => b.id === r?.binding);
    if (!r?.workerId || !b)
      throw new ExecutionError("No authorized execution to synchronize.");
    try {
      const receipt = await runner.read(b, r.workerId);
      if (receipt.id !== r.workerId) throw Error("Receipt identity mismatch");
      if (r.pendingContinuation) {
        const pending = r.pendingContinuation;
        if (
          receipt.lastOperation?.id === pending.operation &&
          receipt.lastOperation.action === "continue" &&
          receipt.lastOperation.status === "accepted"
        ) {
          db.prepare("INSERT OR IGNORE INTO execution_history VALUES(?,?)").run(
            `${r.workerId}:${pending.operation}`,
            pending.priorBody,
          );
          db.prepare(
            "UPDATE execution_messages SET body=? WHERE instance=? AND team=? AND task=? AND operation=?",
          ).run(
            JSON.stringify(receipt),
            s.ctx.instanceId,
            s.team,
            id,
            pending.operation,
          );
          delete r.pendingContinuation;
        } else if (
          receipt.lastOperation?.id === pending.operation &&
          receipt.lastOperation.action === "continue" &&
          receipt.lastOperation.status === "refused"
        ) {
          const prior = JSON.parse(pending.priorBody) as RecordData;
          Object.assign(r, prior);
          delete r.pendingContinuation;
          r.receipt = receipt;
          db.prepare("DELETE FROM execution_runtime_claims WHERE worker=?").run(
            r.workerId!,
          );
          db.prepare(
            "UPDATE execution_messages SET body=? WHERE instance=? AND team=? AND task=? AND operation=?",
          ).run(
            JSON.stringify(receipt),
            s.ctx.instanceId,
            s.team,
            id,
            pending.operation,
          );
          if (pending.boardRevision) {
            const rollback = await deps.metaKernel.invoke(
              "task/board-transition",
              {
                task_id: id,
                expected_revision: pending.boardRevision,
                status: "review",
              },
              s.ctx,
            );
            if (rollback.code !== 0)
              r.projectionPending =
                "Revision refused; board changed before review restoration.";
          }
          save(s, r);
          return get(s, id);
        } else receipt.lifecycle = "unknown";
      }

      if (r.followupAfterEvents && receipt.lifecycle === "review") {
        if (
          !(receipt.events || []).some(
            (e) =>
              !r.followupAfterEvents!.includes(e.id) &&
              e.type === "worker_done",
          )
        )
          receipt.lifecycle = "unknown";
        else delete r.followupAfterEvents;
      }
      if (
        r.pendingMessage &&
        receipt.lastOperation?.id === r.pendingMessage.operation &&
        receipt.lastOperation.action === "send" &&
        receipt.lastOperation.status !== "unknown"
      ) {
        db.prepare(
          "UPDATE execution_messages SET body=? WHERE instance=? AND team=? AND task=? AND operation=?",
        ).run(
          JSON.stringify(receipt),
          s.ctx.instanceId,
          s.team,
          id,
          r.pendingMessage.operation,
        );
        delete r.pendingMessage;
      }
      r.receipt = receipt;
    } catch {
      r.receipt = {
        ...r.receipt,
        id: r.workerId,
        state: "unknown",
        lifecycle: "unknown",
      };
    }
    save(s, r);
    await projectReceipt(s, r);
    return get(s, id);
  }
  async function accept(s: ExecutionScope, id: string, snapshotId: string) {
    await sync(s, id);
    const v = await snapshot(s, id),
      r = load(s, id),
      b = s.bindings.find((b) => b.id === r?.binding);
    if (
      !r?.workerId ||
      !b ||
      r.receipt?.lifecycle !== "review" ||
      r.followupAfterEvents ||
      r.pendingContinuation ||
      v.task.status === "completed" ||
      status(v.task) !== "review"
    )
      throw new ExecutionError("A completed execution in Review is required.");
    const p = await project(s, id);
    if (
      !p ||
      bindingFor(s, String(p.id)) !== r.binding ||
      r.specHash !== specHash(v.task, String(p.id), b, r)
    )
      throw new ExecutionError("Approved task scope changed.");
    const view = await runner.workspace(b, r.workerId);
    if (view.truncated || view.snapshot !== snapshotId)
      throw new ExecutionError(
        "Inspect the complete current diff before accepting.",
      );
    const e = await deps.metaKernel.invoke(
      "task/board-transition",
      { task_id: id, expected_revision: v.revision, status: "done" },
      s.ctx,
    );
    if (e.code !== 0)
      throw new ExecutionError(
        "Task changed or acceptance denied. Refresh before retrying.",
      );
    r.acceptedSnapshot = snapshotId;
    save(s, r);
    return get(s, id);
  }
  async function inspect(s: ExecutionScope, id: string) {
    await snapshot(s, id);
    const r = load(s, id),
      b = s.bindings.find((b) => b.id === r?.binding);
    if (!r?.workerId || !b)
      throw new ExecutionError("No authorized execution.");
    return runner.workspace(b, r.workerId);
  }
  async function send(
    s: ExecutionScope,
    id: string,
    text: string,
    operation: string,
    replyTo?: string,
  ) {
    const v = await snapshot(s, id),
      r = load(s, id),
      b = s.bindings.find((b) => b.id === r?.binding);
    if (!r?.workerId || !b)
      throw new ExecutionError("No authorized execution.");
    if (status(v.task) === "done" || v.task.status === "completed")
      throw new ExecutionError("Reopen the task before sending more work.");
    if (
      r.pendingContinuation ||
      (r.pendingMessage && r.pendingMessage.operation !== operation)
    )
      throw new ExecutionError(
        "Reconcile the pending operation before sending another instruction.",
      );
    const digest = hash({ worker: r.workerId, text, replyTo });
    const previous = db
      .prepare(
        "SELECT hash,body FROM execution_messages WHERE instance=? AND team=? AND task=? AND operation=?",
      )
      .get(s.ctx.instanceId, s.team, id, operation);
    if (previous) {
      if (previous.hash !== digest)
        throw new ExecutionError(
          "Operation ID was already used for different instructions.",
        );
      if (
        previous.body &&
        JSON.parse(String(previous.body)).lastOperation?.status !== "unknown"
      )
        return get(s, id);
    }
    const current = await runner.read(b, r.workerId);
    if (current.id !== r.workerId)
      throw new ExecutionError("Worker identity mismatch.");
    if (
      previous &&
      current.lastOperation?.id === operation &&
      current.lastOperation.status !== "unknown"
    ) {
      r.receipt = current;
      delete r.pendingMessage;
      if (current.lastOperation.status === "refused")
        delete r.followupAfterEvents;
      save(s, r);
      db.prepare(
        "UPDATE execution_messages SET body=? WHERE instance=? AND team=? AND task=? AND operation=?",
      ).run(JSON.stringify(current), s.ctx.instanceId, s.team, id, operation);
      if (["review", "failed", "stopped"].includes(current.lifecycle || ""))
        db.prepare("DELETE FROM execution_runtime_claims WHERE worker=?").run(
          r.workerId,
        );
      return get(s, id);
    }

    if (["review", "failed", "stopped"].includes(current.lifecycle || "")) {
      r.receipt = {
        ...current,
        lastOperation: { id: operation, action: "send", status: "refused" },
        notice:
          "This attempt has finished. Approve a revision to continue in the same worktree.",
      };
      save(s, r);
      db.prepare(
        "INSERT OR REPLACE INTO execution_messages VALUES(?,?,?,?,?,?)",
      ).run(
        s.ctx.instanceId,
        s.team,
        id,
        operation,
        digest,
        JSON.stringify(r.receipt),
      );
      return get(s, id);
    }
    const before = JSON.stringify(r),
      beforeStatus = status(v.task);
    let acquired = false;
    if (!previous) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const claim = db
          .prepare(
            "SELECT worker FROM execution_runtime_claims WHERE runtime=?",
          )
          .get(runtimeKey(b));
        if (claim && claim.worker !== r.workerId)
          throw new ExecutionError("Runtime capacity is occupied.");
        acquired = !claim;
        db.prepare(
          "INSERT OR IGNORE INTO execution_runtime_claims VALUES(?,?)",
        ).run(runtimeKey(b), r.workerId);
        db.prepare("INSERT INTO execution_messages VALUES(?,?,?,?,?,?)").run(
          s.ctx.instanceId,
          s.team,
          id,
          operation,
          digest,
          "",
        );
        r.followupAfterEvents = (current.events || []).map((e) => e.id);
        r.pendingMessage = { operation, text, replyTo };
        r.receipt = { ...current, lifecycle: "unknown" };
        delete r.acceptedSnapshot;
        save(s, r);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    const transition = await deps.metaKernel.invoke(
      "task/board-transition",
      { task_id: id, expected_revision: v.revision, status: "in_progress" },
      s.ctx,
    );
    if (transition.code !== 0) {
      if (!previous) {
        save(s, JSON.parse(before));
        db.prepare(
          "DELETE FROM execution_messages WHERE instance=? AND team=? AND task=? AND operation=?",
        ).run(s.ctx.instanceId, s.team, id, operation);
        if (acquired)
          db.prepare("DELETE FROM execution_runtime_claims WHERE worker=?").run(
            r.workerId,
          );
      }
      throw new ExecutionError("Task changed before follow-up.");
    }
    const receipt = await runner.send(b, r.workerId, text, operation, replyTo);
    if (
      receipt.lastOperation?.id === operation &&
      receipt.lastOperation.status === "refused"
    ) {
      const prior = JSON.parse(before) as RecordData;
      prior.receipt = receipt;
      save(s, prior);
      if (acquired)
        db.prepare("DELETE FROM execution_runtime_claims WHERE worker=?").run(
          r.workerId,
        );
      const revision = (transition.data as { revision?: string } | undefined)
        ?.revision;
      if (revision && beforeStatus !== "in_progress")
        await deps.metaKernel.invoke(
          "task/board-transition",
          { task_id: id, expected_revision: revision, status: beforeStatus },
          s.ctx,
        );
    } else {
      if (
        receipt.lastOperation?.id === operation &&
        receipt.lastOperation.status === "accepted"
      )
        delete r.pendingMessage;
      r.receipt = {
        ...receipt,
        lifecycle:
          receipt.lastOperation?.status === "accepted"
            ? receipt.lifecycle
            : "unknown",
      };
      save(s, r);
    }
    db.prepare(
      "UPDATE execution_messages SET body=? WHERE instance=? AND team=? AND task=? AND operation=?",
    ).run(JSON.stringify(receipt), s.ctx.instanceId, s.team, id, operation);
    return get(s, id);
  }
  async function continueExecution(
    s: ExecutionScope,
    id: string,
    spec: string,
    operation: string,
  ) {
    if (
      process.env.WORKBENCH_EXECUTION_MODE === "off" ||
      process.env.WORKBENCH_EXECUTION_MODE === "shadow"
    )
      throw new ExecutionError(
        "New execution is disabled by the current mode.",
      );
    if (spec.length < 10 || spec.length > 8000)
      throw new ExecutionError(
        "Revision instructions must be 10–8000 characters.",
      );
    const v = await snapshot(s, id),
      r = load(s, id),
      b = s.bindings.find((b) => b.id === r?.binding),
      p = await project(s, id);
    if (
      !r?.workerId ||
      !b ||
      !p ||
      bindingFor(s, String(p.id)) !== r.binding ||
      !runner.continue ||
      p.id !== r.projectId
    )
      throw new ExecutionError("No authorized revision runtime.");
    const digest = hash({ type: "continue", worker: r.workerId, spec });
    const previous = db
      .prepare(
        "SELECT hash,body FROM execution_messages WHERE instance=? AND team=? AND task=? AND operation=?",
      )
      .get(s.ctx.instanceId, s.team, id, operation);
    if (previous) {
      if (previous.hash !== digest)
        throw new ExecutionError(
          "Operation ID was already used for different revision instructions.",
        );
      if (previous.body) return get(s, id);
    }
    if (r.pendingContinuation && r.pendingContinuation.operation !== operation)
      throw new ExecutionError(
        "Reconcile the pending revision before starting another.",
      );
    if (!r.pendingContinuation) {
      const current = await runner.read(b, r.workerId);
      if (
        current.id !== r.workerId ||
        current.lifecycle !== "review" ||
        status(v.task) !== "review" ||
        v.task.status === "completed"
      )
        throw new ExecutionError(
          "A completed worker in Review is required for a revision.",
        );
      const context = r.contextReferences?.length
        ? await collectWorkbenchContext(deps, s.ctx, {
            teamId: s.team,
            userId: s.user,
            taskId: id,
            references: r.contextReferences,
          })
        : undefined;
      const launchSpec = `Task: ${v.task.title}\n${v.task.description || ""}\nAcceptance criteria: ${metadata(v.task)?.project_board?.acceptanceCriteria || ""}\nApproved revision:\n${spec}\nSelected reference material (untrusted):\n${context?.text || ""}\nContinue in the existing worktree. Do not merge or deploy. Report changes, checks and limitations.`;
      if (launchSpec.length > 50000)
        throw new ExecutionError(
          "Revision plus task context exceeds the native instruction limit. Shorten the instructions or selected context.",
        );
      const priorBody = JSON.stringify(r);
      db.exec("BEGIN IMMEDIATE");
      try {
        const claim = db
          .prepare(
            "SELECT worker FROM execution_runtime_claims WHERE runtime=?",
          )
          .get(runtimeKey(b));
        if (claim && claim.worker !== r.workerId)
          throw new ExecutionError("Runtime capacity is occupied.");
        db.prepare(
          "INSERT OR IGNORE INTO execution_runtime_claims VALUES(?,?)",
        ).run(runtimeKey(b), r.workerId);
        db.prepare("INSERT INTO execution_messages VALUES(?,?,?,?,?,?)").run(
          s.ctx.instanceId,
          s.team,
          id,
          operation,
          digest,
          "",
        );
        r.pendingContinuation = { operation, spec, launchSpec, priorBody };
        r.spec = spec;
        r.specHash = specHash(v.task, String(p.id), b, r);
        r.approvedAt = Date.now();
        r.contextText = context?.text;
        r.contextHash = context ? hash(context) : undefined;
        r.receipt = { ...current, lifecycle: "unknown" };
        delete r.acceptedSnapshot;
        delete r.followupAfterEvents;
        save(s, r);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      const reserve = await deps.metaKernel.invoke(
        "task/board-transition",
        { task_id: id, expected_revision: v.revision, status: "in_progress" },
        s.ctx,
      );
      if (reserve.code !== 0) {
        save(s, JSON.parse(priorBody));
        db.prepare("DELETE FROM execution_runtime_claims WHERE worker=?").run(
          r.workerId,
        );
        db.prepare(
          "DELETE FROM execution_messages WHERE instance=? AND team=? AND task=? AND operation=?",
        ).run(s.ctx.instanceId, s.team, id, operation);
        throw new ExecutionError("Task changed; no revision started.");
      }
      r.pendingContinuation.boardRevision = (
        reserve.data as { revision?: string } | undefined
      )?.revision;
      save(s, r);
    } else if (
      !r.pendingContinuation.boardRevision ||
      v.revision !== r.pendingContinuation.boardRevision
    ) {
      throw new ExecutionError(
        "Revision reservation changed or is uncertain; inspect before retrying.",
      );
    }
    const pending = r.pendingContinuation!;
    try {
      r.receipt = await runner.continue(
        b,
        r.workerId,
        pending.launchSpec,
        operation,
      );
    } catch {
      r.receipt = {
        ...r.receipt!,
        state: "unknown",
        lifecycle: "unknown",
        lastOperation: { id: operation, action: "continue", status: "unknown" },
      };
      save(s, r);
      return get(s, id);
    }
    if (
      r.receipt.lastOperation?.id !== operation ||
      r.receipt.lastOperation.status === "unknown"
    ) {
      save(s, r);
      return get(s, id);
    }
    const receipt = r.receipt;
    if (receipt.lastOperation?.status === "refused") {
      const prior = JSON.parse(pending.priorBody) as RecordData;
      prior.receipt = receipt;
      save(s, prior);
      db.prepare("DELETE FROM execution_runtime_claims WHERE worker=?").run(
        r.workerId,
      );
      if (pending.boardRevision)
        await deps.metaKernel.invoke(
          "task/board-transition",
          {
            task_id: id,
            expected_revision: pending.boardRevision,
            status: "review",
          },
          s.ctx,
        );
    } else {
      db.prepare("INSERT OR IGNORE INTO execution_history VALUES(?,?)").run(
        `${r.workerId}:${operation}`,
        pending.priorBody,
      );
      delete r.pendingContinuation;
      save(s, r);
    }
    db.prepare(
      "UPDATE execution_messages SET body=? WHERE instance=? AND team=? AND task=? AND operation=?",
    ).run(JSON.stringify(receipt), s.ctx.instanceId, s.team, id, operation);
    return get(s, id);
  }
  let polling = false;
  async function poll(resolveBindings: () => Binding[]) {
    if (polling) return;
    polling = true;
    try {
      for (const p of backgroundConfigs()) {
        try {
          const entry = deps.instanceRegistry.resolve(p.instance);
          if (!entry) continue;
          const key = readFileSync(p.keyFile, "utf8").trim();
          const ctx: MetaCallContext = {
            instanceId: p.instance,
            gatewayEndpoint: entry.gateway_endpoint,
            gatewayApiKey: entry.api_key,
            userKey: key,
          };
          const auth = await deps.metaKernel.invoke(
            "auth/verify",
            { user_key: key },
            ctx,
          );
          if (
            auth.code !== 0 ||
            (auth.data as any)?.user?.user_id !== p.serviceUser
          )
            continue;
          let active = true;
          for (const user of [p.owner, p.serviceUser]) {
            const m = await deps.metaKernel.invoke(
              "team-member/get",
              { team_id: p.team, user_id: user },
              ctx,
            );
            if (m.code !== 0 || (m.data as any)?.status !== "active")
              active = false;
          }
          if (!active) continue;
          const configured = resolveBindings().filter(
              (b) =>
                b.instance === p.instance &&
                b.team === p.team &&
                b.user === p.owner,
            ),
            bindings: Binding[] = [];
          for (const b of configured) {
            bindings.push(b);
            if (b.manageProjects && runner.projects) {
              for (const repo of (await runner.projects(b)).items)
                bindings.push({
                  ...b,
                  id: b.id + ":" + repo.id,
                  repo: "id:" + repo.id,
                  label: repo.name,
                });
            }
          }
          const scope = { ctx, team: p.team, user: p.owner, bindings };
          const rows = db
            .prepare(
              "SELECT body FROM execution_records WHERE instance=? AND team=? AND owner=?",
            )
            .all(p.instance, p.team, p.owner);
          for (const row of rows) {
            const r = JSON.parse(String(row.body)) as RecordData;
            if (!r.background) continue;
            try {
              if (r.workerId) {
                await locked(scope, r.taskId, () => sync(scope, r.taskId));
              } else if (
                process.env.WORKBENCH_EXECUTION_MODE === "active" &&
                (await get(scope, r.taskId)).eligibility.eligible
              ) {
                await locked(scope, r.taskId, () => dispatch(scope, r.taskId));
              }
            } catch {
              /* Revoked grants, changed scopes and uncertain outcomes fail closed per task. */
            }
          }
        } catch {
          /* Missing or revoked service credentials never trigger dispatch. */
        }
      }
    } finally {
      polling = false;
    }
  }
  async function stop(s: ExecutionScope, id: string, operation: string) {
    await snapshot(s, id);
    const r = load(s, id),
      b = s.bindings.find((b) => b.id === r?.binding);
    if (!r?.workerId || !b)
      throw new ExecutionError("No authorized execution.");
    r.receipt = await runner.stop(b, r.workerId, operation);
    save(s, r);
    await projectReceipt(s, r);
    return get(s, id);
  }
  async function reset(s: ExecutionScope, id: string) {
    await snapshot(s, id);
    const r = load(s, id);
    if (
      !r?.workerId ||
      !["failed", "stopped"].includes(r.receipt?.lifecycle || "")
    )
      throw new ExecutionError(
        "Only a confirmed failed or stopped attempt can be reset for fresh approval.",
      );
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO execution_history VALUES(?,?)").run(
        r.workerId,
        JSON.stringify(r),
      );
      db.prepare(
        "DELETE FROM execution_claims WHERE instance=? AND team=? AND task=? AND worker=?",
      ).run(s.ctx.instanceId, s.team, id, r.workerId);
      db.prepare("DELETE FROM execution_runtime_claims WHERE worker=?").run(
        r.workerId,
      );
      db.prepare(
        "DELETE FROM execution_records WHERE instance=? AND team=? AND owner=? AND task=?",
      ).run(s.ctx.instanceId, s.team, s.user, id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return get(s, id);
  }
  return {
    get,
    bind,
    approve: (
      s: ExecutionScope,
      id: string,
      ...args: Parameters<typeof approve> extends [
        unknown,
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => locked(s, id, () => approve(s, id, ...args)),
    dispatch: (s: ExecutionScope, id: string, worker?: string) =>
      locked(s, id, () => dispatch(s, id, worker)),
    sync: (s: ExecutionScope, id: string) => locked(s, id, () => sync(s, id)),
    accept: (s: ExecutionScope, id: string, snapshot: string) =>
      locked(s, id, () => accept(s, id, snapshot)),
    load,
    inspect,
    send: (
      s: ExecutionScope,
      id: string,
      text: string,
      operation: string,
      replyTo?: string,
    ) => locked(s, id, () => send(s, id, text, operation, replyTo)),
    continue: (
      s: ExecutionScope,
      id: string,
      spec: string,
      operation: string,
    ) => locked(s, id, () => continueExecution(s, id, spec, operation)),
    stop: (s: ExecutionScope, id: string, operation: string) =>
      locked(s, id, () => stop(s, id, operation)),
    reset: (s: ExecutionScope, id: string) => locked(s, id, () => reset(s, id)),
    poll,
  };
}
