import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { importAgentPackage, importAgentPackages, readAgentPackage, type ImportState } from "../scripts/workbench/agent-package.js";
import { runMarketingImport } from "../scripts/workbench/import-marketing-agents.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fixture(slug = "content-strategy", resources: Record<string, string> = { "references/example.md": "# Evidence\n", "scripts/check.mjs": "#!/usr/bin/env node\nconsole.log('fixture');\n" }) {
  const root = await mkdtemp(path.join(tmpdir(), "marketing-import-test-")); roots.push(root);
  const provenance: any = {
    schemaVersion: 1, package: slug, packageVersion: "1.0.0",
    upstream: { repository: "https://github.com/coreyhaines31/marketingskills", commit: "a".repeat(40), skillPath: `skills/${slug}`, skillVersion: "2.0.0", license: "MIT" }, files: {},
  };
  const marketing = { package: slug, packageVersion: provenance.packageVersion, upstreamRepository: provenance.upstream.repository, upstreamCommit: provenance.upstream.commit, upstreamSkillVersion: provenance.upstream.skillVersion, license: "MIT" };
  const agent = { schemaVersion: 1, name: slug, description: "Evidence-led marketing guidance.", prompt: "Read the supplied package and authorized context. Report evidence and gaps.", visibility: "private", metadata_json: { marketing_provenance: marketing } };
  const files = { "agent.json": JSON.stringify(agent), "skill/SKILL.md": `---\nname: ${slug}\ndescription: Help with marketing.\n---\n\n# Guidance\n`, ...Object.fromEntries(Object.entries(resources).map(([file, value]) => [`skill/${file}`, value])) };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content, { mode: file.endsWith(".mjs") ? 0o755 : 0o644 });
    provenance.files[file] = { sha256: digest(content), bytes: Buffer.byteLength(content), origin: "local", executable: file.endsWith(".mjs") };
  }
  await writeFile(path.join(root, "provenance.json"), JSON.stringify(provenance));
  return root;
}
async function replaceSource(root: string, file: string, content: string | Buffer) {
  const provenance = JSON.parse(await readFile(path.join(root, "provenance.json"), "utf8"));
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
  provenance.files[file] = { ...provenance.files[file], bytes: Buffer.byteLength(content), sha256: digest(content), executable: provenance.files[file]?.executable ?? false };
  await writeFile(path.join(root, "provenance.json"), JSON.stringify(provenance));
}
function nativeApi() {
  const agents = new Map<string, any>();
  const skills = new Map<string, any>();
  const writes: string[] = [];
  const meta = vi.fn(async (action: string, body: Record<string, any>) => {
    if (action === "agent/list") return { code: 0, data: { items: [...agents.values()].slice(body.offset, body.offset + body.limit) } };
    if (action === "agent/get") return { code: 0, data: agents.get(body.agent_id) };
    if (action === "agent/create") {
      writes.push(action);
      const agent = { ...body, agent_id: `agt-${agents.size + 1}` }; agents.set(agent.agent_id, agent);
      return { code: 0, data: agent };
    }
    if (action === "agent/update") {
      writes.push(action);
      const agent = { ...agents.get(body.agent_id), ...body }; agents.set(agent.agent_id, agent);
      return { code: 0, data: agent };
    }
    throw Error(`Unexpected meta action ${action}`);
  });
  const skill = vi.fn(async (action: string, body: Record<string, any>) => {
    if (action === "create") {
      writes.push("skill/create");
      const value = { ...body, skill_id: `skl-${skills.size + 1}`, owner_agent_id: body.agent_id, status: "active", version: 1,
        manifest: body.resources.map((f: any) => ({ path: f.path, size_bytes: Buffer.byteLength(f.content), is_executable: f.is_executable })) };
      skills.set(value.skill_id, value); return { code: 0, data: value };
    }
    if (action === "get") return { code: 0, data: skills.get(body.skill_id) };
    if (action === "files/read") {
      const resource = skills.get(body.skill_id).resources.find((f: any) => f.path === body.path);
      return { code: 0, data: { path: body.path, version: body.version, encoding: "base64", size_bytes: Buffer.byteLength(resource.content), content: Buffer.from(resource.content).toString("base64") } };
    }
    throw Error(`Unexpected skill action ${action}`);
  });
  return { agents, skills, writes, meta, skill };
}
const owner = { team: "team-marketing", user: "user-marketing" };
function checkpoints() {
  const journal: ImportState[] = [];
  return { journal, checkpoint: async (state: ImportState) => { journal.push(structuredClone(state)); } };
}

