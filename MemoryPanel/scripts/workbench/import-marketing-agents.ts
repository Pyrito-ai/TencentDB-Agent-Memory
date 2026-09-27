/** Preview by default. Apply uses only an explicit private key file and native APIs. */
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { importAgentPackages, marketingPackageRoot, readAgentPackage, readMarketingCatalog, validIdentity, type ImportState } from "./agent-package.js";

async function syncDirectory(directoryPath: string) {
  const directory = await open(directoryPath, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Import journal/lock directory must be private and owned by the current user.");
}
async function readPrivateFile(file: string, maximum = 64 * 1024) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Key and journal files must be bounded, private regular files owned by the current user.");
  const value = await readFile(file, "utf8");
  if (Buffer.byteLength(value) > maximum) throw Error("Private import file is too large.");
  return value;
}
type Target = { url: string; instance: string; team: string; user: string };
async function readJournal(file: string, target: Target, slug: string): Promise<ImportState | undefined> {
  try {
    const saved = JSON.parse(await readPrivateFile(file));
    if (!saved || saved.schemaVersion !== 1 || saved.slug !== slug ||
        Object.entries(target).some(([key, value]) => saved.target?.[key] !== value)) throw Error("Import journal belongs to a different target, owner or package.");
    const { agentId, skillId, skillVersion, packageHash, pending, complete } = saved;
    return { agentId, skillId, skillVersion, packageHash, pending, complete };
  } catch (error: any) { if (error.code !== "ENOENT") throw error; return undefined; }
}
/** Rename plus file and directory fsync ensures the last acknowledged write is durable. */
async function checkpoint(file: string, target: Target, slug: string, state: ImportState) {
  const temporary = file + ".next";
  const stream = await open(temporary, "wx", 0o600);
  try {
    await stream.writeFile(JSON.stringify({ schemaVersion: 1, target, slug, ...state }, null, 2) + "\n");
    await stream.sync();
  } finally { await stream.close(); }
  await rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

export async function runMarketingImport(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    apply: { type: "boolean" }, url: { type: "string" }, instance: { type: "string" }, team: { type: "string" },
    "key-file": { type: "string" }, "journal-dir": { type: "string" }, only: { type: "string" },
  }, strict: true });
  const catalog = await readMarketingCatalog();
  const selected = values.only ? catalog.agents.filter((agent) => agent.slug === values.only) : catalog.agents;
  if (!selected.length) throw Error("Unknown selected marketing package.");
  // Even preview validates real source bytes and launch limits. No API or credentials are read.
  const packages = await Promise.all(selected.map((agent) => readAgentPackage(path.join(marketingPackageRoot, agent.path))));
  for (let index = 0; index < packages.length; index++) {
    const pkg = packages[index]!;
    const record = selected[index]!;
    if (pkg.provenance.package !== record.slug || pkg.agent.name !== record.name || pkg.provenance.upstream.skillVersion !== record.upstreamSkillVersion ||
        Object.entries(catalog.upstream).some(([key, value]) => pkg.provenance.upstream[key] !== value)) throw Error("Marketing catalog and package provenance disagree.");
  }
  if (!values.apply) return {
    mode: "preview", count: packages.length,
    agents: packages.map((pkg) => ({ slug: pkg.provenance.package, resources: pkg.resources.length })),
  };
  if (!values.url || !validIdentity(values.instance) || !validIdentity(values.team) || !values["key-file"] || !path.isAbsolute(values["key-file"]) ||
      !values["journal-dir"] || !path.isAbsolute(values["journal-dir"])) throw Error("Apply requires --url --instance --team --key-file <absolute-private-file> --journal-dir <absolute-private-directory>.");
  const url = new URL(values.url);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error("Use a credential-free HTTPS or loopback Panel origin.");
  const key = (await readPrivateFile(values["key-file"])).trim();
  if (!key || /[\u0000-\u001f\u007f]/.test(key)) throw Error("Private key file is empty or invalid.");
  async function call(area: string, action: string, body: Record<string, unknown>) {
    let response: Response;
    try {
      response = await fetch(`${url.origin}/api/v1/${area}/${action}`, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", "X-Tdai-Service-Id": values.instance!, "X-Tdai-User-Key": key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
    } catch { throw Error(`Panel ${area}/${action} did not complete. Reconcile any pending journal before retrying.`); }
    if (!response.ok) throw Error(`Panel ${area}/${action} returned HTTP ${response.status}. Reconcile any pending journal before retrying.`);
    try { return await response.json(); } catch { throw Error(`Panel ${area}/${action} returned an invalid response.`); }
  }
  const auth: any = await call("meta", "auth/verify", { user_key: key });
  if (auth.code !== 0 || auth.data?.valid !== true || !validIdentity(auth.data.user?.user_id)) throw Error("Owner authentication failed.");
  const user = auth.data.user.user_id as string;
  const member: any = await call("meta", "team-member/get", { team_id: values.team, user_id: user });
  if (member.code !== 0 || member.data?.status !== "active" || member.data?.team_id !== values.team || member.data?.user_id !== user)
    throw Error("Authenticated user is not an active member of this team.");
  const target: Target = { url: url.origin, instance: values.instance, team: values.team, user };
  // Stable across journal directories: concurrent runs against the same owner/team cannot race.
  const lockDirectory = path.join(tmpdir(), `marketing-agent-import-${process.getuid?.() ?? "user"}`);
  await privateDirectory(lockDirectory);
  const lockPath = path.join(lockDirectory, createHash("sha256").update(JSON.stringify(target)).digest("hex") + ".lock");
  const lock = await open(lockPath, "wx", 0o600);
  const journalDirectory = values["journal-dir"];
  try {
    await lock.writeFile(JSON.stringify({ target, pid: process.pid }) + "\n");
    await lock.sync();
    await syncDirectory(lockDirectory);
    await privateDirectory(journalDirectory);
    const inputs = [];
    for (const record of selected) {
      const journal = path.join(journalDirectory, record.slug + ".json");
      // A surviving .next is uncertain; never silently discard the last attempted checkpoint.
      try { await lstat(journal + ".next"); throw Error("Uncertain temporary journal exists; reconcile before retrying."); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
      inputs.push({
        packageRoot: path.join(marketingPackageRoot, record.path), team: values.team, user,
        meta: (action: string, body: Record<string, unknown>) => call("meta", action, body),
        skill: (action: string, body: Record<string, unknown>) => call("skill", action, body),
        existing: await readJournal(journal, target, record.slug),
        checkpoint: (state: ImportState) => checkpoint(journal, target, record.slug, state),
      });
    }
    const results = await importAgentPackages(inputs);
    return { mode: "applied", count: results.length, agents: results.map((result) => ({ slug: result.slug, agentId: result.agentId, skillId: result.skillId, skillVersion: result.skillVersion })) };
  } finally {
    await lock.close();
    await rm(lockPath);
    await syncDirectory(lockDirectory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMarketingImport().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    // Do not print response bodies, input arguments, stack traces or credentials.
    console.error(error instanceof Error ? error.message : "Marketing import failed.");
    process.exitCode = 1;
  });
}
