/** Local-only Coordinator notes and synthetic mail. No external API requests. */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { OpsStore } from "../src/panel/ops/store.js";
import { OpsService } from "../src/panel/ops/service.js";
import { registerOpsRoutes } from "../src/panel/http/routes/ops.js";
import {
  registerCoordinatorRoutes,
  OPS_NOTE_CONTEXT_PREFIX,
  OPS_NOTE_REFERENCE_PREFIX,
} from "../src/panel/http/routes/coordinator.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";
import type { MailProvider, Owner, Thread } from "../src/panel/ops/types.js";

process.env.PYRITO_PUBLIC_URL = "http://127.0.0.1:5195";
const root = path.resolve(".ops-preview");
mkdirSync(root, { recursive: true, mode: 0o700 });
const runRoot = mkdtempSync(path.join(root, "run-"));
const store = new OpsStore(runRoot, randomBytes(32).toString("hex"));
const accounts = new Map<string, { user: string; active: boolean }>();
const threads: Thread[] = [
  {
    id: "launch-brief",
    fingerprint: "v1",
    subject: "A quick decision on the launch brief",
    from: "Jamie Chen <jamie@example.com>",
    replyTo: "jamie@example.com",
    date: "Today, 9:20 AM",
    messageId: "<launch@example.com>",
    references: "",
    text: "Hi Alex,\n\nThe revised launch brief is ready. Could you look at the opening paragraph and let me know which of the two directions feels right?\n\nThanks,\nJamie",
  },
  {
    id: "workshop",
    fingerprint: "v1",
    subject: "Workshop: who should join?",
    from: "Taylor Reed <taylor@example.com>",
    replyTo: "taylor@example.com",
    date: "Today, 8:45 AM",
    messageId: "<workshop@example.com>",
    references: "",
    text: "Hi Alex,\n\nCould you suggest two people from your team for the discovery workshop? We can settle a date after we have the attendees.\n\nTaylor",
  },
];
const provider: MailProvider = {
  async connect(user) {
    const accountId = randomUUID();
    accounts.set(accountId, { user, active: false });
    return {
      accountId,
      url: `http://127.0.0.1:5195/api/v1/fixture/authorize/${accountId}`,
    };
  },
  async complete(user, sessionUri) {
    const account = accounts.get(sessionUri);
    if (!account || account.user !== user || !account.active)
      throw Error("Invalid synthetic authorization");
    return { accountId: sessionUri, toolkit: "gmail" };
  },
  async account(id) {
    const account = accounts.get(id);
    if (!account) throw Error("Unknown fixture account");
    return {
      user: account.user,
      toolkit: "gmail",
      status: account.active ? "ACTIVE" : "INITIATED",
      private: true,
    };
  },
  async profile() {
    return "alex@example.com";
  },
  async search() {
    return { ids: threads.map((t) => t.id) };
  },
  async thread(_id, threadId) {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw Error("No fixture thread");
    return thread;
  },
  async send() {
    return "synthetic-receipt-" + randomUUID();
  },
  async revoke(id) {
    accounts.delete(id);
  },
};
const deps = {
  config: { auth: { sessionCookieName: "fixture" } },
  auth: { resolveSession: () => null },
  instanceRegistry: {
    resolve(id: string) {
      if (id !== "baren-preview") throw Error("Fixture instance only");
      return { instance_id: id, gateway_endpoint: "", api_key: "" };
    },
  },
  metaKernel: {
    async invoke(action: string, body: any) {
      const users: Record<string, string> = {
        "synthetic-preview-not-a-secret": "baren-preview-user",
        "synthetic-empty-user": "empty-user",
      };
      return {
        code: 0,
        data:
          action === "auth/verify"
            ? {
                valid: !!users[body.user_key],
                user: { user_id: users[body.user_key] },
              }
            : action === "team-member/get"
              ? {
                  status:
                    body.team_id === "baren-preview-team" &&
                    Object.values(users).includes(body.user_id)
                      ? "active"
                      : "removed",
                }
              : null,
      };
    },
  },
} as unknown as PanelDeps;
const service = new OpsService(
  store,
  provider,
  deps,
  "http://127.0.0.1:5195/#/ops",
  async (_instruction, thread) => ({
    relevant: true,
    markdown:
      thread.id === "launch-brief"
        ? "## Choose a direction for the launch brief\n\nJamie needs your preference on the opening paragraph before the team can finish the brief.\n\n**Next step:** review the two options and choose one.\n\n[Read Jamie’s message](https://mail.google.com/mail/u/?authuser=alex%40example.com#all/launch-brief)"
        : "## Pick two workshop attendees\n\nTaylor is waiting for two names before arranging the discovery workshop.\n\nConsider one person close to the customer and one who owns delivery.\n\n[Read Taylor’s message](https://mail.google.com/mail/u/?authuser=alex%40example.com#all/workshop)",
  }),
);
const owner: Owner = {
  instance: "baren-preview",
  team: "baren-preview-team",
  user: "baren-preview-user",
};
const key = "synthetic-preview-not-a-secret";
const connected = (await service.perform(owner, key, "connect", {})) as {
  id: string;
};
for (const value of accounts.values()) value.active = true;
await service.perform(owner, key, "complete", {
  sessionUri: [...accounts.keys()][0],
});
await service.perform(owner, key, "refresh", { id: connected.id });
await service.perform(owner, key, "routine-save", {
  connectionId: connected.id,
  name: "Decisions and replies",
  query: "in:inbox newer_than:7d",
  instruction: "Find emails that need a reply or a decision from me.",
  intervalMinutes: 60,
  enabled: false,
});
for (const thread of threads)
  await service.perform(owner, key, "prepare", {
    connectionId: connected.id,
    threadId: thread.id,
    instruction: "Find decisions.",
  });