test("creates a complete private Agent and native Skill bundle with a pinned version and self-memory", async () => {
  const root = await fixture(); const api = nativeApi(); const saved = checkpoints();
  const pkg = await readAgentPackage(root);
  const result = await importAgentPackage({ packageRoot: root, ...owner, ...api, ...saved });
  expect(api.writes).toEqual(["agent/create", "skill/create", "agent/update"]);
  expect(api.meta).toHaveBeenCalledWith("agent/list", { team_id: owner.team, owner_user_id: owner.user, limit: 100, offset: 0 });
  expect(api.agents.get(result.agentId!)).toMatchObject({ visibility: "private", owner_user_id: owner.user, team_id: owner.team });
  expect(result.metadata).toMatchObject({ marketing_provenance: { package: "content-strategy", upstreamCommit: "a".repeat(40) }, workbench_bundle: { schema: 1, skills: [{ slug: "content-strategy", skillId: result.skillId, version: 1 }], memory: { assetId: `chat_memory-${owner.team}-${result.agentId}` } } });
  expect(result.metadata).not.toHaveProperty("pilot_provenance");
  expect(api.skills.get(result.skillId!)).toMatchObject({ name: "content-strategy", content: pkg.content, resources: pkg.resources, metadata: { source: pkg.provenance } });
  expect(saved.journal.map((state) => state.pending ?? (state.complete ? "complete" : "saved"))).toEqual(["agent/create", "saved", "skill/create", "saved", "agent/update", "complete"]);
  expect(saved.journal.at(-1)).toMatchObject({ complete: true, packageHash: pkg.packageHash, agentId: result.agentId, skillId: result.skillId });
});

test("a completed replay is idempotent and preserves user-edited prompt, metadata and later Skill versions", async () => {
  const root = await fixture(); const api = nativeApi(); const saved = checkpoints();
  const first = await importAgentPackage({ packageRoot: root, ...owner, ...api, ...saved });
  const agent = api.agents.get(first.agentId!);
  agent.prompt = "A user-edited prompt";
  agent.metadata_json = JSON.stringify({ ...JSON.parse(agent.metadata_json), user_note: "Keep this" });
  api.writes.length = 0; saved.journal.length = 0;
  const result = await importAgentPackage({ packageRoot: root, ...owner, ...api, ...saved, existing: first });
  expect(api.writes).toEqual([]); expect(saved.journal).toEqual([]);
  expect(result.metadata.user_note).toBe("Keep this"); expect(agent.prompt).toBe("A user-edited prompt");
  expect(api.skill).toHaveBeenCalledWith("get", expect.objectContaining({ skill_id: first.skillId, version: 1 }));
});

test("safely resumes an acknowledged Agent-only journal without creating a second Agent", async () => {
  const root = await fixture(); const api = nativeApi(); const pkg = await readAgentPackage(root);
  api.agents.set("agt-saved", { agent_id: "agt-saved", team_id: owner.team, owner_user_id: owner.user, status: "active", visibility: "private", metadata_json: JSON.stringify(pkg.agent.metadata_json) });
  const result = await importAgentPackage({ packageRoot: root, ...owner, ...api, existing: { agentId: "agt-saved", packageHash: pkg.packageHash } });
  expect(result.agentId).toBe("agt-saved"); expect(api.writes).toEqual(["skill/create", "agent/update"]);
});

