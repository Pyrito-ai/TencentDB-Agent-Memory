/** Verified, private native Agent packages. This module performs no global installation. */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const marketingPackageRoot = fileURLToPath(new URL("../../agent-packages/marketing-skills/", import.meta.url));
export type Invoke = (action: string, body: Record<string, unknown>) => Promise<any>;
export type ImportState = {
  agentId?: string; skillId?: string; skillVersion?: number; packageHash?: string;
  pending?: string; complete?: boolean;
};
export type AgentPackage = Awaited<ReturnType<typeof readAgentPackage>>;
export type MarketingCatalog = {
  schemaVersion: 1;
  upstream: { repository: string; commit: string; license: string };
  excludedSkills: string[];
  agents: { slug: string; name: string; category: string; path: string; upstreamSkillVersion: string }[];
};
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
export const validIdentity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const slug = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
function safePath(value: string) {
  const parts = value.split("/");
  if (value.length > 240 || parts.length > 12 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part.length > 100 || part.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw Error("Invalid package resource path.");
}
async function textFile(file: string, maxBytes = 128 * 1024) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw Error("Package source must be a bounded regular file, without symlinks.");
  const bytes = await readFile(file);
  if (bytes.length > maxBytes) throw Error("Package source file too large.");
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (content.includes("\0")) throw Error("Package files must contain UTF-8 text without NUL bytes.");
  return { bytes, content, executable: !!(stat.mode & 0o111) };
}
function provenanceMetadata(provenance: any) {
  return {
    package: provenance.package, packageVersion: provenance.packageVersion,
    upstreamRepository: provenance.upstream.repository, upstreamCommit: provenance.upstream.commit,
    upstreamSkillVersion: provenance.upstream.skillVersion, license: provenance.upstream.license,
  };
}
function matchesProvenance(metadata: any, provenance: any) {
  const expected = provenanceMetadata(provenance);
  return object(metadata) && Object.entries(expected).every(([key, value]) => metadata[key] === value);
}
function validateAgent(agent: any, provenance: any) {
  if (!object(agent) || agent.schemaVersion !== 1 || agent.visibility !== "private" ||
      !validIdentity(agent.name) || agent.name.length > 128 ||
      typeof agent.description !== "string" || agent.description.length > 4096 ||
      typeof agent.prompt !== "string" || !agent.prompt.trim() || agent.prompt.length > 32000 ||
      [agent.name, agent.description, agent.prompt].some((v) => v.includes("\0")) ||
      !object(agent.metadata_json) || Buffer.byteLength(JSON.stringify(agent.metadata_json)) > 16000 ||
      !matchesProvenance(agent.metadata_json.marketing_provenance, provenance) || "pilot_provenance" in agent.metadata_json)
    throw Error("Invalid Agent name, prompt, metadata or marketing provenance.");
}

