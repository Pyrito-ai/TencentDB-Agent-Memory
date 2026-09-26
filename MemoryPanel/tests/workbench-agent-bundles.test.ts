import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { agentBundles, type AgentBundleConfig } from "../src/panel/workbench/agent-bundles.js";
import { agentProfiles } from "../src/panel/workbench/agent-profiles.js";
import { registerWorkbenchRoutes } from "../src/panel/http/routes/workbench.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";
import type { ExecutionScope } from "../src/panel/workbench/execution.js";
import { validateBundle } from "../scripts/workbench/agent-bundle.mjs";

const config: AgentBundleConfig = {
  schema: 1,
  skills: [{ skillId: "seo-skill", version: 2, slug: "seo-audit" }],
  wikiReferences: [{ kind: "wiki_page", wikiId: "wiki", ref: "brand.md" }],
  memory: { assetId: "chat_memory-team-agt-seo" },
};
const scope: ExecutionScope = {
  ctx: { instanceId: "default", userKey: "alice", gatewayEndpoint: "", gatewayApiKey: "" },
  team: "team", user: "alice", bindings: [],
};
const context = { references: [], text: "", hash: "project-hash", project: { id: "project", name: "Project", description: "Use accurate claims." } };
let deps: PanelDeps, records: Record<string, any>, bindings: any[], denied: Set<string>, resource: string,
  skill: any, memory: string, root: string, close: (() => void) | undefined;
let memberActive: boolean;
beforeEach(() => {
  memberActive = true;
  denied = new Set();
  resource = "print('Check the fixture')\n";
  memory = "Prefer actionable evidence over invented scores.";
  skill = { skill_id: "seo-skill", team_id: "team", version: 2, status: "active", name: "SEO Audit", content: "---\nname: seo-audit\n---\nRead references/checklist.md and scripts/check.py.",
    manifest: [{ path: "scripts/check.py", size_bytes: Buffer.byteLength(resource), is_executable: true }],
    metadata: { source: { repository: "https://github.com/coreyhaines31/marketingskills", revision: "abc123", license: "MIT" } } };
  records = {
    "agt-seo": { agent_id: "agt-seo", name: "SEO Audit", team_id: "team", owner_user_id: "alice", status: "active", visibility: "private", prompt: "Audit, do not change the site.", updated_at: "v1", metadata_json: JSON.stringify({ workbench_bundle: config }) },
    "seo-skill": { asset_id: "seo-skill", team_id: "team", asset_type: "skill", status: "active", owner_user_id: "alice" },
    wiki: { asset_id: "wiki", team_id: "team", asset_type: "llm_wiki", status: "active", owner_user_id: "alice" },
    "chat_memory-team-agt-seo": { asset_id: "chat_memory-team-agt-seo", team_id: "team", asset_type: "chat_memory", status: "active", owner_user_id: "alice" },
  };
  bindings = Object.values(records).filter((r) => r.asset_id).map((r) => ({ agent_id: "agt-seo", asset_id: r.asset_id, asset_type: r.asset_type }));
  deps = {
    instanceRegistry: { resolve: (id: string) => ({ instance_id: id, gateway_endpoint: "", api_key: "" }) },
    metaKernel: { invoke: vi.fn(async (action: string, body: any) => {
      let data: any;
      if (action === "auth/verify") data = { valid: true, user: { user_id: "alice" } };
      if (action === "team-member/get") data = { status: memberActive ? "active" : "removed" };
      if (action === "team/get") data = { team_id: "team", owner_user_id: "alice" };
      if (action === "agent/get") data = records[body.agent_id];
      if (action === "agent/list") data = { items: Object.values(records).filter((r) => r.agent_id) };
      if (action === "asset/get") data = records[body.asset_id];
      if (action === "acl/check") data = { allowed: !denied.has(body.asset_id) };
      if (action === "agent-fixed-asset/list") data = { items: bindings.slice(body.offset, body.offset + body.limit) };
      if (action === "task/get") data = { task_id: body.task_id, team_id: "team", creator_user_id: "alice", title: "Audit the fixture", description: "Return evidence without editing the site." };
      return { code: data ? 0 : 404, data };
    }) },
    skillKernel: { invoke: vi.fn(async (action: string, body: any) => ({ code: 0, data: action === "get" ? skill : {
      path: body.path, version: body.version, content: Buffer.from(resource).toString("base64"), encoding: "base64", size_bytes: Buffer.byteLength(resource),
    } })) },
    kernelHttp: { postEnvelope: vi.fn(async () => ({ code: 0, data: { content: memory, version: "memory-v1" } })) },
    knowledgeClientFactory: () => ({ wikiGet: async (id: string) => ({ wiki_id: id, team_id: "team", version: "wiki-v1" }),
      wikiPageRead: async (_id: string, refs: string[]) => ({ items: refs.map((ref) => ({ ref, content: "Use our approved positioning." })) }) }),
  } as unknown as PanelDeps;
});
afterEach(async () => { close?.(); close = undefined; if (root) await rm(root, { recursive: true, force: true }); });
const profile = () => agentProfiles(deps).get(scope, "agt-seo");
const bundle = async () => agentBundles(deps).assemble(scope, await profile(), context, "task");