test.each(["agent-only", "skill-complete"])("partial %s replay preserves a user's existing bundle selection", async (partial) => {
  const root = await fixture(); const api = nativeApi(); const first = await importAgentPackage({ packageRoot: root, ...owner, ...api });
  const agent = api.agents.get(first.agentId!);
  const metadata = JSON.parse(agent.metadata_json);
  metadata.workbench_bundle.wikiReferences = [{ kind: "wiki_page", wikiId: "wiki-user", ref: "marketing/context.md" }];
  agent.metadata_json = JSON.stringify(metadata);
  const before = agent.metadata_json;
  const existing = { agentId: first.agentId, packageHash: first.packageHash, ...(partial === "skill-complete" ? { skillId: first.skillId, skillVersion: first.skillVersion } : {}) };
  api.writes.length = 0;
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api, existing })).rejects.toThrow("without overwriting user edits");
  expect(api.writes).toEqual([]); expect(api.agents.get(first.agentId!).metadata_json).toBe(before);
});

test.each(["agent/create", "skill/create", "agent/update"])("an uncertain %s outcome retains pending state and refuses retry", async (failure) => {
  const root = await fixture(); const api = nativeApi(); const saved = checkpoints();
  const meta = vi.fn(async (action, body) => { if (action === failure) throw Error("lost response"); return api.meta(action, body); });
  const skill = vi.fn(async (action, body) => { if (`skill/${action}` === failure) throw Error("lost response"); return api.skill(action, body); });
  const input = { packageRoot: root, ...owner, meta, skill, ...saved };
  await expect(importAgentPackage(input)).rejects.toThrow("lost response");
  expect(saved.journal.at(-1)?.pending).toBe(failure);
  meta.mockClear(); skill.mockClear();
  await expect(importAgentPackage({ ...input, existing: saved.journal.at(-1) })).rejects.toThrow("uncertain");
  expect(meta).not.toHaveBeenCalled(); expect(skill).not.toHaveBeenCalled();
});

test.each([{}, { agent_id: "" }, { agent_id: 23 }])("malformed Agent success preserves its pending checkpoint: %j", async (data) => {
  const root = await fixture(); const saved = checkpoints(); const api = nativeApi();
  const meta = vi.fn(async (action, body) => action === "agent/create" ? { code: 0, data } : api.meta(action, body));
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api, ...saved, meta })).rejects.toThrow("invalid identity");
  expect(saved.journal.at(-1)).toMatchObject({ pending: "agent/create" }); expect(api.skill).not.toHaveBeenCalled();
});

test.each([{}, { skill_id: "", version: 1 }, { skill_id: "skl", version: 0 }, { skill_id: "skl", version: 1.5 }])("malformed Skill success preserves its pending checkpoint: %j", async (data) => {
  const root = await fixture(); const saved = checkpoints(); const api = nativeApi();
  const skill = vi.fn(async () => ({ code: 0, data }));
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api, ...saved, skill })).rejects.toThrow("invalid identity or version");
  expect(saved.journal.at(-1)).toMatchObject({ pending: "skill/create", agentId: "agt-1" }); expect(api.writes).toEqual(["agent/create"]);
});

test("changed source hash refuses journal replay before API calls", async () => {
  const root = await fixture(); const pkg = await readAgentPackage(root); const api = nativeApi();
  await replaceSource(root, "skill/references/example.md", "Changed upstream guidance");
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api, existing: { packageHash: pkg.packageHash } })).rejects.toThrow("package changed");
  expect(api.meta).not.toHaveBeenCalled(); expect(api.skill).not.toHaveBeenCalled();
});