/** Exact source inventory, including agent.json; rejects unrecorded files and links. */
export async function readAgentPackage(packageRoot: string) {
  const root = await lstat(packageRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error("Package root must be a directory without symlinks.");
  const provenance = JSON.parse((await textFile(path.join(packageRoot, "provenance.json"))).content);
  if (!object(provenance) || provenance.schemaVersion !== 1 || !slug(provenance.package) || provenance.package === "seo-audit" ||
      !validIdentity(provenance.packageVersion) || !object(provenance.upstream) ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(provenance.upstream.repository) ||
      !/^[a-f0-9]{40}$/.test(provenance.upstream.commit) || !validIdentity(provenance.upstream.skillVersion) ||
      provenance.upstream.skillPath !== `skills/${provenance.package}` || !validIdentity(provenance.upstream.license) ||
      !object(provenance.files) || !Object.hasOwn(provenance.files, "agent.json") || !Object.hasOwn(provenance.files, "skill/SKILL.md") ||
      Object.hasOwn(provenance.files, "provenance.json")) throw Error("Invalid package provenance.");
  if (Buffer.byteLength(JSON.stringify(provenance)) > 16000) throw Error("Skill provenance exceeds 16000 bytes.");
  for (const [file, record] of Object.entries(provenance.files)) {
    safePath(file);
    if (!object(record) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > 128 * 1024 ||
        !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.executable !== "boolean") throw Error("Invalid package file provenance.");
  }
  const files: { path: string; content: string; encoding: "utf-8"; mime_type: string; is_executable: boolean }[] = [];
  const found = new Set<string>();
  const prefixes = new Map<string, string>();
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(packageRoot, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      safePath(file);
      const lower = file.toLowerCase();
      if (prefixes.has(lower) && prefixes.get(lower) !== file) throw Error("Conflicting package paths.");
      prefixes.set(lower, file);
      if (entry.isSymbolicLink()) throw Error("Package must not contain symlinks.");
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) throw Error("Unsupported package entry.");
      if (file === "provenance.json") continue;
      const expected = provenance.files[file];
      if (!expected) throw Error(`Unrecorded package resource: ${file}`);
      const { bytes, content, executable } = await textFile(path.join(packageRoot, file));
      if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256 || executable !== expected.executable)
        throw Error(`Package provenance mismatch: ${file}`);
      found.add(file);
      files.push({ path: file, content, encoding: "utf-8", mime_type: /\.(mjs|js)$/.test(file) ? "text/javascript" : file.endsWith(".json") ? "application/json" : "text/plain", is_executable: executable });
    }
  }
  await walk();
  if (found.size !== Object.keys(provenance.files).length) throw Error("Package resource inventory mismatch.");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const agent = JSON.parse(files.find((f) => f.path === "agent.json")!.content);
  validateAgent(agent, provenance);
  const content = files.find((f) => f.path === "skill/SKILL.md")!.content;
  const resources = files.filter((f) => f.path.startsWith("skill/") && f.path !== "skill/SKILL.md").map((f) => ({ ...f, path: f.path.slice(6) }));
  // Native Skill frontmatter uses a scalar slug and a one-line description in this pinned catalog.
  const skillText = content.replace(/\r\n?/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(skillText);
  const name = frontmatter?.[1]?.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
  const description = frontmatter?.[1]?.match(/^description:[ \t]*(.+)$/m)?.[1]?.trim();
  const body = frontmatter?.[2]?.replace(/^\n/, "");
  if (name !== provenance.package || !description || description.length > 1024 || /^[>|]/.test(description) || (body?.length ?? Infinity) > 50000)
    throw Error("Skill frontmatter or body is outside the supported native limits.");
  if (resources.length > 59) throw Error("Package exceeds 59 native resources.");
  for (const resource of resources) safePath(`skills/${provenance.package}/${resource.path}`);
  // Reserve 128 KiB total for generated Agent, context and manifest files. This is
  // a catalog preflight allowance, not a guarantee for arbitrary project context;
  // native assembly still enforces its exact 512 KiB total at every launch.
  const bundleBytes = Buffer.byteLength(content) + resources.reduce((n, f) => n + Buffer.byteLength(f.content), 0) + 128 * 1024;
  if (bundleBytes > 512 * 1024) throw Error("Package exceeds the 512 KiB bundle budget including context and manifest headroom.");
  return { agent, provenance, content, resources, packageHash: sha(JSON.stringify({ agent, provenance, files })) };
}

