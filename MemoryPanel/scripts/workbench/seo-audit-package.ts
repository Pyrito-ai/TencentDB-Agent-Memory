/** Read and verify the vendored pilot. Does not install anything globally. */
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const seoPackageRoot = fileURLToPath(
  new URL("../../agent-packages/seo-audit/", import.meta.url),
);
export async function readSeoAuditPackage() {
  const agent = JSON.parse(
    await readFile(path.join(seoPackageRoot, "agent.json"), "utf8"),
  );
  const provenance = JSON.parse(
    await readFile(path.join(seoPackageRoot, "provenance.json"), "utf8"),
  );
  for (const [file, expected] of Object.entries(provenance.files) as [
    string,
    any,
  ][]) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file) ||
      file.split("/").some((p) => !p || p === ".." || p === ".")
    )
      throw Error("Invalid provenance path.");
    const absolute = path.join(seoPackageRoot, file);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
      throw Error("Invalid pilot source file.");
    const bytes = await readFile(absolute);
    if (
      bytes.length !== expected.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256
    )
      throw Error(`Pilot provenance mismatch: ${file}`);
  }
  const files: {
    path: string;
    content: string;
    encoding: "utf-8";
    mime_type: string;
    is_executable: boolean;
  }[] = [];
  async function walk(relative = "") {
    for (const entry of await readdir(
      path.join(seoPackageRoot, "skill", relative),
      { withFileTypes: true },
    )) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw Error("Pilot package must not contain symlinks.");
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.isFile()) throw Error("Unsupported pilot package entry.");
      const absolute = path.join(seoPackageRoot, "skill", file);
      if ((await lstat(absolute)).size > 128 * 1024)
        throw Error("Pilot file too large.");
      const expected = provenance.files[`skill/${file}`];
      if (!expected || typeof expected.executable !== "boolean")
        throw Error(`Unrecorded pilot resource: ${file}`);
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(await readFile(absolute));
      files.push({
        path: file,
        content,
        encoding: "utf-8",
        mime_type: file.endsWith(".mjs") ? "text/javascript" : "text/markdown",
        is_executable: expected.executable,
      });
    }
  }
  await walk();
  if (
    files.length !==
    Object.keys(provenance.files).filter((p) => p.startsWith("skill/")).length
  )
    throw Error("Pilot resource inventory mismatch.");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skill = files.find((f) => f.path === "SKILL.md");
  if (!skill) throw Error("Pilot SKILL.md missing.");
  return {
    agent,
    provenance,
    content: skill.content,
    resources: files.filter((f) => f !== skill),
    packageHash: createHash("sha256")
      .update(JSON.stringify({ agent, provenance, files }))
      .digest("hex"),
  };
}

type Invoke = (action: string, body: Record<string, unknown>) => Promise<any>;
const validIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f]/.test(value);
/** Every write uses caller-authenticated native APIs. Caller supplies durable checkpoints. */
export async function importSeoAuditAgent(input: {
  team: string;
  user: string;
  meta: Invoke;
  skill: Invoke;
  existing?: {
    agentId?: string;
    skillId?: string;
    skillVersion?: number;
    packageHash?: string;
    pending?: string;
    complete?: boolean;
  };
  checkpoint?: (state: Record<string, unknown>) => Promise<void>;
}) {
  const pkg = await readSeoAuditPackage();
  if (
    input.existing &&
    (input.existing.pending || input.existing.packageHash !== pkg.packageHash)
  )
    throw Error(
      "Import journal is uncertain or package changed. Reconcile existing Agent/Skill before retrying; no creation was replayed.",
    );
  const state = { ...input.existing };
  let savedMetadata: Record<string, any> = {};
  const call = async (
    invoke: Invoke,
    action: string,
    body: Record<string, unknown>,
  ) => {
    const result = await invoke(action, body);
    if (result.code !== 0 || !result.data)
      throw Error(`Pilot ${action} failed: ${result.message || result.code}`);
    return result.data;
  };
  if (state.agentId) {
    const saved = await call(input.meta, "agent/get", {
      agent_id: state.agentId,
    });
    if (
      saved.team_id !== input.team ||
      saved.owner_user_id !== input.user ||
      saved.status !== "active"
    )
      throw Error("Import journal Agent is outside the authorized owner/team.");
    savedMetadata = JSON.parse(saved.metadata_json || "{}");
  }
  if (state.skillId) {
    if (
      !state.agentId ||
      !Number.isSafeInteger(state.skillVersion) ||
      state.skillVersion! < 1
    )
      throw Error("Invalid saved Skill identity.");
    const saved = await call(input.skill, "get", {
      skill_id: state.skillId,
      version: state.skillVersion,
      team_id: input.team,
      user_id: input.user,
      agent_id: state.agentId,
    });
    if (
      saved.team_id !== input.team ||
      saved.owner_agent_id !== state.agentId ||
      saved.version !== state.skillVersion ||
      saved.status !== "active"
    )
      throw Error("Import journal Skill is outside the selected Agent.");
  }
  if (state.complete && state.agentId && state.skillId)
    return { ...state, metadata: savedMetadata, packageHash: pkg.packageHash };
  if (!state.agentId) {
    await input.checkpoint?.({
      ...state,
      pending: "agent/create",
      packageHash: pkg.packageHash,
    });
    const agent = await call(input.meta, "agent/create", {
      team_id: input.team,
      owner_user_id: input.user,
      name: pkg.agent.name,
      description: pkg.agent.description,
      prompt: pkg.agent.prompt,
      visibility: "private",
      status: "active",
      metadata_json: JSON.stringify({
        pilot_provenance: pkg.agent.metadata_json.pilot_provenance,
      }),
    });
    if (!validIdentity(agent.agent_id))
      throw Error(
        "Pilot agent/create returned an invalid identity. Reconcile the pending journal before retrying.",
      );
    state.agentId = agent.agent_id;
    await input.checkpoint?.({ ...state, packageHash: pkg.packageHash });
  }
  if (!state.skillId) {
    await input.checkpoint?.({
      ...state,
      pending: "skill/create",
      packageHash: pkg.packageHash,
    });
    const skill = await call(input.skill, "create", {
      team_id: input.team,
      user_id: input.user,
      agent_id: state.agentId,
      name: "seo-audit",
      content: pkg.content,
      resources: pkg.resources,
      metadata: { source: pkg.provenance },
    });
    if (
      !validIdentity(skill.skill_id) ||
      !Number.isSafeInteger(skill.version) ||
      skill.version < 1
    )
      throw Error(
        "Pilot skill/create returned an invalid identity or version. Reconcile the pending journal before retrying.",
      );
    state.skillId = skill.skill_id;
    state.skillVersion = skill.version;
    await input.checkpoint?.({ ...state, packageHash: pkg.packageHash });
  }
  const metadata = {
    ...pkg.agent.metadata_json,
    ...savedMetadata,
    workbench_bundle: savedMetadata.workbench_bundle || {
      schema: 1,
      skills: [
        {
          skillId: state.skillId,
          version: state.skillVersion,
          slug: "seo-audit",
        },
      ],
      memory: { assetId: `chat_memory-${input.team}-${state.agentId}` },
    },
  };
  await call(input.meta, "agent/update", {
    agent_id: state.agentId,
    metadata_json: JSON.stringify(metadata),
  });
  await input.checkpoint?.({
    ...state,
    complete: true,
    packageHash: pkg.packageHash,
  });
  return { ...state, metadata, packageHash: pkg.packageHash };
}
