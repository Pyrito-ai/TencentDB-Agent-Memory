import { request as httpRequest } from "node:http";
import type { WorkspaceSnapshot, FileContent } from "./types.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
const bindingSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  instance: z.string(),
  team: z.string(),
  user: z.string(),
  repo: z.string().min(1),
  url: z.string().url(),
  token: z.string().min(32),
  socketPath: z.string().startsWith("/").optional(),
  webUrl: z.string().url().optional(),
  manageProjects: z.boolean().optional(),
});
export type Binding = z.infer<typeof bindingSchema>;
export function loadBindings(
  file = process.env.WORKBENCH_BINDINGS_FILE,
): Binding[] {
  if (!file) return [];
  const bindings = z
    .array(bindingSchema)
    .parse(JSON.parse(readFileSync(file, "utf8")));
  for (const b of bindings) {
    for (const address of [b.url, ...(b.webUrl ? [b.webUrl] : [])]) {
      const u = new URL(address);
      if (
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !(
          u.protocol === "https:" ||
          (u.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
        )
      )
        throw Error(
          "Workbench endpoints require HTTPS or loopback HTTP without credentials, query strings, or fragments.",
        );
    }
  }
  if (new Set(bindings.map((b) => b.id)).size !== bindings.length)
    throw Error("Duplicate Workbench binding IDs.");
  return bindings;
}
export interface Receipt {
  id: string;
  state: "launching" | "running" | "exited" | "unknown";
  sessionId?: string;
  workspaceId?: string;
  webUrl?: string;
  executionProcessId?: string;
  processStatus?: string;
  stage?: string;
  worktree?: string;
  terminal?: string;
  output?: string;
  notice?: string;
  lastOperation?: {
    id: string;
    action: "send" | "stop" | "continue";
    status: "accepted" | "refused" | "unknown";
  };
  attempts?: {
    native?: Record<string, unknown>;
    worktree?: string;
    lifecycle?: string;
  }[];
  native?: {
    runId?: string;
    taskId?: string;
    dispatchId?: string;
    runtimeId?: string;
    launchState?: string;
    failedStage?: string;
  };
  lifecycle?:
    | "starting"
    | "working"
    | "needs_input"
    | "review"
    | "failed"
    | "stopped"
    | "unknown";
  events?: {
    id: string;
    type: string;
    subject: string;
    body: string;
    payload?: unknown;
    runId?: string;
    taskId?: string;
    dispatchId?: string;
    questionState?: "pending" | "answered";
  }[];
}
export interface Runner {
  projects?(
    binding: Binding,
  ): Promise<{ items: { id: string; name: string }[] }>;
  createProject?(
    binding: Binding,
    name: string,
  ): Promise<{ id: string; name: string }>;
  launch(
    binding: Binding,
    id: string,
    agent: "codex" | "claude",
    spec: string,
  ): Promise<Receipt>;
  launchDirect?(
    binding: Binding,
    id: string,
    agent: "codex" | "claude",
    spec: string,
  ): Promise<Receipt>;
  read(binding: Binding, id: string): Promise<Receipt>;
  workspace(binding: Binding, id: string): Promise<WorkspaceSnapshot>;
  file(binding: Binding, id: string, path: string): Promise<FileContent>;
  send(
    binding: Binding,
    id: string,
    text: string,
    operation: string,
    replyTo?: string,
  ): Promise<Receipt>;
  continue?(
    binding: Binding,
    id: string,
    spec: string,
    operation: string,
  ): Promise<Receipt>;
  stop(binding: Binding, id: string, operation: string): Promise<Receipt>;
}
export function createRunner(): Runner {
  async function request(
    b: Binding,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (b.socketPath) {
      return new Promise((resolve, reject) => {
        const r = httpRequest(
          {
            socketPath: b.socketPath,
            path,
            method: body ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${b.token}`,
              "Content-Type": "application/json",
            },
          },
          (response) => {
            let data = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              data += chunk;
              if (data.length > 2000000)
                r.destroy(Error("Runner response too large"));
            });
            response.on("error", reject);
            response.on("end", () => {
              if (
                !response.statusCode ||
                response.statusCode < 200 ||
                response.statusCode >= 300
              )
                return reject(Error("Runner unavailable or request rejected."));
              try {
                resolve(JSON.parse(data));
              } catch {
                reject(Error("Invalid runner response."));
              }
            });
          },
        );
        r.setTimeout(110000, () => r.destroy(Error("Runner timed out")));
        r.on("error", reject);
        r.end(body ? JSON.stringify(body) : undefined);
      });
    }
    const r = await fetch(b.url.replace(/\/$/, "") + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(110000),
      headers: {
        Authorization: `Bearer ${b.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok)
      throw Error(
        "Runner unavailable or request rejected. Refresh before attempting any further dispatch.",
      );
    return r.json();
  }
  const receipt = (data: unknown) =>
    z
      .object({
        id: z.string(),
        state: z.enum(["launching", "running", "exited", "unknown"]),
        sessionId: z.string().uuid().optional(),
        workspaceId: z.string().uuid().optional(),
        webUrl: z.string().url().optional(),
        executionProcessId: z.string().uuid().optional(),
        processStatus: z.string().max(50).optional(),
        stage: z.string().max(80).optional(),
        worktree: z.string().optional(),
        terminal: z.string().optional(),
        output: z.string().max(100000).optional(),
        notice: z.string().optional(),
        lastOperation: z
          .object({
            id: z.string(),
            action: z.enum(["send", "stop", "continue"]),
            status: z.enum(["accepted", "refused", "unknown"]),
          })
          .optional(),
        attempts: z
          .array(
            z.object({
              native: z.record(z.unknown()).optional(),
              worktree: z.string().optional(),
              lifecycle: z.string().optional(),
            }),
          )
          .optional(),
        native: z
          .object({
            runId: z.string().optional(),
            taskId: z.string().optional(),
            dispatchId: z.string().optional(),
            runtimeId: z.string().optional(),
            launchState: z.string().optional(),
            failedStage: z.string().optional(),
          })
          .optional(),
        lifecycle: z
          .enum([
            "starting",
            "working",
            "needs_input",
            "review",
            "failed",
            "stopped",
            "unknown",
          ])
          .optional(),
        events: z
          .array(
            z.object({
              id: z.string(),
              type: z.string(),
              subject: z.string(),
              body: z.string(),
              payload: z.unknown(),
              runId: z.string().optional(),
              taskId: z.string().optional(),
              dispatchId: z.string().optional(),
              questionState: z.enum(["pending", "answered"]).optional(),
            }),
          )
          .optional(),
      })
      .parse(data);

  return {
    projects: (b) =>
      request(b, "/projects").then((data) =>
        z
          .object({
            items: z.array(z.object({ id: z.string(), name: z.string() })),
          })
          .parse(data),
      ),
    createProject: (b, name) =>
      request(b, "/projects", { name }).then((data) =>
        z.object({ id: z.string(), name: z.string() }).parse(data),
      ),
    launchDirect: (b, id, agent, spec) =>
      request(b, "/jobs", {
        id,
        repo: b.repo,
        agent,
        spec,
        mode: "direct",
      }).then(receipt),
    launch: (b, id, agent, spec) =>
      request(b, "/jobs", { id, repo: b.repo, agent, spec }).then(receipt),
    read: (b, id) =>
      request(b, `/jobs/${encodeURIComponent(id)}`).then(receipt),
    workspace: (b, id) =>
      request(b, `/jobs/${id}/workspace`).then((data) =>
        z
          .object({
            files: z
              .array(z.object({ path: z.string(), status: z.string() }))
              .max(1000),
            branch: z.string(),
            base: z.string(),
            diff: z.string().max(300000),
            snapshot: z.string(),
            truncated: z.boolean(),
            notice: z.string().optional(),
          })
          .parse(data),
      ),
    file: (b, id, path) =>
      request(b, `/jobs/${id}/file`, { path }).then((data) =>
        z
          .object({ path: z.string(), content: z.string().max(300000) })
          .parse(data),
      ),
    send: (b, id, text, operation, replyTo) =>
      request(b, `/jobs/${id}/send`, { text, operation, replyTo }).then(
        receipt,
      ),
    continue: (b, id, spec, operation) =>
      request(b, `/jobs/${id}/continue`, { spec, operation }).then(receipt),
    stop: (b, id, operation) =>
      request(b, `/jobs/${id}/stop`, { operation }).then(receipt),
  };
}