test("owned Agent packages pin complete UTF-8 skill resources, Wiki, Agent memory and provenance", async () => {
  const result = (await bundle())!;
  expect(result.files.map((f) => f.path)).toEqual(["agent.md", "context/memory.md", "context/wiki.md", "manifest.json", "skills/seo-audit/SKILL.md", "skills/seo-audit/scripts/check.py"]);
  expect(result.files.find((f) => f.path.endsWith("check.py"))).toMatchObject({ content: resource, executable: true });
  expect(result.files.find((f) => f.path === "context/wiki.md")?.content).toContain("approved positioning");
  expect(result.files.find((f) => f.path === "context/memory.md")?.content).toContain(memory);
  const manifest = JSON.parse(result.files.find((f) => f.path === "manifest.json")!.content);
  expect(manifest.memory).toMatchObject({ scope: "team-and-agent", layer: "L3", readOnly: true });
  expect(manifest.skills[0]).toMatchObject({ version: 2, source: { license: "MIT", revision: "abc123" } });
  expect(result.digest).toBe(createHash("sha256").update(JSON.stringify(result.files)).digest("hex"));
  expect(validateBundle(result)).toEqual(result);
  expect(deps.skillKernel.invoke).toHaveBeenCalledWith("files/read", expect.objectContaining({ version: 2, user_id: "alice", team_id: "team", encoding: "base64" }), scope.ctx);
  expect(deps.kernelHttp.postEnvelope).toHaveBeenCalledWith("/v3/core/read", expect.objectContaining({ agent_id: "agt-seo", team_id: "team", user_id: "alice" }), expect.anything());
});

test("team-shared profiles require separate caller permission for each source", async () => {
  records["agt-seo"].owner_user_id = "bob";
  records["agt-seo"].visibility = "team";
  records["chat_memory-team-agt-seo"].owner_user_id = "bob";
  expect(await bundle()).toBeTruthy();
  denied.add("seo-skill");
  await expect(bundle()).rejects.toThrow("readable by you");
});

test.each(["private profile", "foreign profile", "foreign asset", "removed member", "missing binding", "missing asset", "archived asset"])("rejects %s before resource access", async (scenario) => {
  if (scenario === "private profile") records["agt-seo"].owner_user_id = "bob";
  if (scenario === "foreign profile") records["agt-seo"].team_id = "elsewhere";
  if (scenario === "foreign asset") records["seo-skill"].team_id = "elsewhere";
  if (scenario === "removed member") memberActive = false;
  if (scenario === "missing binding") bindings = bindings.filter((b) => b.asset_id !== "seo-skill");
  if (scenario === "missing asset") delete records["seo-skill"];
  if (scenario === "archived asset") records["seo-skill"].status = "archived";
  await expect(bundle()).rejects.toThrow();
  expect(deps.skillKernel.invoke).not.toHaveBeenCalled();
});

test.each(["../outside", "/absolute", "references/.hidden", "references/CON.txt", "scripts\\evil", "references/file."])("rejects unsafe resource path %s", async (resourcePath) => {
  skill.manifest[0].path = resourcePath;
  await expect(bundle()).rejects.toThrow("resource path");
});

test("fails on missing version or resource and does not silently fall back", async () => {
  skill.version = 3;
  await expect(bundle()).rejects.toThrow("pinned Skill version");
  skill.version = 2;
  vi.mocked(deps.skillKernel.invoke).mockImplementation(async (action) => ({ code: action === "get" ? 0 : 404, message: "", request_id: "", data: action === "get" ? skill : undefined }));
  await expect(bundle()).rejects.toThrow("required Skill resource");
});

test("bounds memory with explicit provenance and rejects excess package bytes", async () => {
  memory = "x".repeat(9000);
  const result = (await bundle())!;
  expect(JSON.parse(result.files.find((f) => f.path === "manifest.json")!.content).memory.truncated).toBe(true);
  expect(result.files.find((f) => f.path === "context/memory.md")!.content).toContain("Snapshot truncated");
  skill.content = "x".repeat(128 * 1024 + 1);
  await expect(bundle()).rejects.toThrow("size limits");
});

test("an existing memory asset with no L3 file is represented as empty", async () => {
  vi.mocked(deps.kernelHttp.postEnvelope).mockResolvedValue({ code: 0, message: "", request_id: "", data: { content: null } });
  const result = (await bundle())!;
  expect(JSON.parse(result.files.find((f) => f.path === "manifest.json")!.content).memory).toMatchObject({ enabled: true, empty: true });
  expect(result.files.find((f) => f.path === "context/memory.md")!.content).toContain("No saved core memory yet");
});