test.each([{ team_id: "wrong-team" }, { owner_user_id: "wrong-owner" }, { visibility: "team" }, { status: "inactive" }])("rejects saved Agent scope changes before writes: %j", async (patch) => {
  const root = await fixture(); const api = nativeApi(); const first = await importAgentPackage({ packageRoot: root, ...owner, ...api });
  Object.assign(api.agents.get(first.agentId!), patch); api.writes.length = 0;
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api, existing: first })).rejects.toThrow(/owner\/team|active\/private/);
  expect(api.writes).toEqual([]);
});

test("a new journal cannot duplicate an existing marketing package, including a changed upstream revision", async () => {
  const root = await fixture(); const api = nativeApi(); const first = await importAgentPackage({ packageRoot: root, ...owner, ...api });
  const agent = api.agents.get(first.agentId!); const metadata = JSON.parse(agent.metadata_json);
  metadata.marketing_provenance.upstreamCommit = "b".repeat(40); agent.metadata_json = JSON.stringify(metadata); api.writes.length = 0;
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api })).rejects.toThrow("collision"); expect(api.writes).toEqual([]);
});

test("collision preflight paginates the full owner/team inventory", async () => {
  const root = await fixture(); const pkg = await readAgentPackage(root); const api = nativeApi();
  for (let index = 0; index < 100; index++) api.agents.set(`unrelated-${index}`, { agent_id: `unrelated-${index}`, team_id: owner.team, owner_user_id: owner.user, metadata_json: "{}" });
  api.agents.set("existing", { agent_id: "existing", team_id: owner.team, owner_user_id: owner.user, metadata_json: JSON.stringify(pkg.agent.metadata_json) });
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api })).rejects.toThrow("collision");
  expect(api.meta.mock.calls.filter(([action]) => action === "agent/list").map(([, body]) => body.offset)).toEqual([0, 100]); expect(api.writes).toEqual([]);
});

test("all selected packages are validated before any API call", async () => {
  const first = await fixture("copywriting"); const second = await fixture("copy-editing"); const api = nativeApi();
  await writeFile(path.join(second, "skill/unrecorded.md"), "not in provenance");
  await expect(importAgentPackages([first, second].map((packageRoot) => ({ packageRoot, ...owner, ...api })))).rejects.toThrow("Unrecorded");
  expect(api.meta).not.toHaveBeenCalled(); expect(api.writes).toEqual([]);
});

test("all remote collisions are checked before creating the first selected package", async () => {
  const first = await fixture("copywriting"); const second = await fixture("copy-editing"); const pkg = await readAgentPackage(second); const api = nativeApi();
  api.agents.set("existing", { agent_id: "existing", team_id: owner.team, owner_user_id: owner.user, metadata_json: JSON.stringify(pkg.agent.metadata_json) });
  await expect(importAgentPackages([first, second].map((packageRoot) => ({ packageRoot, ...owner, ...api })))).rejects.toThrow("collision"); expect(api.writes).toEqual([]);
});

test("batch import creates sequential packages and each complete journal is independently reusable", async () => {
  const first = await fixture("copywriting"); const second = await fixture("copy-editing"); const api = nativeApi(); const one = checkpoints(); const two = checkpoints();
  const results = await importAgentPackages([{ packageRoot: first, ...owner, ...api, ...one }, { packageRoot: second, ...owner, ...api, ...two }]);
  expect(results.map((r) => r.slug)).toEqual(["copywriting", "copy-editing"]);
  expect(api.writes).toEqual(["agent/create", "skill/create", "agent/update", "agent/create", "skill/create", "agent/update"]);
  api.writes.length = 0;
  await importAgentPackage({ packageRoot: second, ...owner, ...api, existing: two.journal.at(-1) }); expect(api.writes).toEqual([]);
});

