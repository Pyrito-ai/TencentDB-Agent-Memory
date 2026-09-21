import { projectManager } from "./projects.mjs";
import { inspectWorkspace, readWorkspaceFile } from "./workspace.mjs";
import { realpath } from "node:fs/promises";
/** Private single-owner Orca bridge. Start behind TLS or use loopback only. */
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { timingSafeEqual, createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
export function cli(binary) {
  return async (args) => {
    // No shell. Never return stderr: client/provider diagnostics may contain credentials.
    try {
      const { stdout } = await exec(binary, [...args, "--json"], {
        timeout: 90000,
        maxBuffer: 1024 * 1024,
      });
      const envelope = JSON.parse(stdout);
      if (envelope.ok !== true || !envelope.result) throw Error();
      return envelope.result;
    } catch {
      throw Error(
        "Orca command unavailable or outcome uncertain. Inspect Orca locally.",
      );
    }
  };
}
export async function createBridge({
  token,
  root,
  repos,
  command,
  projectRoot,
}) {
  if (typeof token !== "string" || token.length < 32)
    throw Error("A runner token of at least 32 characters is required.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const projects = await projectManager({ root, projectRoot, repos, command });
  const busy = new Set();
  const file = (id) => path.join(root, id + ".json");
  const persist = async (job) => {
    await writeFile(file(job.id) + ".tmp", JSON.stringify(job), {
      mode: 0o600,
    });
    await rename(file(job.id) + ".tmp", file(job.id));
  };
  const read = async (id) => JSON.parse(await readFile(file(id), "utf8"));
  const publicJob = (job) => {
    const { fingerprint, repo, directory, host, base, operations, ...data } =
      job;
    return data;
  };
  return http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    const supplied = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from("Bearer " + token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return reply(401, { error: "Unauthorized" });
    try {
      if (req.url === "/projects" && req.method === "GET")
        return reply(200, { items: await projects.list() });
      if (req.url === "/projects" && req.method === "POST") {
        let raw = "";
        for await (const part of req) {
          raw += part;
          if (Buffer.byteLength(raw) > 1000)
            return reply(413, { error: "Too large" });
        }
        try {
          const input = JSON.parse(raw);
          return reply(201, await projects.create(input.name));
        } catch {
          return reply(409, {
            error:
              "Project could not be created. Check the name and inspect Orca before retrying.",
          });
        }
      }
      const scoped =
        /^\/jobs\/([0-9a-f-]{36})\/(workspace|file|send|stop)$/.exec(
          req.url || "",
        );
      if (scoped) {
        let job;
        try {
          job = await read(scoped[1]);
        } catch {
          return reply(404, { error: "Job not found" });
        }
        if (!repos.includes(job.repo))
          return reply(403, { error: "Repository access removed" });
        const action = scoped[2];
        if (action === "workspace" && req.method === "GET")
          return reply(200, await inspectWorkspace(job));
        if (req.method !== "POST")
          return reply(405, { error: "Method not allowed" });
        let raw = "";
        for await (const part of req) {
          raw += part;
          if (Buffer.byteLength(raw) > 20000)
            return reply(413, { error: "Request too large" });
        }
        let input;
        try {
          input = JSON.parse(raw);
        } catch {
          return reply(400, { error: "Invalid JSON" });
        }
        if (action === "file")
          return reply(200, await readWorkspaceFile(job, input.path));
        if (!job.terminal)
          return reply(409, { error: "No worker terminal is available." });
        if (!/^[0-9a-f-]{36}$/.test(input.operation || ""))
          return reply(400, { error: "Operation ID required." });
        if (
          action === "send" &&
          (typeof input.text !== "string" ||
            !input.text.trim() ||
            input.text.length > 8000)
        )
          return reply(400, { error: "Invalid message." });
        if (busy.has(job.id))
          return reply(409, { error: "Worker operation in progress." });
        busy.add(job.id);
        try {
          job.operations ||= {};
          const fingerprint = createHash("sha256")
            .update(JSON.stringify({ action, text: input.text || "" }))
            .digest("hex");
          const previous = job.operations[input.operation];
          if (previous) {
            if (previous.fingerprint !== fingerprint)
              return reply(409, { error: "Operation ID conflict" });
            if (previous.state !== "done") {
              job.state = "unknown";
              job.notice =
                "Previous operation outcome is uncertain. Inspect Orca before retrying.";
              await persist(job);
            }
            return reply(200, publicJob(job));
          }
          job.operations[input.operation] = { fingerprint, state: "pending" };
          await persist(job);
          try {
            if (action === "send") {
              if (job.state !== "running")
                throw Error("Worker is not running.");
              const shown = await command([
                "terminal",
                "show",
                "--terminal",
                job.terminal,
              ]);
              if (
                !shown.terminal?.writable ||
                shown.terminal?.agentIdentity !== job.agent
              )
                throw Error("Worker identity could not be verified.");
              const sent = await command([
                "terminal",
                "send",
                "--terminal",
                job.terminal,
                "--text",
                input.text,
                "--enter",
                "--wait-submit",
                "20",
              ]);
              if (sent.send?.accepted !== true)
                throw Error("Prompt not accepted.");
              job.notice =
                "Follow-up accepted by Orca. Check the session output for the worker response.";
            } else {
              const result = await command([
                "terminal",
                "close",
                "--terminal",
                job.terminal,
              ]);
              if (
                result.close?.ptyKilled !== true ||
                result.close?.ptyStopVerdict
              )
                throw Error("Stop not verified.");
              job.state = "exited";
              job.stopped = true;
              job.notice =
                "Worker terminal stopped; its worktree is preserved.";
            }
            job.operations[input.operation].state = "done";
          } catch {
            job.operations[input.operation].state = "unknown";
            job.state = "unknown";
            job.notice =
              "Operation outcome uncertain. Inspect Orca before retrying.";
          }
          await persist(job);
          return reply(200, publicJob(job));
        } finally {
          busy.delete(job.id);
        }
      }
      const match = /^\/jobs\/([0-9a-f-]{36})$/.exec(req.url || "");
      if (req.method === "GET" && match) {
        let job;
        try {
          job = await read(match[1]);
        } catch {
          return reply(404, {
            error: "Unknown job. Inspect the runtime before retrying a launch.",
          });
        }
        if (!repos.includes(job.repo))
          return reply(403, { error: "Repository access removed" });
        if (busy.has(job.id)) return reply(200, publicJob(job));
        busy.add(job.id);
        try {
          if (job.terminal && !job.stopped) {
            try {
              const result = await command([
                "terminal",
                "read",
                "--terminal",
                job.terminal,
                "--limit",
                "200",
              ]);
              const data = result.terminal;
              if (
                !["running", "exited", "unknown"].includes(data.status) ||
                !Array.isArray(data.tail)
              )
                throw Error();
              job.state = data.status;
              job.output = data.tail
                .filter((x) => typeof x === "string")
                .join("\n")
                .slice(-80000);
              job.notice =
                "Terminal state is not proof of task completion. Review the diff and checks in Orca.";
            } catch {
              job.state = "unknown";
              job.notice =
                "Could not inspect the worker. Open Orca to reconcile.";
            }
          } else if (job.state === "launching") {
            job.state = "unknown";
            job.notice =
              "Launch interrupted. Inspect Orca before any new dispatch.";
          }
          await persist(job);
          return reply(200, publicJob(job));
        } finally {
          busy.delete(job.id);
        }
      }
      if (req.method !== "POST" || req.url !== "/jobs")
        return reply(404, { error: "Not found" });
      let raw = "";
      for await (const part of req) {
        raw += part;
        if (Buffer.byteLength(raw) > 100000)
          return reply(413, { error: "Request too large" });
      }
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return reply(400, { error: "Invalid JSON" });
      }
      const { id, repo, agent, spec } = input;
      if (
        typeof id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(id) ||
        !repos.includes(repo) ||
        !["claude", "codex"].includes(agent) ||
        typeof spec !== "string" ||
        spec.length < 1 ||
        spec.length > 50000
      )
        return reply(400, { error: "Invalid or unapproved worker request" });
      if (busy.has(id))
        return reply(409, { error: "Job operation in progress" });
      busy.add(id);
      try {
        const fingerprint = createHash("sha256")
          .update(JSON.stringify({ repo, agent, spec }))
          .digest("hex");
        let existing;
        try {
          existing = await read(id);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (existing)
          return reply(
            existing.fingerprint === fingerprint ? 200 : 409,
            existing.fingerprint === fingerprint
              ? publicJob(existing)
              : { error: "Job ID already used for a different request" },
          );
        const job = { id, repo, agent, fingerprint, state: "launching" };
        await persist(job);
        try {
          const result = await command([
            "worktree",
            "create",
            "--repo",
            repo,
            "--name",
            "tencent-" + id,
            "--agent",
            agent,
            "--prompt",
            spec,
            "--setup",
            "skip",
            "--no-parent",
          ]);
          job.worktree = result.worktree?.id;
          job.host = result.worktree?.hostId;
          job.base = result.worktree?.git?.head;
          if (job.host === "local" && result.worktree?.path) {
            job.directory = await realpath(result.worktree.path);
          }
          job.terminal = result.agentTerminalHandle;
          job.state = job.terminal ? "running" : "unknown";
          if (!job.terminal)
            job.notice =
              "Orca did not return a worker terminal handle. Inspect the worktree in Orca; no retry was attempted.";
        } catch {
          job.state = "unknown";
          job.notice =
            "Launch outcome uncertain. Inspect Orca before creating another run.";
        }
        await persist(job);
        return reply(200, publicJob(job));
      } finally {
        busy.delete(id);
      }
    } catch {
      return reply(500, {
        error: "Runner operation failed. Inspect the runtime locally.",
      });
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = JSON.parse(
    await readFile(process.env.WORKBENCH_RUNNER_CONFIG, "utf8"),
  );
  const server = await createBridge({
    token: config.token,
    root: config.dataDir,
    repos: config.repos,
    command: cli(config.orcaBinary),
    projectRoot: config.projectRoot,
  });
  server.listen(config.port || 8791, config.host || "127.0.0.1", () =>
    console.log("Workbench runner listening."),
  );
}
