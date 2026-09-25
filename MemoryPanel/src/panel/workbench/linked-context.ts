import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PanelDeps } from "../panel-deps.js";
import type { BoardLookup, ExecutionScope } from "./execution.js";
import {
  collectWorkbenchContext,
  type WikiContextReference,
} from "./context.js";
import { z } from "zod";

const reference = z.object({
  kind: z.literal("wiki_page"),
  wikiId: z.string().min(1).max(512),
  ref: z.string().min(1).max(512),
});
const target = z.object({
  kind: z.enum(["task", "project"]),
  id: z.string().min(1).max(200),
});
export class ContextError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function createLinkedContext(
  db: DatabaseSync,
  deps: PanelDeps,
  lookup: BoardLookup,
) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS workbench_context_links(instance TEXT,team TEXT,kind TEXT,target TEXT,revision INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL,PRIMARY KEY(instance,team,kind,target))`,
  );
  const saved = (s: ExecutionScope, kind: string, id: string) => {
    const r = db
      .prepare(
        "SELECT revision,body FROM workbench_context_links WHERE instance=? AND team=? AND kind=? AND target=?",
      )
      .get(s.ctx.instanceId, s.team, kind, id);
    return {
      revision: r ? Number(r.revision) : 0,
      references: r
        ? (JSON.parse(String(r.body)) as WikiContextReference[])
        : [],
    };
  };
  async function entity(s: ExecutionScope, kind: string, id: string) {
    if (kind === "project") {
      const p = await lookup.byId(s, id);
      if (!p) throw new ContextError("Project unavailable or archived.", 404);
      const m = await deps.metaKernel.invoke(
        "team-member/get",
        { team_id: s.team, user_id: s.user },
        s.ctx,
      );
      const t = await deps.metaKernel.invoke(
        "team/get",
        { team_id: s.team },
        s.ctx,
      );
      return {
        project: p,
        canEdit:
          p.created_by === s.user ||
          p.canManage === true ||
          (m.data as any)?.role === "admin" ||
          (t.data as any)?.owner_user_id === s.user,
      };
    }
    const e = await deps.metaKernel.invoke("task/get", { task_id: id }, s.ctx);
    const task = e.data as any;
    if (e.code !== 0 || !task || task.team_id !== s.team)
      throw new ContextError("Task unavailable in this team.", 404);
    // Task context contains potentially private links; match direct handoff's creator boundary.
    if (task.creator_user_id !== s.user)
      throw new ContextError(
        "Only the task creator can manage handoff context.",
        403,
      );
    const project = await lookup.project(s, id);
    if (project?.archived)
      throw new ContextError(
        "The assigned project is archived. Restore it or change the task project before sending.",
        409,
      );
    return { project, canEdit: true };
  }
  async function collect(
    s: ExecutionScope,
    refs: WikiContextReference[],
    taskId?: string,
  ) {
    try {
      return await collectWorkbenchContext(deps, s.ctx, {
        teamId: s.team,
        userId: s.user,
        taskId,
        references: refs,
      });
    } catch {
      throw new ContextError(
        "A linked Wiki page is missing or inaccessible. Update the links before sending to Orca.",
        409,
      );
    }
  }
  async function view(s: ExecutionScope, kind: string, id: string) {
    const e = await entity(s, kind, id);
    const own = saved(s, kind, id);
    return {
      ...own,
      canEdit: e.canEdit,
      project: e.project
        ? {
            id: e.project.id,
            name: e.project.name,
            description: e.project.description,
          }
        : null,
      inherited:
        kind === "task" && e.project
          ? saved(s, "project", e.project.id).references
          : [],
    };
  }
  async function assemble(
    s: ExecutionScope,
    id: string,
    kind: "task" | "project" = "task",
  ) {
    const v = await view(s, kind, id);
    const refs = [
      ...new Map(
        [...v.inherited, ...v.references].map((r) => [
          JSON.stringify([r.wikiId, r.ref]),
          r,
        ]),
      ).values(),
    ];
    if (refs.length > 8)
      throw new ContextError(
        "Link at most eight distinct Wiki pages across the task and its project.",
        409,
      );
    const sources = refs.length
      ? await collect(s, refs, kind === "task" ? id : undefined)
      : { excerpts: [], text: "" };
    // Never silently omit a selected page when the collector's total cap is exhausted.
    if (sources.excerpts.length !== refs.length)
      throw new ContextError(
        "Selected pages exceed the context limit. Link fewer pages before sending.",
        409,
      );
    const text = [
      v.project
        ? "Tencent project context (reference material):\n" +
          JSON.stringify(v.project)
        : "",
      sources.text,
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      project: v.project,
      references: refs,
      excerpts: sources.excerpts,
      text,
      hash: createHash("sha256").update(text).digest("hex"),
    };
  }
  async function handle(s: ExecutionScope, action: string, input: unknown) {
    if (action === "context-catalog") {
      const e = await deps.metaKernel.invoke(
        "asset/list-accessible",
        {
          user_id: s.user,
          team_id: s.team,
          asset_type: "llm_wiki",
          action: "read",
          limit: 100,
          offset: 0,
        },
        s.ctx,
      );
      if (e.code !== 0) throw new ContextError("Wiki list unavailable.", 503);
      return {
        items: ((e.data as any)?.items || [])
          .filter(
            (a: any) => a.team_id === s.team && a.asset_type === "llm_wiki",
          )
          .map((a: any) => ({ id: a.asset_id, name: a.name || a.asset_id })),
      };
    }
    if (action === "context-pages") {
      const { wikiId } = z
        .object({ wikiId: z.string().min(1).max(512) })
        .parse(input);
      const a = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: wikiId },
        s.ctx,
      );
      const asset = a.data as any;
      const acl = await deps.metaKernel.invoke(
        "acl/check",
        { user_id: s.user, asset_id: wikiId, action: "read" },
        s.ctx,
      );
      if (
        a.code !== 0 ||
        asset?.team_id !== s.team ||
        asset?.asset_type !== "llm_wiki" ||
        acl.code !== 0 ||
        (acl.data as any)?.allowed !== true
      )
        throw new ContextError("Wiki unavailable.", 403);
      const client = deps.knowledgeClientFactory(s.ctx.instanceId);
      const wiki = await client.wikiGet(wikiId);
      if (wiki.team_id !== s.team || wiki.wiki_id !== wikiId)
        throw new ContextError("Wiki unavailable.", 403);
      return client.wikiPageLs(wikiId);
    }
    const t = target.parse(input);
    if (action === "context-get") return view(s, t.kind, t.id);
    if (action === "context-preview") return assemble(s, t.id, t.kind);
    if (action === "context-save") {
      const b = target
        .extend({
          revision: z.number().int().nonnegative(),
          references: z.array(reference).max(8),
        })
        .parse(input);
      const e = await entity(s, b.kind, b.id);
      if (!e.canEdit)
        throw new ContextError(
          "Only the project owner or team admin can change these links.",
          403,
        );
      if (b.references.length)
        await collect(s, b.references, b.kind === "task" ? b.id : undefined);
      const refs = [
        ...new Map(
          b.references.map((r) => [JSON.stringify([r.wikiId, r.ref]), r]),
        ).values(),
      ];
      db.exec("BEGIN IMMEDIATE");
      try {
        if (saved(s, b.kind, b.id).revision !== b.revision)
          throw new ContextError(
            "Links changed elsewhere. Reload before saving.",
            409,
          );
        db.prepare(
          "INSERT INTO workbench_context_links VALUES(?,?,?,?,?,?) ON CONFLICT(instance,team,kind,target) DO UPDATE SET revision=excluded.revision,body=excluded.body",
        ).run(
          s.ctx.instanceId,
          s.team,
          b.kind,
          b.id,
          b.revision + 1,
          JSON.stringify(refs),
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return view(s, b.kind, b.id);
    }
    throw new ContextError("Unknown context action.", 404);
  }
  return { handle, assemble, authorize: collect };
}
