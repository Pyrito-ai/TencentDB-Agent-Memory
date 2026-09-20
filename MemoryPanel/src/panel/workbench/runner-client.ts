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
});
export type Binding = z.infer<typeof bindingSchema>;
export function loadBindings(): Binding[] {
  const file = process.env.WORKBENCH_BINDINGS_FILE;
  if (!file) return [];
  const bindings = z
    .array(bindingSchema)
    .parse(JSON.parse(readFileSync(file, "utf8")));
  for (const b of bindings) {
    const u = new URL(b.url);
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
      throw Error("Workbench runners require HTTPS or loopback HTTP.");
  }
  if (new Set(bindings.map((b) => b.id)).size !== bindings.length)
    throw Error("Duplicate Workbench binding IDs.");
  return bindings;
}
export interface Receipt {
  id: string;
  state: "launching" | "running" | "exited" | "unknown";
  worktree?: string;
  terminal?: string;
  output?: string;
  notice?: string;
}
export interface Runner {
  launch(
    binding: Binding,
    id: string,
    agent: "codex" | "claude",
    spec: string,
  ): Promise<Receipt>;
  read(binding: Binding, id: string): Promise<Receipt>;
}
export function createRunner(): Runner {
  async function request(
    b: Binding,
    path: string,
    body?: unknown,
  ): Promise<Receipt> {
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
    const data = await r.json();
    return z
      .object({
        id: z.string(),
        state: z.enum(["launching", "running", "exited", "unknown"]),
        worktree: z.string().optional(),
        terminal: z.string().optional(),
        output: z.string().max(100000).optional(),
        notice: z.string().optional(),
      })
      .parse(data);
  }
  return {
    launch: (b, id, agent, spec) =>
      request(b, "/jobs", { id, repo: b.repo, agent, spec }),
    read: (b, id) => request(b, `/jobs/${encodeURIComponent(id)}`),
  };
}
