/** Operator import via authenticated Panel APIs; no global skill installation. */
import { parseArgs } from "node:util";
import { readFile, open, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import {
  importSeoAuditAgent,
  readSeoAuditPackage,
} from "./seo-audit-package.js";
const { values } = parseArgs({
  options: {
    apply: { type: "boolean" },
    url: { type: "string" },
    instance: { type: "string" },
    team: { type: "string" },
    "key-file": { type: "string" },
    journal: { type: "string" },
  },
  strict: true,
});
const pkg = await readSeoAuditPackage();
if (!values.apply) {
  console.log(
    JSON.stringify(
      {
        mode: "preview",
        agent: pkg.agent.name,
        upstream: pkg.provenance.upstream,
        resourceFiles: pkg.resources.map((f) => f.path),
        packageHash: pkg.packageHash,
        instruction:
          "To import into an authorized Panel, add --apply --url <origin> --instance <id> --team <id> --key-file <private-file> --journal <new-absolute-file>. This creates a private Agent and Skill, and selects its read-only self-memory. It does not launch a worker.",
      },
      null,
      2,
    ),
  );
} else {
  if (
    !values.url ||
    !values.instance ||
    !values.team ||
    !values["key-file"] ||
    !values.journal ||
    !path.isAbsolute(values.journal)
  )
    throw Error(
      "Missing import target, private key file or absolute journal path.",
    );
  const url = new URL(values.url);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("Use a credential-free HTTPS or loopback Panel origin.");
  const key = (await readFile(values["key-file"], "utf8")).trim();
  if (!key) throw Error("Private key file is empty.");
  const journal = values.journal;
  const identity = {
    url: url.origin,
    instance: values.instance,
    team: values.team,
  };
  const lock = await open(journal + ".lock", "wx", 0o600);
  try {
    let existing: any;
    try {
      const stat = await lstat(journal);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error("Import journal must be a regular file.");
      existing = JSON.parse(await readFile(journal, "utf8"));
      if (JSON.stringify(existing.target) !== JSON.stringify(identity))
        throw Error("Import journal belongs to a different target.");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    async function call(
      area: string,
      action: string,
      body: Record<string, unknown>,
    ) {
      const response = await fetch(`${url.origin}/api/v1/${area}/${action}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-Tdai-Service-Id": values.instance!,
          "X-Tdai-User-Key": key,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw Error(
          `Panel ${area}/${action} returned ${response.status}. Reconcile the journal before retrying uncertain writes.`,
        );
      return response.json();
    }
    const auth: any = await call("meta", "auth/verify", { user_key: key });
    if (
      auth.code !== 0 ||
      auth.data?.valid !== true ||
      !auth.data.user?.user_id
    )
      throw Error("Owner authentication failed.");
    const user = auth.data.user.user_id;
    const member: any = await call("meta", "team-member/get", {
      team_id: values.team,
      user_id: user,
    });
    if (member.code !== 0 || member.data?.status !== "active")
      throw Error("Authenticated user is not an active member of this team.");
    const result = await importSeoAuditAgent({
      team: values.team,
      user,
      existing,
      meta: (a, b) => call("meta", a, b),
      skill: (a, b) => call("skill", a, b),
      checkpoint: async (state) => {
        const temporary = journal + ".next";
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(
            JSON.stringify({ target: identity, ...state }, null, 2),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, journal);
        const directory = await open(path.dirname(journal), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      },
    });
    console.log(
      JSON.stringify(
        {
          agentId: result.agentId,
          skillId: result.skillId,
          skillVersion: result.skillVersion,
          packageHash: result.packageHash,
          complete: true,
          workerLaunched: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await lock.close();
    await rm(journal + ".lock", { force: true });
  }
}
