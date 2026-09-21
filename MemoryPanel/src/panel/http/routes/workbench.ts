import { collectWorkbenchContext } from "../../workbench/context.js";
import {
  createExecutionService,
  ExecutionError,
  type BoardLookup,
} from "../../workbench/execution.js";
import type { Message, WorkerReview } from "../../workbench/types.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { PanelDeps } from "../../panel-deps.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { buildCtx, resolveCallerUserId } from "./knowledge/common.js";
import {
  createCoordinator,
  type Coordinator,
  type Plan,
} from "../../workbench/coordinator.js";
import {
  createRunner,
  loadBindings,
  type Binding,
  type Runner,
  type Receipt,
} from "../../workbench/runner-client.js";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
interface Work {
  id: string;
  title: string;
  agent: "codex" | "claude";
  spec: string;
  state: "proposed" | "launching" | "running" | "exited" | "unknown";
  receipt?: Receipt;
  review?: WorkerReview;
  assessment?: string;
}
interface Run {
  contextReferences?: { kind: "wiki_page"; wikiId: string; ref: string }[];
  taskId?: string;
  pendingActions?: {
    id: string;
    type: "send";
    workerId: string;
    text: string;
    status: "proposed" | "submitted" | "unknown";
  }[];
  projectProposal?: {
    action: "create" | "select";
    name?: string;
    binding?: string;
  };
  id: string;
  binding: string;
  objective: string;
  context: string;
  summary: string;
  workers: Work[];
  review?: string;
  created: number;
  messages?: Message[];
}
export function registerWorkbenchRoutes(
  api: Hono,
  deps: PanelDeps,
  options: {
    root?: string;
    bindings?: Binding[];
    runner?: Runner;
    coordinator?: Coordinator;
    boardRoot?: string;
    boardLookup?: BoardLookup;
  } = {},
) {
  const root =
    options.root ||
    process.env.WORKBENCH_DATA_DIR ||
    path.resolve("data/workbench");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(root, "runs.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workbench_runs(id TEXT PRIMARY KEY,instance TEXT NOT NULL,team TEXT NOT NULL,owner TEXT NOT NULL,body TEXT NOT NULL);",
  );
  const runner = options.runner || createRunner(),
    coordinator = options.coordinator || createCoordinator();
  let boardDb: InstanceType<typeof DatabaseSync> | undefined;
  const execution = createExecutionService(
    db,
    () => {
      if (boardDb) return boardDb;
      const file = path.join(
        options.boardRoot ||
          process.env.TASK_BOARD_DATA_DIR ||
          path.resolve("data/task-board"),
        "time.sqlite",
      );
      if (!existsSync(file)) return undefined;
      boardDb = new DatabaseSync(file);
      return boardDb;
    },
    deps,
    runner,
    options.boardLookup,
  );
  const poller = setInterval(() => {
    void execution.poll(() => options.bindings || loadBindings());
  }, 15000);
  poller.unref();
  const busy = new Set<string>();
  api.use("/workbench/*", validatePanelMetaHeaders(deps));
  api.use(
    "/workbench/*",
    bodyLimit({
      maxSize: 40000,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  api.all("/workbench/:team/:action", async (c) => {
    const ctx = buildCtx(c),
      team = c.req.param("team"),
      action = c.req.param("action");
    const user = await resolveCallerUserId(deps, ctx);
    if (!user) return c.json({ error: "Please sign in." }, 401);
    const membership = await deps.metaKernel.invoke(
      "team-member/get",
      { team_id: team, user_id: user },
      ctx,
    );
    if (
      membership.code !== 0 ||
      (membership.data as { status?: string } | null)?.status !== "active"
    )
      return c.json({ error: "Active team membership required." }, 403);
    c.header("Cache-Control", "private, no-store");
    const configuredBindings = (options.bindings || loadBindings()).filter(
      (b) =>
        b.instance === ctx.instanceId && b.team === team && b.user === user,
    );
    const bindings: Binding[] = [];
    for (const b of configuredBindings) {
      if (!b.manageProjects) {
        bindings.push(b);
        continue;
      }
      bindings.push({
        ...b,
        label: "Choose or create a project with the coordinator",
      });
      if (!runner.projects)
        return c.json({ error: "Project listing is unavailable." }, 503);
      const projects = await runner.projects(b);
      for (const p of projects.items)
        bindings.push({
          ...b,
          id: `${b.id}:${p.id}`,
          repo: `id:${p.id}`,
          label: p.name,
        });
    }
    if (action === "project-create" && c.req.method === "POST") {
      const input = z
        .object({
          runtime: z.string(),
          name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]{1,59}$/),
        })
        .safeParse(await c.req.json());
      if (!input.success)
        return c.json(
          {
            error:
              "Choose a project name of 2–60 letters, numbers, spaces, underscores or hyphens.",
          },
          400,
        );
      const b = configuredBindings.find(
        (b) => b.id === input.data.runtime && b.manageProjects,
      );
      if (!b || !runner.createProject)
        return c.json({ error: "Project creation is not permitted." }, 403);
      const p = await runner.createProject(b, input.data.name);
      return c.json({ binding: `${b.id}:${p.id}`, name: p.name }, 201);
    }
    if (action.startsWith("execution-") && c.req.method === "POST") {
      const parsed = z
        .object({
          taskId: z.string().max(200).optional(),
          projectId: z.string().optional(),
          binding: z.string().optional(),
          agent: z.enum(["codex", "claude"]).optional(),
          spec: z.string().trim().min(10).max(16000).optional(),
          loopOptIn: z.boolean().optional(),
          background: z.boolean().optional(),
          contextReferences: z
            .array(
              z.object({
                kind: z.literal("wiki_page"),
                wikiId: z.string().max(512),
                ref: z.string().max(512),
              }),
            )
            .max(8)
            .optional(),
          text: z.string().trim().min(1).max(8000).optional(),
          operation: z.string().uuid().optional(),
          replyTo: z.string().max(200).optional(),
          snapshot: z.string().optional(),
        })
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ error: "Invalid execution request." }, 400);
      const x = parsed.data,
        scope = { ctx, team, user, bindings };
      try {
        if (action === "execution-bind" && x.projectId && x.binding)
          return c.json(await execution.bind(scope, x.projectId, x.binding));
        if (!x.taskId) return c.json({ error: "Task ID required." }, 400);
        if (action === "execution-get")
          return c.json(await execution.get(scope, x.taskId));
        if (action === "execution-approve" && x.agent && x.spec)
          return c.json(
            await execution.approve(
              scope,
              x.taskId,
              x.agent,
              x.spec,
              x.loopOptIn,
              x.background,
              x.contextReferences,
            ),
          );
        if (action === "execution-dispatch")
          return c.json(await execution.dispatch(scope, x.taskId));
        if (action === "execution-sync")
          return c.json(await execution.sync(scope, x.taskId));
        if (action === "execution-reset")
          return c.json(await execution.reset(scope, x.taskId));
        if (action === "execution-stop" && x.operation)
          return c.json(await execution.stop(scope, x.taskId, x.operation));
        if (action === "execution-continue" && x.spec && x.operation)
          return c.json(
            await execution.continue(scope, x.taskId, x.spec, x.operation),
          );
        if (action === "execution-inspect")
          return c.json(await execution.inspect(scope, x.taskId));
        if (action === "execution-send" && x.text && x.operation)
          return c.json(
            await execution.send(
              scope,
              x.taskId,
              x.text,
              x.operation,
              x.replyTo,
            ),
          );
        if (action === "execution-accept" && x.snapshot)
          return c.json(await execution.accept(scope, x.taskId, x.snapshot));
        return c.json({ error: "Invalid execution operation." }, 400);
      } catch (e) {
        return c.json(
          {
            error:
              e instanceof ExecutionError
                ? e.message
                : "Execution service unavailable.",
          },
          e instanceof ExecutionError ? (e.status as 403 | 409 | 503) : 503,
        );
      }
    }
    const hydrateExecution = async (run: Run) => {
      if (!run.taskId) return;
      const linked = await execution.get(
        { ctx, team, user, bindings },
        run.taskId,
      );
      if (!linked.workerId || !linked.receipt) return;
      run.binding = linked.binding!;
      const existing = run.workers.find((w) => w.id === linked.workerId);
      const work: Work = {
        id: linked.workerId,
        title: linked.taskTitle || "Board task",
        agent: linked.agent!,
        spec: linked.spec,
        state: linked.receipt.state,
        receipt: linked.receipt,
      };
      if (existing) Object.assign(existing, work);
      else run.workers.unshift(work);
    };
    const catalog = `\nAvailable project bindings: ${JSON.stringify(bindings.filter((b) => b.repo !== "managed").map((b) => ({ binding: b.id, name: b.label })))}. Project creation is ${configuredBindings.some((b) => b.manageProjects) ? "available" : "unavailable"}.`;
    if (action === "options" && c.req.method === "GET")
      return c.json({
        bindings: bindings.map((b) => ({
          id: b.id,
          label: b.label,
          ...(b.webUrl ? { webUrl: b.webUrl } : {}),
        })),
        projectRuntimes: configuredBindings
          .filter((b) => b.manageProjects)
          .map((b) => ({ id: b.id, label: b.label })),
        coordinatorReady:
          !!options.coordinator ||
          !!(
            process.env.WORKBENCH_LLM_API_KEY && process.env.WORKBENCH_LLM_MODEL
          ),
      });
    if (action === "runs" && c.req.method === "GET") {
      const rows = db
        .prepare(
          "SELECT body FROM workbench_runs WHERE instance=? AND team=? AND owner=? ORDER BY rowid DESC LIMIT 50",
        )
        .all(ctx.instanceId, team, user);
      return c.json({ items: rows.map((r) => JSON.parse(String(r.body))) });
    }
    if (c.req.method !== "POST")
      return c.json({ error: "Method not allowed" }, 405);
    const body = await c.req.json().catch(() => null);
    if (action === "plan" || action === "start") {
      const parsed = z
        .object({
          operation: z.string().uuid().optional(),
          binding: z.string(),
          objective: z.string().trim().min(10).max(8000),
          context: z.string().max(20000).default(""),
          contextReferences: z
            .array(
              z.object({
                kind: z.literal("wiki_page"),
                wikiId: z.string().max(512),
                ref: z.string().max(512),
              }),
            )
            .max(8)
            .optional(),

          taskId: z.string().max(200).optional(),
        })
        .safeParse(body);
      if (!parsed.success)
        return c.json(
          { error: "Enter an objective and select a connected runtime." },
          400,
        );
      const input = parsed.data;
      if (action === "start" && input.operation) {
        const previous = db
          .prepare(
            "SELECT body FROM workbench_runs WHERE id=? AND instance=? AND team=? AND owner=?",
          )
          .get(input.operation, ctx.instanceId, team, user);
        if (previous) return c.json(JSON.parse(String(previous.body)));
      }
      if (!bindings.some((b) => b.id === input.binding))
        return c.json(
          { error: "Runtime not available to this user and team." },
          403,
        );
      const lock = `plan:${ctx.instanceId}:${team}:${user}`;
      if (busy.has(lock))
        return c.json({ error: "A plan is already being prepared." }, 409);
      busy.add(lock);
      try {
        const project = bindings.find((b) => b.id === input.binding)!;
        let context = `Selected Orca project: ${project.repo === "managed" ? "NONE. Choose or create a project before proposing workers" : project.label + " (" + project.repo + ")"}. Workers execute only in the selected project.\n${input.context}`;
        if (input.taskId) {
          const env = await deps.metaKernel.invoke(
            "task/get",
            { task_id: input.taskId },
            ctx,
          );
          const task = env.data as {
            team_id?: string;
            title?: string;
            description?: string;
          } | null;
          if (env.code !== 0 || !task || task.team_id !== team)
            return c.json({ error: "Task not found in this team." }, 404);
          context += `\nTencent task ${input.taskId}: ${task.title || ""}\n${task.description || ""}`;
        }
        if (input.contextReferences?.length) {
          const scoped = await collectWorkbenchContext(deps, ctx, {
            teamId: team,
            userId: user,
            taskId: input.taskId,
            references: input.contextReferences,
          });
          context += "\n" + scoped.text;
        }
        const plan: Plan =
          action === "plan"
            ? await coordinator.plan(input.objective, context)
            : { summary: "", workers: [] };
        const run: Run = {
          id:
            action === "start" && input.operation
              ? input.operation
              : randomUUID(),
          binding: input.binding,
          taskId: input.taskId,
          contextReferences: input.contextReferences,
          objective: input.objective,
          context,
          summary: plan.summary,
          workers: plan.workers.map((w) => ({
            ...w,
            id: randomUUID(),
            state: "proposed" as const,
          })),
          created: Date.now(),
          messages: [
            {
              id: randomUUID(),
              role: "user",
              text: input.objective,
              created: Date.now(),
            },
          ],
        };
        if (run.taskId) await hydrateExecution(run);
        db.prepare("INSERT INTO workbench_runs VALUES(?,?,?,?,?)").run(
          run.id,
          ctx.instanceId,
          team,
          user,
          JSON.stringify(run),
        );
        if (action === "start") {
          try {
            const answer = await coordinator.chat(
              run.messages!,
              run.context + catalog,
              [],
            );
            run.pendingActions ||= [];
            run.pendingActions.push(
              ...(answer.actions || [])
                .filter((a) =>
                  run.workers.some(
                    (w) => w.id === a.workerId && w.state !== "proposed",
                  ),
                )
                .map((a) => ({
                  ...a,
                  id: randomUUID(),
                  status: "proposed" as const,
                })),
            );
            run.projectProposal = answer.project;
            run.summary = answer.reply;
            run.messages!.push({
              id: randomUUID(),
              role: "assistant",
              text: answer.reply,
              created: Date.now(),
            });
            run.workers = [
              ...run.workers.filter((w) => w.state !== "proposed"),
              ...answer.workers.map((w) => ({
                ...w,
                id: randomUUID(),
                state: "proposed" as const,
              })),
            ];
          } catch {
            run.messages!.push({
              id: randomUUID(),
              role: "event",
              text: "The coordinator could not respond. Your conversation was saved; send a follow-up to continue.",
              created: Date.now(),
              status: "failed",
            });
          }
          db.prepare("UPDATE workbench_runs SET body=? WHERE id=?").run(
            JSON.stringify(run),
            run.id,
          );
        } else {
          run.messages!.push({
            id: randomUUID(),
            role: "assistant",
            text: plan.summary,
            created: Date.now(),
          });
          db.prepare("UPDATE workbench_runs SET body=? WHERE id=?").run(
            JSON.stringify(run),
            run.id,
          );
        }
        return c.json(run, 201);
      } catch {
        return c.json(
          {
            error:
              "Planning failed. Check coordinator configuration. No workers were launched.",
          },
          502,
        );
      } finally {
        busy.delete(lock);
      }
    }
    const input = z
      .object({
        id: z.string().uuid(),
        workerId: z.string().uuid().optional(),
        actionId: z.string().uuid().optional(),
        replyTo: z.string().max(200).optional(),
        text: z.string().trim().min(1).max(8000).optional(),
        operation: z.string().uuid().optional(),
        path: z.string().max(2000).optional(),
        snapshot: z.string().max(100).optional(),
        decision: z.enum(["approved", "changes_requested"]).optional(),
        agent: z.enum(["codex", "claude"]).optional(),
      })
      .safeParse(body);
    if (!input.success) return c.json({ error: "Invalid run request." }, 400);
    const row = db
      .prepare(
        "SELECT body FROM workbench_runs WHERE id=? AND instance=? AND team=? AND owner=?",
      )
      .get(input.data.id, ctx.instanceId, team, user);
    if (!row) return c.json({ error: "Run not found." }, 404);
    const run = JSON.parse(String(row.body)) as Run;
    run.messages ||= [
      {
        id: randomUUID(),
        role: "user",
        text: run.objective,
        created: run.created,
      },
      {
        id: randomUUID(),
        role: "assistant",
        text: run.summary,
        created: run.created,
      },
    ];
    if (run.taskId) await hydrateExecution(run);
    const binding = bindings.find((b) => b.id === run.binding);
    if (!binding)
      return c.json({ error: "Runtime binding has been removed." }, 403);
    if (busy.has(run.id))
      return c.json({ error: "This run has an operation in progress." }, 409);
    const save = () =>
      db
        .prepare("UPDATE workbench_runs SET body=? WHERE id=?")
        .run(JSON.stringify(run), run.id);
    busy.add(run.id);
    try {
      const worker = run.workers.find((w) => w.id === input.data.workerId);
      if (
        run.taskId &&
        worker &&
        ["send", "stop", "workspace", "file", "decision"].includes(action)
      ) {
        const linked = execution.load(
          { ctx, team, user, bindings },
          run.taskId,
        );
        if (linked?.workerId !== worker.id || linked.binding !== run.binding)
          return c.json(
            { error: "Select the worker linked to this task execution." },
            409,
          );
        await execution.get({ ctx, team, user, bindings }, run.taskId);
      }
      const event = (text: string) =>
        run.messages!.push({
          id: randomUUID(),
          role: "event",
          text,
          created: Date.now(),
        });
      if (action === "project-apply") {
        if (run.workers.some((w) => w.state !== "proposed"))
          return c.json(
            {
              error:
                "Start a new conversation to switch a project after dispatch.",
            },
            409,
          );
        const proposal = run.projectProposal;
        if (!proposal)
          return c.json({ error: "No project proposal pending." }, 409);
        let target: Binding | undefined;
        if (proposal.action === "select")
          target = bindings.find(
            (b) => b.id === proposal.binding && b.repo !== "managed",
          );
        else {
          const manager = configuredBindings.find(
            (b) =>
              b.manageProjects &&
              (binding.id === b.id || binding.id.startsWith(b.id + ":")),
          );
          if (!manager || !runner.createProject || !proposal.name)
            return c.json({ error: "Project creation unavailable." }, 403);
          const project = await runner.createProject(manager, proposal.name);
          target = {
            ...manager,
            id: `${manager.id}:${project.id}`,
            repo: `id:${project.id}`,
            label: project.name,
          };
        }
        if (!target) return c.json({ error: "Project not available." }, 403);
        run.binding = target.id;
        run.context =
          `Selected Orca project: ${target.label} (${target.repo}).\n` +
          run.context.replace(/^Selected Orca project:.*\n/, "");
        run.workers = [];
        run.projectProposal = undefined;
        event(
          `Project selected: ${target.label}. Send the task you want a worker to execute.`,
        );
        save();
        return c.json(run);
      }
      if (action === "message") {
        if (!input.data.text || !input.data.operation)
          return c.json({ error: "Message and operation ID required." }, 400);
        if (run.messages.some((m) => m.id === input.data.operation))
          return c.json(run);
        if (run.messages.length >= 200 || run.workers.length >= 16)
          return c.json(
            {
              error:
                "This conversation has reached its limit. Start a new session.",
            },
            409,
          );
        run.messages.push({
          id: input.data.operation,
          role: "user",
          text: input.data.text,
          created: Date.now(),
          status: "pending",
        });
        save();
        try {
          const answer = await coordinator.chat(
            run.messages,
            run.context + catalog,
            run.workers.map((w) => ({
              id: w.id,
              title: w.title,
              spec: w.spec,
              state: w.state,
              output: w.receipt?.output?.slice(-8000),
            })),
          );
          run.pendingActions ||= [];
          run.pendingActions.push(
            ...(answer.actions || [])
              .filter((a) =>
                run.workers.some(
                  (w) => w.id === a.workerId && w.state !== "proposed",
                ),
              )
              .map((a) => ({
                ...a,
                id: randomUUID(),
                status: "proposed" as const,
              })),
          );
          run.projectProposal = answer.project;
          run.messages[run.messages.length - 1]!.status = "sent";
          run.messages.push({
            id: randomUUID(),
            role: "assistant",
            text: answer.reply,
            created: Date.now(),
          });
          const available = 16 - run.workers.length;
          run.workers.push(
            ...answer.workers.slice(0, available).map((w) => ({
              ...w,
              id: randomUUID(),
              state: "proposed" as const,
            })),
          );
        } catch {
          run.messages[run.messages.length - 1]!.status = "failed";
          event(
            "The coordinator could not respond. Send a follow-up to try again.",
          );
        }
        save();
      } else if (action === "workspace" || action === "file") {
        if (!worker || worker.state === "proposed")
          return c.json({ error: "Select a dispatched worker." }, 404);
        if (action === "file") {
          if (!input.data.path)
            return c.json({ error: "File path required." }, 400);
          return c.json(await runner.file(binding, worker.id, input.data.path));
        }
        const view = run.taskId
          ? await execution.inspect({ ctx, team, user, bindings }, run.taskId)
          : await runner.workspace(binding, worker.id);
        if (worker.review) {
          worker.review.stale = worker.review.snapshot !== view.snapshot;
          save();
        }
        return c.json(view);
      } else if (action === "send" || action === "stop") {
        if (!worker || !input.data.operation)
          return c.json({ error: "Worker and operation ID required." }, 400);
        if (action === "send" && !input.data.text)
          return c.json({ error: "Enter a follow-up." }, 400);
        const pending = input.data.actionId
          ? run.pendingActions?.find((a) => a.id === input.data.actionId)
          : undefined;
        if (
          input.data.actionId &&
          (!pending ||
            pending.workerId !== worker.id ||
            pending.text !== input.data.text ||
            pending.status !== "proposed")
        )
          return c.json(
            { error: "Pending action changed or already submitted." },
            409,
          );
        if (pending) {
          pending.status = "unknown";
          save();
        }
        if (run.taskId) {
          const result =
            action === "send"
              ? await execution.send(
                  { ctx, team, user, bindings },
                  run.taskId,
                  input.data.text!,
                  input.data.operation,
                  input.data.replyTo,
                )
              : await execution.stop(
                  { ctx, team, user, bindings },
                  run.taskId,
                  input.data.operation,
                );
          worker.receipt = result.receipt!;
        } else {
          return c.json(
            {
              error:
                "Legacy sessions must be attached to an authorized board task before steering.",
            },
            409,
          );
        }
        worker.state = worker.receipt.state;
        if (pending)
          pending.status =
            worker.receipt.lastOperation?.status === "accepted"
              ? "submitted"
              : "unknown";
        if (worker.review) worker.review.stale = true;
        event(
          `${worker.title}: ${action === "send" ? "follow-up requested" : "stop requested"}. ${worker.receipt.notice || ""}`,
        );
        save();
      } else if (action === "decision") {
        if (!worker || !input.data.decision || !input.data.snapshot)
          return c.json(
            { error: "Worker, decision and current change snapshot required." },
            400,
          );
        const view = run.taskId
          ? await execution.inspect({ ctx, team, user, bindings }, run.taskId)
          : await runner.workspace(binding, worker.id);
        if (view.snapshot !== input.data.snapshot)
          return c.json(
            {
              error:
                "Changes have moved since you inspected them. Reload the diff before reviewing.",
            },
            409,
          );
        if (view.truncated && input.data.decision === "approved")
          return c.json(
            {
              error:
                "This diff is incomplete. Inspect it in Orca before approval.",
            },
            409,
          );
        worker.review = {
          decision: input.data.decision,
          comment: input.data.text || "",
          snapshot: view.snapshot,
          created: Date.now(),
          stale: false,
        };
        event(
          `${worker.title}: ${input.data.decision === "approved" ? "changes reviewed and approved (not merged)" : "changes requested"}. ${input.data.text || ""}`,
        );
        save();
      } else if (action === "dispatch") {
        if (binding.repo === "managed")
          return c.json({ error: "Choose or create a project first." }, 409);
        const worker = run.workers.find((w) => w.id === input.data.workerId);
        if (
          run.taskId &&
          worker &&
          ["send", "stop", "workspace", "file", "decision"].includes(action)
        ) {
          const linked = execution.load(
            { ctx, team, user, bindings },
            run.taskId,
          );
          if (linked?.workerId !== worker.id || linked.binding !== run.binding)
            return c.json(
              { error: "Select the worker linked to this task execution." },
              409,
            );
          await execution.get({ ctx, team, user, bindings }, run.taskId);
        }
        if (!worker) return c.json({ error: "Worker not found." }, 404);
        if (!run.taskId)
          return c.json(
            {
              error:
                "Attach an explicitly approved Task Board task before execution.",
            },
            409,
          );
        const approved = execution.load(
          { ctx, team, user, bindings },
          run.taskId,
        );
        if (
          !approved ||
          approved.spec !== worker.spec ||
          approved.agent !== worker.agent ||
          approved.binding !== run.binding
        )
          return c.json(
            {
              error:
                "Approve this exact worker proposal and project on the linked task before launching.",
            },
            409,
          );
        const result = await execution.dispatch(
          { ctx, team, user, bindings },
          run.taskId,
          worker.id,
        );
        worker.receipt = result.receipt;
        worker.state = result.receipt?.state || "unknown";
        event(
          `${worker.title}: ${worker.state === "running" ? "worker launched" : "launch needs inspection"}.`,
        );
        save();
      } else if (action === "refresh") {
        if (run.taskId && run.workers.some((w) => w.state !== "proposed")) {
          const result = await execution.sync(
            { ctx, team, user, bindings },
            run.taskId,
          );
          const linked = run.workers.find((w) => w.id === result.workerId);
          if (linked && result.receipt) {
            linked.receipt = result.receipt;
            linked.state = result.receipt.state;
          }
          save();
          return c.json(run);
        }
        await Promise.all(
          run.workers
            .filter((w) => w.state !== "proposed")
            .map(async (worker) => {
              try {
                worker.receipt = await runner.read(binding, worker.id);
                worker.state = worker.receipt.state;
              } catch {
                worker.state = "unknown";
              }
            }),
        );
        save();
      } else if (action === "review") {
        const reviewedWorkers = worker ? [worker] : run.workers;
        let output = reviewedWorkers
          .map(
            (w) =>
              `${w.title} [${w.state}]\n${w.receipt?.output || "No output available."}`,
          )
          .join("\n\n");
        for (const w of reviewedWorkers.filter((w) => w.state !== "proposed")) {
          try {
            const view = await runner.workspace(binding, w.id);
            output += `\nChanges for ${w.title} (${view.truncated ? "incomplete" : "current"}):\n${view.diff.slice(0, 12000)}`;
          } catch {
            output += `\nDiff unavailable for ${w.title}.`;
          }
        }
        run.review = await coordinator.review(run.objective, output);
        if (worker) worker.assessment = run.review;
        run.messages.push({
          id: randomUUID(),
          role: "assistant",
          text: run.review,
          created: Date.now(),
        });
        save();
      } else return c.json({ error: "Unknown action" }, 404);
      return c.json(run);
    } catch (e) {
      return c.json(
        {
          error:
            e instanceof ExecutionError
              ? e.message
              : "Operation failed. Refresh the run before retrying.",
        },
        e instanceof ExecutionError ? (e.status as 403 | 409 | 503) : 502,
      );
    } finally {
      busy.delete(run.id);
    }
  });
  return () => {
    clearInterval(poller);
    boardDb?.close();
    db.close();
  };
}