test("task/project Wiki snapshot is reused and deduplicated against Agent Wiki selection", async () => {
  const p = await profile();
  const ref = config.wikiReferences![0]!;
  const result = (await agentBundles(deps).assemble(scope, p, { ...context, references: [ref], excerpts: [{ ...ref,
    content: "Exact previously assembled Wiki revision", truncated: false,
    provenance: { instanceId: "default", teamId: "team", taskId: "task", wikiVersion: "original-v1" },
  }] }, "task"))!;
  const wiki = result.files.find((f) => f.path === "context/wiki.md")!.content;
  expect(wiki).toContain("Exact previously assembled Wiki revision");
  expect(wiki).not.toContain("approved positioning");
  const manifest = JSON.parse(result.files.find((f) => f.path === "manifest.json")!.content);
  expect(manifest.wiki).toHaveLength(1);
  expect(manifest.wiki[0].provenance.wikiVersion).toBe("original-v1");
});

test("large manifests and provenance fail before resource reads", async () => {
  skill.manifest = Array.from({ length: 61 }, () => skill.manifest[0]);
  await expect(bundle()).rejects.toThrow("file limit");
  expect(deps.skillKernel.invoke).toHaveBeenCalledTimes(1);
  vi.mocked(deps.skillKernel.invoke).mockClear();
  skill.manifest = [];
  skill.metadata.source = { description: "x".repeat(16001) };
  await expect(bundle()).rejects.toThrow("provenance is too large");
  expect(deps.skillKernel.invoke).toHaveBeenCalledTimes(1);
});

test("plain profiles retain the old handoff without implicit resource collection", async () => {
  delete records["agt-seo"].metadata_json;
  expect(await bundle()).toBeUndefined();
  expect(deps.skillKernel.invoke).not.toHaveBeenCalled();
});

test.each(["{broken", "null", "[]", '{"workbench_bundle":{"schema":1}}'])("malformed metadata %s cannot downgrade to a prompt-only profile", async (metadata) => {
  records["agt-seo"].metadata_json = metadata;
  await expect(profile()).rejects.toThrow();
  expect(deps.skillKernel.invoke).not.toHaveBeenCalled();
  records["agt-plain"] = { ...records["agt-seo"], agent_id: "agt-plain", metadata_json: "{}" };
  const listed = await agentProfiles(deps).list(scope);
  expect(listed.map((p) => p.id)).toEqual(["agt-plain"]);
});

test("saved snapshots reject revoked sources and never refresh their content", async () => {
  const p = await profile(), result = (await bundle())!;
  const saved = JSON.stringify(result);
  memory = "A newer memory revision";
  await agentBundles(deps).authorize(scope, p, result, context, "task");
  expect(JSON.stringify(result)).toBe(saved);
  denied.add("chat_memory-team-agt-seo");
  await expect(agentBundles(deps).authorize(scope, p, result, context, "task")).rejects.toThrow("readable by you");
});

test.each(["", "cdesktop-"])("%shandoff persists package before launch and retries exact bytes", async (prefix) => {
  root = await mkdtemp(path.join(tmpdir(), "bundle-route-"));
  const app = new Hono();
  const launch = vi.fn().mockRejectedValue(Error("connection closed after acceptance"));
  const runtime = { id: "runtime", label: "test", instance: "default", team: "team", user: "alice", repo: "fixture", url: "http://127.0.0.1:1234", token: "a".repeat(32) };
  close = registerWorkbenchRoutes(app, deps, { root, bindings: [runtime], cdesktopBindings: [runtime],
    boardLookup: { byId: async () => undefined, project: async () => undefined, isLoopTask: async () => false },
    runner: { launch, read: vi.fn() } as any,
  });
  const input = { taskId: "task", binding: "runtime", agent: "codex", profileId: "agt-seo" };
  const req = (action: string) => app.request(`/workbench/team/${prefix}${action}`, { method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "default", "x-tdai-user-key": "alice" }, body: JSON.stringify(input) });
  const validMetadata = records["agt-seo"].metadata_json;
  records["agt-seo"].metadata_json = "{broken";
  expect((await req("handoff-launch")).status).toBe(409);
  expect(launch).not.toHaveBeenCalled();
  records["agt-seo"].metadata_json = validMetadata;
  const response = await req("handoff-launch");
  expect(response.status).toBe(200);
  const first = (await response.json()).handoff;
  expect(first.bundle.files.some((f: any) => f.path === "skills/seo-audit/SKILL.md")).toBe(true);
  expect(launch.mock.calls[0]?.[4]).toEqual(first.bundle);
  memory = "Updated memory must not replace saved content";
  records["agt-seo"].prompt = "New profile instructions";
  expect((await req("handoff-launch")).status).toBe(200);
  expect(launch.mock.calls[1]?.slice(1)).toEqual(launch.mock.calls[0]?.slice(1));
  denied.add("wiki");
  expect((await req("handoff-get")).status).toBe(409);
  expect((await req("handoff-launch")).status).toBe(409);
  expect(launch).toHaveBeenCalledTimes(2);
});