test.each(["content", "manifest", "resource", "owner", "bundle"])("complete retry fails closed on altered pinned %s without overwriting edits", async (change) => {
  const root = await fixture(); const api = nativeApi(); const result = await importAgentPackage({ packageRoot: root, ...owner, ...api });
  const skill = api.skills.get(result.skillId!); const agent = api.agents.get(result.agentId!);
  if (change === "content") skill.content += "changed";
  if (change === "manifest") skill.manifest.pop();
  if (change === "resource") skill.resources[0].content = "altered bytes";
  if (change === "owner") skill.owner_agent_id = "other-agent";
  if (change === "bundle") { const metadata = JSON.parse(agent.metadata_json); metadata.workbench_bundle.skills[0].version = 2; agent.metadata_json = JSON.stringify(metadata); }
  api.writes.length = 0;
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api, existing: result })).rejects.toThrow(/Skill|bundle/); expect(api.writes).toEqual([]);
});

test.each(["unrecorded", "missing", "agent-hash", "invalid-utf8", "nul", "symlink", "execute-mode", "unsafe-path", "case-conflict"])("reader rejects %s package resources", async (failure) => {
  const root = await fixture();
  if (failure === "unrecorded") await writeFile(path.join(root, "skill/extra.md"), "extra");
  if (failure === "missing") await rm(path.join(root, "skill/references/example.md"));
  if (failure === "agent-hash") await writeFile(path.join(root, "agent.json"), "{}");
  if (failure === "invalid-utf8") await replaceSource(root, "skill/references/example.md", Buffer.from([0xc3, 0x28]));
  if (failure === "nul") await replaceSource(root, "skill/references/example.md", "bad\0text");
  if (failure === "symlink") { await rm(path.join(root, "skill/references/example.md")); await symlink(path.join(root, "agent.json"), path.join(root, "skill/references/example.md")); }
  if (failure === "execute-mode") await chmod(path.join(root, "skill/scripts/check.mjs"), 0o644);
  if (failure === "unsafe-path") { const p = JSON.parse(await readFile(path.join(root, "provenance.json"), "utf8")); p.files["../outside"] = p.files["agent.json"]; await writeFile(path.join(root, "provenance.json"), JSON.stringify(p)); }
  if (failure === "case-conflict") { await replaceSource(root, "skill/references/Example.md", "upper"); await replaceSource(root, "skill/references/example.md", "lower"); }
  await expect(readAgentPackage(root)).rejects.toThrow();
});

test.each(["file-bytes", "resource-count", "source-json", "bundle-headroom", "prompt", "skill-body"])("reader enforces %s native launch limits before creation", async (limit) => {
  const resources = limit === "resource-count" ? Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`file-${i}.md`, "x"])) :
    limit === "bundle-headroom" ? { "one.md": "a".repeat(128 * 1024), "two.md": "b".repeat(128 * 1024), "three.md": "c".repeat(128 * 1024) } : {};
  const root = await fixture("copywriting", resources); const api = nativeApi();
  if (limit === "file-bytes") await replaceSource(root, "skill/huge.md", "x".repeat(128 * 1024 + 1));
  if (limit === "source-json") { const p = JSON.parse(await readFile(path.join(root, "provenance.json"), "utf8")); p.notes = "x".repeat(16000); await writeFile(path.join(root, "provenance.json"), JSON.stringify(p)); }
  if (limit === "prompt") { const agent = JSON.parse(await readFile(path.join(root, "agent.json"), "utf8")); agent.prompt = "x".repeat(32001); await replaceSource(root, "agent.json", JSON.stringify(agent)); }
  if (limit === "skill-body") await replaceSource(root, "skill/SKILL.md", `---\nname: copywriting\ndescription: Help.\n---\n${"x".repeat(50002)}`);
  await expect(importAgentPackage({ packageRoot: root, ...owner, ...api })).rejects.toThrow(); expect(api.meta).not.toHaveBeenCalled(); expect(api.writes).toEqual([]);
});

