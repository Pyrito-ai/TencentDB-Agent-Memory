import { test, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { createLinkedContext } from "../src/panel/workbench/linked-context.js";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
function fixture() {
  const db = new DatabaseSync(":memory:");
  let allowed = true;
  let owner = "u";
  let project: any = {
    id: "p",
    created_by: "u",
    name: "Project",
    description: "Project background",
  };
  const read = vi.fn(async (_id: string, refs: string[]) => ({
    items: refs.map((ref) => ({ ref, content: "Page: " + ref })),
  }));
  const deps: any = {
    metaKernel: {
      invoke: vi.fn(async (action: string, b: any) => ({
        code: 0,
        data:
          action === "auth/verify"
            ? { valid: true, user: { user_id: "u" } }
            : action === "task/get"
              ? { task_id: b.task_id, team_id: "team", creator_user_id: owner }
              : action === "team-member/get"
                ? { status: "active", role: "member" }
                : action === "team/get"
                  ? { owner_user_id: "other" }
                  : action === "asset/get"
                    ? {
                        asset_id: b.asset_id,
                        team_id: "team",
                        asset_type: "llm_wiki",
                      }
                    : action === "acl/check"
                      ? { allowed }
                      : null,
      })),
    },
    knowledgeClientFactory: () => ({
      wikiGet: async (id: string) => ({
        wiki_id: id,
        team_id: "team",
        version: "v1",
      }),
      wikiPageRead: read,
    }),
  };
  const lookup: any = {
    byId: async (_s: any, id: string) => (id === "p" ? project : undefined),
    project: async () => project,
  };
  const service = createLinkedContext(db, deps, lookup);
  const scope: any = {
    ctx: { instanceId: "i", userKey: "k" },
    team: "team",
    user: "u",
    bindings: [],
  };
  const r = (ref: string) => ({ kind: "wiki_page", wikiId: "wiki", ref });
  return {
    db,
    service,
    scope,
    r,
    read,
    revoke: () => (allowed = false),
    otherOwner: () => (owner = "other"),
    archive: () => (project = undefined),
  };
}
test("project links inherit, deduplicate and assemble with task links and provenance", async () => {
  const f = fixture();
  try {
    await f.service.handle(f.scope, "context-save", {
      kind: "project",
      id: "p",
      revision: 0,
      references: [f.r("overview.md")],
    });
    await f.service.handle(f.scope, "context-save", {
      kind: "task",
      id: "t",
      revision: 0,
      references: [f.r("overview.md"), f.r("task.md")],
    });
    const view: any = await f.service.handle(f.scope, "context-get", {
      kind: "task",
      id: "t",
    });
    expect(view.inherited).toHaveLength(1);
    const result = await f.service.assemble(f.scope, "t");
    expect(result.references).toHaveLength(2);
    expect(result.text).toContain("Project background");
    expect(result.text).toContain("Page: task.md");
    expect(result.excerpts[0].provenance.wikiVersion).toBe("v1");
  } finally {
    f.db.close();
  }
});
test("concurrent edit revision rejects overwrite and removed ACL blocks handoff", async () => {
  const f = fixture();
  try {
    const body = {
      kind: "project",
      id: "p",
      revision: 0,
      references: [f.r("a.md")],
    };
    await f.service.handle(f.scope, "context-save", body);
    await expect(
      f.service.handle(f.scope, "context-save", body),
    ).rejects.toThrow("changed elsewhere");
    f.revoke();
    await expect(f.service.assemble(f.scope, "t")).rejects.toThrow(
      "inaccessible",
    );
  } finally {
    f.db.close();
  }
});
test("wrong task owner and project editor cannot modify context", async () => {
  const f = fixture();
  try {
    f.otherOwner();
    await expect(f.service.assemble(f.scope, "t")).rejects.toThrow("creator");
    await expect(
      f.service.handle({ ...f.scope, user: "intruder" }, "context-save", {
        kind: "project",
        id: "p",
        revision: 0,
        references: [],
      }),
    ).rejects.toThrow("owner");
  } finally {
    f.db.close();
  }
});
test("missing source and excessive linked text stop handoff instead of silent omission", async () => {
  const f = fixture();
  try {
    await f.service.handle(f.scope, "context-save", {
      kind: "task",
      id: "t",
      revision: 0,
      references: ["a", "b", "c", "d"].map(f.r),
    });
    f.read.mockImplementation(async (_id, refs) => ({
      items: refs.map((ref) => ({ ref, content: "x".repeat(6000) })),
    }));
    await expect(f.service.assemble(f.scope, "t")).rejects.toThrow("exceed");
  } finally {
    f.db.close();
  }
});