await service.perform(owner, key, "note-save", {
  markdown:
    "## Before sharing the new workspace\n\n- [x] Review the task board\n- [ ] Check the empty states\n- [ ] Try the flow on a narrow screen\n\nKeep the first walkthrough focused on **creating a task and finding its context**.\n\n[Open the task board](/#/)",
});
await service.perform(owner, key, "note-save", {
  markdown:
    "## A decision to keep\n\n> Keep the weekly update short enough to read in two minutes.\n\nLead with what changed, what needs a decision, and the next step. Put supporting detail in the linked project notes.",
});
const api = new Hono();
registerOpsRoutes(api, deps, service);
const closeCoordinator = registerCoordinatorRoutes(api, deps, {
  root: runRoot,
  async model(messages) {
    const history = messages as { role: string; content: string }[];
    const contextIndex = history.findLastIndex(
      (m) => m.role === "user" && m.content.startsWith(OPS_NOTE_CONTEXT_PREFIX),
    );
    const directionIndex = history.findLastIndex(
      (m) =>
        m.role === "user" &&
        ![
          OPS_NOTE_CONTEXT_PREFIX,
          OPS_NOTE_REFERENCE_PREFIX,
          "Untrusted tool result: ",
        ].some((prefix) => m.content.startsWith(prefix)),
    );
    const direction = history[directionIndex]?.content.trim() || "";
    let note: { id: string; revision: number; markdown: string };
    if (contextIndex >= 0) {
      note = JSON.parse(
        history[contextIndex]!.content.slice(OPS_NOTE_CONTEXT_PREFIX.length),
      );
    } else {
      const reference = history.findLast(
        (m) =>
          m.role === "user" && m.content.startsWith(OPS_NOTE_REFERENCE_PREFIX),
      );
      if (!reference)
        return {
          reply:
            "Select an Ops note and tell me what you want to discuss or change.",
        };
      const identity = JSON.parse(
        reference.content.slice(OPS_NOTE_REFERENCE_PREFIX.length),
      ) as { id: string };
      const tool = history
        .slice(directionIndex + 1)
        .findLast((m) => m.content.startsWith("Untrusted tool result: "));
      if (!tool)
        return {
          reply: "I’ll read the current note before following up.",
          action: { name: "ops/list", args: {} },
        };
      const result = JSON.parse(
        tool.content.slice("Untrusted tool result: ".length),
      );
      const current =
        result.action === "ops/list" && result.ok
          ? result.data.notes.find(
              (item: { id: string; trashed: boolean }) =>
                item.id === identity.id && !item.trashed,
            )
          : undefined;
      if (!current)
        return {
          reply:
            "That note is unavailable or dismissed. Select an active note to continue.",
        };
      note = current;
    }
    const title = (
      note.markdown.split(/\r?\n/).find((line) => line.trim()) || "this note"
    )
      .replace(/^#+\s*/, "")
      .slice(0, 100);
    const replace = /^Update the note:\s*([\s\S]+)$/i.exec(direction);
    const append = /^Add to the note:\s*([\s\S]+)$/i.exec(direction);
    const shorten = /^(?:make it shorter|shorten the note)[.!]?$/i.test(
      direction,
    );
    if (replace || append || shorten) {
      const firstPoint =
        note.markdown
          .split(/\r?\n/)
          .find((line) => line.trim() && !line.startsWith("#")) || title;
      const markdown = replace
        ? replace[1]!.trim()
        : append
          ? `${note.markdown}\n\n${append[1]!.trim()}`
          : `## ${title}\n\n${firstPoint.slice(0, 140)}`;
      return {
        reply: `I propose updating “${title}” with your direction. Review the change before applying it.`,
        action: {
          name: "ops/note-save",
          args: { id: note.id, revision: note.revision, markdown },
        },
      };
    }
    const summary =
      note.markdown
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#")) || title;
    return {
      reply: `For “${title}”, ${summary.slice(0, 240)}\n\nYour direction: “${direction.slice(0, 180)}”. We can refine the next step here. To propose a saved change, say “Add to the note: …” or “Update the note: …”.`,
    };
  },
});
api.get("/fixture/authorize/:id", (c) => {
  const account = accounts.get(c.req.param("id"));
  if (!account) return c.text("Unknown synthetic authorization.", 404);
  account.active = true;
  return c.redirect(
    "/#/ops?" + new URLSearchParams({ oauth_session: c.req.param("id") }),
    303,
  );
});
const app = new Hono();
app.route("/api/v1", api);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8195 });
service.start();
console.log(
  "Synthetic Ops API listening at http://127.0.0.1:8195 (no real mail).",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    service.stop();
    closeCoordinator();
    server.close();
    process.exit(0);
  });