async function cliFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "marketing-cli-test-")); roots.push(root);
  const keyFile = path.join(root, "key"); await writeFile(keyFile, "mock-private-key", { mode: 0o600 });
  const journalDir = path.join(root, "journal");
  const args = ["--apply", "--only", "copywriting", "--url", "https://marketing-import-test.invalid", "--instance", "instance-test", "--team", owner.team, "--key-file", keyFile, "--journal-dir", journalDir];
  const api = nativeApi();
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string); const route = new URL(url).pathname.slice("/api/v1/".length);
    let data: any;
    if (route === "meta/auth/verify") data = { code: 0, data: { valid: true, user: { user_id: owner.user } } };
    else if (route === "meta/team-member/get") data = { code: 0, data: { team_id: owner.team, user_id: owner.user, status: "active" } };
    else if (route.startsWith("meta/")) data = await api.meta(route.slice(5), body);
    else if (route.startsWith("skill/")) data = await api.skill(route.slice(6), body);
    else throw Error("Unexpected route");
    return { ok: true, status: 200, json: async () => data };
  });
  vi.stubGlobal("fetch", fetcher);
  return { root, args, keyFile, journalDir, api, fetcher };
}

test("CLI defaults to validating all 49 packages without reading credentials or calling an API", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const result = await runMarketingImport(["--key-file", "/does-not-exist"]);
  expect(result.mode).toBe("preview"); expect(result.count).toBe(49);
  expect(new Set(result.agents.map((agent) => agent.slug)).size).toBe(49);
  expect(result.agents.some((agent) => agent.slug === "seo-audit")).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

test("CLI authenticates the owner, writes private per-package journals and leaves completed retries unchanged", async () => {
  const { args, api, fetcher, journalDir } = await cliFixture();
  const result = await runMarketingImport(args);
  expect(result).toMatchObject({ mode: "applied", count: 1, agents: [{ slug: "copywriting", agentId: "agt-1", skillId: "skl-1", skillVersion: 1 }] });
  const journal = JSON.parse(await readFile(path.join(journalDir, "copywriting.json"), "utf8"));
  expect(journal).toMatchObject({ schemaVersion: 1, slug: "copywriting", target: { user: owner.user, team: owner.team }, complete: true });
  expect(journal).not.toHaveProperty("pending");
  expect((await stat(path.join(journalDir, "copywriting.json"))).mode & 0o077).toBe(0);
  expect((await stat(journalDir)).mode & 0o077).toBe(0);
  expect(await readdir(journalDir)).toEqual(["copywriting.json"]);
  expect(JSON.stringify(result)).not.toContain("mock-private-key"); expect(JSON.stringify(journal)).not.toContain("mock-private-key");
  expect(fetcher.mock.calls[0]![0]).toContain("/meta/auth/verify");
  api.writes.length = 0; await runMarketingImport(args); expect(api.writes).toEqual([]);
});

test("CLI prevents duplicates when an operator supplies a fresh journal directory", async () => {
  const { args, root, api } = await cliFixture(); await runMarketingImport(args); api.writes.length = 0;
  const newArgs = [...args]; newArgs[newArgs.length - 1] = path.join(root, "new-journal");
  await expect(runMarketingImport(newArgs)).rejects.toThrow("collision"); expect(api.writes).toEqual([]);
});

test.each(["authentication", "membership", "private-key"])("CLI rejects failed %s before native writes", async (failure) => {
  const { args, api, fetcher, keyFile } = await cliFixture();
  if (failure === "private-key") await chmod(keyFile, 0o644);
  else if (failure === "authentication") fetcher.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { valid: false } }) }));
  else fetcher.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { valid: true, user: { user_id: "wrong-owner" } } }) }));
  await expect(runMarketingImport(args)).rejects.toThrow(/authentication|active member|private regular/); expect(api.writes).toEqual([]);
});

test("CLI refuses uncertain temporary checkpoints instead of ignoring them", async () => {
  const { args, api, journalDir } = await cliFixture();
  await mkdir(journalDir, { mode: 0o700 }); await writeFile(path.join(journalDir, "copywriting.json.next"), "{}", { mode: 0o600 });
  await expect(runMarketingImport(args)).rejects.toThrow("Uncertain temporary journal"); expect(api.writes).toEqual([]);
});
