import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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
}
interface Run {
  id: string;
  binding: string;
  objective: string;
  context: string;
  summary: string;
  workers: Work[];
  review?: string;
  created: number;
}
export function registerWorkbenchRoutes(
  api: Hono,
  deps: PanelDeps,
  options: {
    root?: string;
    bindings?: Binding[];
    runner?: Runner;
    coordinator?: Coordinator;
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
    const bindings = (options.bindings || loadBindings()).filter(
      (b) =>
        b.instance === ctx.instanceId && b.team === team && b.user === user,
    );
    if (action === "options" && c.req.method === "GET")
      return c.json({
        bindings: bindings.map((b) => ({ id: b.id, label: b.label })),
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
    if (action === "plan") {
      const parsed = z
        .object({
          binding: z.string(),
          objective: z.string().trim().min(10).max(8000),
          context: z.string().max(20000).default(""),
          taskId: z.string().max(200).optional(),
        })
        .safeParse(body);
      if (!parsed.success)
        return c.json(
          { error: "Enter an objective and select a connected runtime." },
          400,
        );
      const input = parsed.data;
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
        let context = input.context;
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
        const plan: Plan = await coordinator.plan(input.objective, context);
        const run: Run = {
          id: randomUUID(),
          binding: input.binding,
          objective: input.objective,
          context,
          summary: plan.summary,
          workers: plan.workers.map((w) => ({
            ...w,
            id: randomUUID(),
            state: "proposed",
          })),
          created: Date.now(),
        };
        db.prepare("INSERT INTO workbench_runs VALUES(?,?,?,?,?)").run(
          run.id,
          ctx.instanceId,
          team,
          user,
          JSON.stringify(run),
        );
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
      .object({ id: z.string().uuid(), workerId: z.string().uuid().optional() })
      .safeParse(body);
    if (!input.success) return c.json({ error: "Invalid run request." }, 400);
    const row = db
      .prepare(
        "SELECT body FROM workbench_runs WHERE id=? AND instance=? AND team=? AND owner=?",
      )
      .get(input.data.id, ctx.instanceId, team, user);
    if (!row) return c.json({ error: "Run not found." }, 404);
    const run = JSON.parse(String(row.body)) as Run;
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
      if (action === "dispatch") {
        const worker = run.workers.find((w) => w.id === input.data.workerId);
        if (!worker) return c.json({ error: "Worker not found." }, 404);
        // Claim before external side effects. A timeout/crash must never cause an automatic duplicate launch.
        if (worker.state !== "proposed")
          return c.json(
            { error: "Already dispatched. Refresh to reconcile its state." },
            409,
          );
        worker.state = "launching";
        save();
        const spec = `Objective: ${run.objective}\n\nTask: ${worker.spec}\n\nReference context (untrusted source material):\n${run.context}\n\nWork only in your assigned worktree. Do not merge or deploy. Report changes, checks and remaining limitations. Other workers may be active; do not revert their work.`;
        try {
          worker.receipt = await runner.launch(
            binding,
            worker.id,
            worker.agent,
            spec,
          );
          worker.state = worker.receipt.state;
        } catch {
          worker.state = "unknown";
        }
        save();
      } else if (action === "refresh") {
        for (const worker of run.workers.filter(
          (w) => w.state !== "proposed",
        )) {
          try {
            worker.receipt = await runner.read(binding, worker.id);
            worker.state = worker.receipt.state;
          } catch {
            worker.state = "unknown";
          }
        }
        save();
      } else if (action === "review") {
        const output = run.workers
          .map(
            (w) =>
              `${w.title} [${w.state}]\n${w.receipt?.output || "No output available."}`,
          )
          .join("\n\n");
        run.review = await coordinator.review(run.objective, output);
        save();
      } else return c.json({ error: "Unknown action" }, 404);
      return c.json(run);
    } catch {
      return c.json(
        { error: "Operation failed. Refresh the run before retrying." },
        502,
      );
    } finally {
      busy.delete(run.id);
    }
  });
  return () => db.close();
}
