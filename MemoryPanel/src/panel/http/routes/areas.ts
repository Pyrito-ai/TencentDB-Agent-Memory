import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PanelDeps } from "../../panel-deps.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { buildCtx, resolveCallerUserId } from "./knowledge/common.js";
export function registerAreas(api: Hono, deps: PanelDeps, db: DatabaseSync) {
  api.use("/areas/*", validatePanelMetaHeaders(deps));
  api.use("/areas/*", bodyLimit({ maxSize: 8192 }));
  api.all("/areas/:team/:action", async (c) => {
    const ctx = buildCtx(c),
      instance = ctx.instanceId,
      team = c.req.param("team"),
      action = c.req.param("action");
    const actor = await resolveCallerUserId(deps, ctx);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const e = await deps.metaKernel.invoke(
      "team-member/get",
      { team_id: team, user_id: actor },
      ctx,
    );
    const m =
      e.code === 0 ? (e.data as { status: string; role: string }) : null;
    if (m?.status !== "active") return c.json({ error: "Forbidden" }, 403);
    const te = await deps.metaKernel.invoke("team/get", { team_id: team }, ctx);
    const admin =
      m.role === "admin" ||
      (te.code === 0 &&
        (te.data as { owner_user_id: string })?.owner_user_id === actor);
    c.header("Cache-Control", "private, no-store");
    if (c.req.method === "GET" && action === "list")
      return c.json({
        items: db
          .prepare(
            "SELECT * FROM areas WHERE instance=? AND team=? ORDER BY archived,name",
          )
          .all(instance, team)
          .map((a) => ({ ...a, canManage: admin || a.created_by === actor })),
      });
    if (c.req.method !== "POST")
      return c.json({ error: "Method not allowed" }, 405);
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== "object")
      return c.json({ error: "Invalid request" }, 400);
    const a =
      typeof b.id === "string"
        ? db
            .prepare("SELECT * FROM areas WHERE id=? AND instance=? AND team=?")
            .get(b.id, instance, team)
        : null;
    if (action !== "create" && (!a || (!admin && a.created_by !== actor)))
      return c.json({ error: "Forbidden" }, 403);
    if (action === "archive") {
      if (typeof b.archived !== "boolean")
        return c.json({ error: "Invalid state" }, 400);
      if (
        b.archived &&
        db
          .prepare("SELECT 1 FROM loops WHERE area_id=? AND archived=0")
          .get(b.id)
      )
        return c.json(
          {
            error: "Move or archive active loops before archiving their Area.",
          },
          409,
        );
      db.prepare("UPDATE areas SET archived=? WHERE id=?").run(
        b.archived ? 1 : 0,
        b.id,
      );
      return c.json({ ok: true });
    }
    if (!["create", "update"].includes(action))
      return c.json({ error: "Unknown action" }, 404);
    const name = typeof b.name === "string" ? b.name.trim() : "",
      description =
        typeof b.description === "string" ? b.description.trim() : "";
    if (!name || name.length > 120 || description.length > 4000)
      return c.json(
        {
          error:
            "Enter an Area name (up to 120 characters) and description (up to 4,000).",
        },
        400,
      );
    const id = action === "create" ? randomUUID() : b.id;
    try {
      if (action === "create")
        db.prepare(
          "INSERT INTO areas(id,instance,team,name,description,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(id, instance, team, name, description, actor, Date.now());
      else
        db.prepare("UPDATE areas SET name=?,description=? WHERE id=?").run(
          name,
          description,
          id,
        );
    } catch (e) {
      if (String(e).includes("UNIQUE constraint"))
        return c.json({ error: "An Area with that name already exists." }, 409);
      throw e;
    }
    return c.json({ id }, action === "create" ? 201 : 200);
  });
}
