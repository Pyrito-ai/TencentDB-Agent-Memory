import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { PanelDeps } from "../../panel-deps.js";
import { OpsError } from "../../ops/types.js";
import { opsOwner, type OpsService } from "../../ops/service.js";
import { buildCtx } from "./knowledge/common.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";

export function registerOpsRoutes(
  api: Hono,
  deps: PanelDeps,
  service?: OpsService,
) {
  // The public verifier landing performs no mutation. The authenticated app redeems
  // the one-use URI through POST /ops/:team/complete with its real signed-in identity.
  api.get("/ops-oauth/callback", (c) => {
    const uri = c.req.query("session_uri");
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (!uri || uri.length > 4096)
      return c.text("Invalid or expired authorization return.", 400);
    return c.redirect(
      "/#/ops?" + new URLSearchParams({ oauth_session: uri }),
      303,
    );
  });
  api.use("/ops/*", validatePanelMetaHeaders(deps));
  api.use("/ops/*", bodyLimit({ maxSize: 50000 }));
  api.all("/ops/:team/:operation", async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    try {
      const ctx = buildCtx(c),
        owner = await opsOwner(deps, ctx, c.req.param("team"));
      c.set("resolvedUserId", owner.user);
      const operation = c.req.param("operation");
      if (
        c.req.method !== "POST" &&
        !(c.req.method === "GET" && operation === "list")
      )
        return c.json({ error: "Method not allowed." }, 405);
      if (c.req.method === "POST") {
        if (
          !/^application\/json(?:;|$)/i.test(c.req.header("Content-Type") || "")
        )
          throw new OpsError(400, "JSON requests are required.");
        const origin = c.req.header("Origin");
        if (
          origin &&
          origin !== new URL(process.env.PYRITO_PUBLIC_URL || c.req.url).origin
        )
          throw new OpsError(
            403,
            "Cross-origin Ops operations are not allowed.",
          );
      }
      const body =
        c.req.method === "GET"
          ? c.req.query()
          : await c.req.json().catch(() => {
              throw new OpsError(400, "Invalid JSON.");
            });
      if (!service) {
        if (operation === "list") {
          z.object({}).strict().parse(body);
          return c.json({
            boardReady: false,
            configured: false,
            draftReady: false,
            busy: false,
            connections: [],
            routines: [],
            notes: [],
          });
        }
        throw new OpsError(
          503,
          "Private Ops storage has not been configured on this server.",
        );
      }
      return c.json(
        await service.perform(owner, ctx.userKey || "", operation, body),
      );
    } catch (error) {
      if (error instanceof OpsError)
        return c.json({ error: error.message }, error.status);
      if (error instanceof z.ZodError)
        return c.json(
          { error: "Invalid fields. Check the input and refresh stale items." },
          400,
        );
      // Provider responses and credentials must not enter logs or client-visible error messages.
      return c.json(
        {
          error:
            "Private Ops is temporarily unavailable. No automatic retry was made.",
        },
        502,
      );
    }
  });
}