export async function readMarketingCatalog(): Promise<MarketingCatalog> {
  const root = await lstat(marketingPackageRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error("Invalid marketing catalog root.");
  const catalog = JSON.parse((await textFile(path.join(marketingPackageRoot, "catalog.json"))).content);
  if (!object(catalog) || catalog.schemaVersion !== 1 || !object(catalog.upstream) ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(catalog.upstream.repository) ||
      !/^[a-f0-9]{40}$/.test(catalog.upstream.commit) || !validIdentity(catalog.upstream.license) ||
      !Array.isArray(catalog.excludedSkills) || catalog.excludedSkills.length !== 1 || catalog.excludedSkills[0] !== "seo-audit" ||
      !Array.isArray(catalog.agents) || catalog.agents.length !== 49 || new Set(catalog.agents.map((a: any) => a.slug)).size !== 49 ||
      catalog.agents.some((a: any) => !object(a) || !slug(a.slug) || a.slug === "seo-audit" || a.path !== a.slug || !validIdentity(a.name) || !validIdentity(a.category) || !validIdentity(a.upstreamSkillVersion)))
    throw Error("Invalid marketing catalog; expected 49 unique packages excluding SEO Audit.");
  return catalog as MarketingCatalog;
}

async function call(invoke: Invoke, action: string, body: Record<string, unknown>) {
  const result = await invoke(action, body);
  if (result?.code !== 0 || !result.data) throw Error(`Marketing ${action} failed.`);
  return result.data;
}
export async function listOwnedAgents(team: string, user: string, meta: Invoke): Promise<any[]> {
  if (!validIdentity(team) || !validIdentity(user)) throw Error("Invalid owner/team identity.");
  const agents: any[] = [];
  const ids = new Set<string>();
  for (let offset = 0; offset < 10000; offset += 100) {
    const data = await call(meta, "agent/list", { team_id: team, owner_user_id: user, limit: 100, offset });
    const page = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(page) || page.length > 100) throw Error("Invalid Agent collision inventory.");
    for (const agent of page) {
      if (!validIdentity(agent?.agent_id) || agent.team_id !== team || agent.owner_user_id !== user || ids.has(agent.agent_id))
        throw Error("Agent collision inventory is outside the authorized owner/team or repeats an identity.");
      ids.add(agent.agent_id); agents.push(agent);
    }
    if (page.length < 100) return agents;
  }
  throw Error("Too many Agents to complete collision preflight.");
}
export type ImportInput = {
  packageRoot: string; team: string; user: string; meta: Invoke; skill: Invoke;
  existing?: ImportState; checkpoint?: (state: ImportState) => Promise<void>;
};
/** Read-only validation of both recoverable journal state and remotely matching Agents. */
export async function preflightAgentImport(input: ImportInput, pkg: AgentPackage, agents: any[]) {
  if (!validIdentity(input.team) || !validIdentity(input.user)) throw Error("Invalid owner/team identity.");
  const state = { ...input.existing };
  if (input.existing && (state.pending || state.packageHash !== pkg.packageHash))
    throw Error("Import journal is uncertain or package changed. Reconcile before retrying; no creation was replayed.");
  if ((state.complete !== undefined && typeof state.complete !== "boolean") ||
      (state.agentId !== undefined && !validIdentity(state.agentId)) ||
      (state.skillId !== undefined && (!validIdentity(state.skillId) || !state.agentId || !Number.isSafeInteger(state.skillVersion) || state.skillVersion! < 1)) ||
      (state.skillVersion !== undefined && !state.skillId) || (state.complete && (!state.agentId || !state.skillId))) throw Error("Invalid saved Agent/Skill identity.");
  for (const agent of agents) {
    let metadata: any;
    try { metadata = JSON.parse(agent.metadata_json || "{}"); } catch { throw Error("Existing Agent metadata is invalid; collision preflight cannot complete."); }
    if (!object(metadata)) throw Error("Existing Agent metadata is invalid; collision preflight cannot complete.");
    const p = metadata.marketing_provenance;
    if (p?.package === pkg.provenance.package && p?.upstreamRepository === pkg.provenance.upstream.repository && agent.agent_id !== state.agentId)
      throw Error(`Existing marketing Agent collision: ${pkg.provenance.package}. Reconcile its original journal before importing.`);
  }
  let savedMetadata: Record<string, any> = {};
  if (state.agentId) {
    const saved = await call(input.meta, "agent/get", { agent_id: state.agentId });
    if (saved.agent_id !== state.agentId || saved.team_id !== input.team || saved.owner_user_id !== input.user || saved.status !== "active" || saved.visibility !== "private")
      throw Error("Import journal Agent is outside the authorized owner/team or is not active/private.");
    try { savedMetadata = JSON.parse(saved.metadata_json || "{}"); } catch { throw Error("Import journal Agent metadata is invalid."); }
    if (!object(savedMetadata) || !matchesProvenance(savedMetadata.marketing_provenance, pkg.provenance)) throw Error("Import journal Agent provenance mismatch.");
    if (!state.complete && Object.hasOwn(savedMetadata, "workbench_bundle"))
      throw Error("Incomplete import Agent already has a bundle selection; reconcile without overwriting user edits.");
  }
  if (state.skillId) {
    const saved = await call(input.skill, "get", { skill_id: state.skillId, version: state.skillVersion, team_id: input.team, user_id: input.user, agent_id: state.agentId, include_content: true, include_manifest: true });
    if (saved.skill_id !== state.skillId || saved.team_id !== input.team || saved.owner_agent_id !== state.agentId || saved.version !== state.skillVersion || saved.status !== "active" || saved.name !== pkg.provenance.package ||
        JSON.stringify(saved.metadata?.source) !== JSON.stringify(pkg.provenance) || saved.content !== pkg.content || !Array.isArray(saved.manifest) || saved.manifest.length !== pkg.resources.length)
      throw Error("Import journal Skill is outside the selected Agent or differs from the pinned package.");
    const resourcePaths = new Set<string>();
    for (const resource of saved.manifest) {
      const expected = pkg.resources.find((f) => f.path === resource.path);
      if (!expected || resourcePaths.has(resource.path) || resource.size_bytes !== Buffer.byteLength(expected.content) || resource.is_executable !== expected.is_executable)
        throw Error("Import journal Skill resource manifest mismatch.");
      resourcePaths.add(resource.path);
      const raw = await call(input.skill, "files/read", { skill_id: state.skillId, version: state.skillVersion, team_id: input.team, user_id: input.user, agent_id: state.agentId, path: resource.path, encoding: "base64" });
      if (raw.path !== resource.path || raw.version !== state.skillVersion || raw.encoding !== "base64" || raw.size_bytes !== resource.size_bytes || raw.content !== Buffer.from(expected.content).toString("base64"))
        throw Error("Import journal Skill resource bytes mismatch.");
    }
  }
  if (state.complete) {
    const bundle = savedMetadata.workbench_bundle;
    if (bundle?.schema !== 1 || !Array.isArray(bundle.skills) || !bundle.skills.some((s: any) => s.skillId === state.skillId && s.version === state.skillVersion && s.slug === pkg.provenance.package) ||
        bundle.memory?.assetId !== `chat_memory-${input.team}-${state.agentId}`) throw Error("Completed import bundle differs from its journal; reconcile without overwriting user edits.");
  }
  return { state, savedMetadata };
}
/** Sequential native writes, each protected by a durable caller-supplied checkpoint. */
export async function importAgentPackage(input: ImportInput) {
  const pkg = await readAgentPackage(input.packageRoot);
  if (input.existing && (input.existing.pending || input.existing.packageHash !== pkg.packageHash))
    throw Error("Import journal is uncertain or package changed. Reconcile before retrying; no creation was replayed.");
  const prepared = await preflightAgentImport(input, pkg, await listOwnedAgents(input.team, input.user, input.meta));
  return applyVerifiedPackage(input, pkg, prepared);
}

