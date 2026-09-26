import { expect, test, vi } from "vitest";
import { collectWorkbenchContext, prepareReviewedOutcomeDraft, type ContextDependencies } from "../src/panel/workbench/context.js";

const ctx = { instanceId: "instance-a", gatewayEndpoint: "unused", gatewayApiKey: "unused", userKey: "key" };
const selection = { teamId: "team-a", userId: "user-a", taskId: "task-a", references: [{ kind: "wiki_page" as const, wikiId: "wiki-a", ref: "overview.md" }] };
function fixture(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    "auth/verify": { valid: true, user: { user_id: "user-a" } },
    "team-member/get": { status: "active" },
    "task/get": { task_id: "task-a", team_id: "team-a" },
    "asset/get": { asset_id: "wiki-a", team_id: "team-a", asset_type: "llm_wiki" },
    "acl/check": { allowed: true }, ...overrides,
  };
  const invoke = vi.fn(async (action: string) => ({ code: 0, data: values[action], message: "ok", request_id: "r" }));
  const wikiGet = vi.fn(async () => ({ wiki_id: "wiki-a", team_id: "team-a", version: "v1" }));
  const wikiPageRead = vi.fn(async (_id: string, refs: string[]) => ({ items: refs.map((ref) => ({ ref, content: "source text" })) }));
  const factory = vi.fn(() => ({ wikiGet, wikiPageRead }));
  return { deps: { metaKernel: { invoke }, knowledgeClientFactory: factory } as unknown as ContextDependencies, invoke, wikiGet, wikiPageRead, factory };
}
test("selected page uses verified instance credentials, task/team/asset scope and provenance", async () => {
  const f = fixture();
  const result = await collectWorkbenchContext(f.deps, ctx, selection);
  expect(f.factory).toHaveBeenCalledWith("instance-a");
  expect(f.invoke).toHaveBeenCalledWith("acl/check", { user_id: "user-a", asset_id: "wiki-a", action: "read" }, ctx);
  expect(result.excerpts[0]).toMatchObject({ content: "source text", provenance: { instanceId: "instance-a", teamId: "team-a", taskId: "task-a", wikiVersion: "v1" } });
  expect(result.text).toContain("untrusted reference material");
});
test.each([
  ["auth/verify", { valid: true, user: { user_id: "another-user" } }],
  ["team-member/get", { status: "inactive" }],
  ["task/get", { task_id: "task-a", team_id: "other-team" }],
  ["asset/get", { asset_id: "wiki-a", team_id: "other-team", asset_type: "llm_wiki" }],
  ["asset/get", { asset_id: "wiki-a", team_id: "team-a", asset_type: "chat_memory" }],
  ["acl/check", { allowed: false }],
])("fails closed before content for invalid %s", async (action, data) => {
  const f = fixture({ [action as string]: data });
  await expect(collectWorkbenchContext(f.deps, ctx, selection)).rejects.toThrow("WORKBENCH_CONTEXT_UNAVAILABLE");
  expect(f.wikiPageRead).not.toHaveBeenCalled();
});
test("rejects mismatched knowledge service team even with valid meta permissions", async () => {
  const f = fixture();
  f.wikiGet.mockResolvedValue({ wiki_id: "wiki-a", team_id: "other-team", version: "v1" });
  await expect(collectWorkbenchContext(f.deps, ctx, selection)).rejects.toThrow();
  expect(f.wikiPageRead).not.toHaveBeenCalled();
});
test("cannot substitute a different page in source response", async () => {
  const f = fixture();
  f.wikiPageRead.mockResolvedValue({ items: [{ ref: "private.md", content: "secret" }] });
  await expect(collectWorkbenchContext(f.deps, ctx, selection)).rejects.toThrow();
});
test("bounds content, removes duplicate selections, and stops reads at total limit", async () => {
  const f = fixture();
  f.wikiPageRead.mockImplementation(async (_id, refs) => ({ items: refs.map(ref => ({ ref, content: "x".repeat(6000) })) }));
  const references = ["one", "one", "two", "three", "four"].map(ref => ({ kind: "wiki_page" as const, wikiId: "wiki-a", ref }));
  const result = await collectWorkbenchContext(f.deps, ctx, { ...selection, references });
  expect(result.excerpts.map(x => x.content.length)).toEqual([4000, 4000, 4000]);
  expect(result.excerpts.every(x => x.truncated)).toBe(true);
  expect(f.wikiPageRead).toHaveBeenCalledTimes(3);
});
test.each(["../secret", "/etc/passwd", "a/../secret", "a\\secret"])("rejects unsafe selected ref %s", async ref => {
  const f = fixture();
  await expect(collectWorkbenchContext(f.deps, ctx, { ...selection, references: [{ ...selection.references[0], ref }] })).rejects.toThrow();
  expect(f.invoke).not.toHaveBeenCalled();
});
test("reviewed outcome stays an unpersisted draft and requires approval", () => {
  const input = { taskId: "t", executionId: "e", reviewerUserId: "u", summary: "verified change", evidence: ["diff receipt"], reviewDecision: "approved" as const };
  expect(prepareReviewedOutcomeDraft(input)).toMatchObject({ persisted: false, kind: "reviewed_outcome_draft" });
  expect(() => prepareReviewedOutcomeDraft({ ...input, reviewDecision: "changes_requested" })).toThrow("WORKBENCH_OUTCOME_REVIEW_REQUIRED");
});