/** Entire selection is read and checked remotely before the first native write. */
export async function importAgentPackages(inputs: ImportInput[]) {
  if (!inputs.length) throw Error("Select at least one package.");
  if (inputs.some((input) => input.team !== inputs[0]!.team || input.user !== inputs[0]!.user)) throw Error("Catalog import must have one authorized owner/team.");
  const packages = await Promise.all(inputs.map((input) => readAgentPackage(input.packageRoot)));
  if (new Set(packages.map((pkg) => pkg.provenance.package)).size !== packages.length) throw Error("Duplicate selected package.");
  for (let index = 0; index < inputs.length; index++) {
    const state = inputs[index]!.existing;
    if (state && (state.pending || state.packageHash !== packages[index]!.packageHash)) throw Error("Import journal is uncertain or package changed. Reconcile before retrying; no creation was replayed.");
  }
  const agents = await listOwnedAgents(inputs[0]!.team, inputs[0]!.user, inputs[0]!.meta);
  const prepared = [];
  for (let index = 0; index < inputs.length; index++) prepared.push(await preflightAgentImport(inputs[index]!, packages[index]!, agents));
  const results = [];
  for (let index = 0; index < inputs.length; index++) {
    const result = await applyVerifiedPackage(inputs[index]!, packages[index]!, prepared[index]!);
    results.push({ slug: packages[index]!.provenance.package as string, ...result });
  }
  return results;
}

async function applyVerifiedPackage(input: ImportInput, pkg: AgentPackage, prepared: Awaited<ReturnType<typeof preflightAgentImport>>) {
  const { state, savedMetadata } = prepared;
  if (state.complete) return { ...state, metadata: savedMetadata, packageHash: pkg.packageHash };
  const checkpoint = async (pending?: string, complete = false) => input.checkpoint?.({ ...state, packageHash: pkg.packageHash, ...(pending ? { pending } : {}), ...(complete ? { complete } : {}) });
  if (!state.agentId) {
    await checkpoint("agent/create");
    const agent = await call(input.meta, "agent/create", { team_id: input.team, owner_user_id: input.user, name: pkg.agent.name, description: pkg.agent.description, prompt: pkg.agent.prompt, visibility: "private", status: "active", metadata_json: JSON.stringify({ marketing_provenance: pkg.agent.metadata_json.marketing_provenance }) });
    if (!validIdentity(agent.agent_id)) throw Error("Agent creation returned an invalid identity; reconcile the pending journal.");
    state.agentId = agent.agent_id;
    await checkpoint();
  }
  if (!state.skillId) {
    await checkpoint("skill/create");
    const skill = await call(input.skill, "create", { team_id: input.team, user_id: input.user, agent_id: state.agentId, name: pkg.provenance.package, content: pkg.content, resources: pkg.resources, metadata: { source: pkg.provenance } });
    if (!validIdentity(skill.skill_id) || !Number.isSafeInteger(skill.version) || skill.version < 1) throw Error("Skill creation returned an invalid identity or version; reconcile the pending journal.");
    state.skillId = skill.skill_id; state.skillVersion = skill.version;
    await checkpoint();
  }
  const metadata = { ...pkg.agent.metadata_json, ...savedMetadata, workbench_bundle: { schema: 1, skills: [{ skillId: state.skillId, version: state.skillVersion, slug: pkg.provenance.package }], memory: { assetId: `chat_memory-${input.team}-${state.agentId}` } } };
  await checkpoint("agent/update");
  await call(input.meta, "agent/update", { agent_id: state.agentId, metadata_json: JSON.stringify(metadata) });
  await checkpoint(undefined, true);
  return { ...state, complete: true, metadata, packageHash: pkg.packageHash };
}
