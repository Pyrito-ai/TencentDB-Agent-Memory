/** Private, isolated cdesktop bridge. Its journal never replays a mutation. */
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER = ".cdesktop-runner.json";
const uncertain =
  "Launch outcome is uncertain. Inspect the linked cdesktop workspace before creating another run. This prompt will not be submitted again.";
const observed =
  "Execution process state is not task acceptance. Review the changes and checks in cdesktop.";
const within = (parent, child) =>
  child === parent || child.startsWith(parent + path.sep);
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function origin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error(
      "cdesktop endpoints must be loopback HTTP origins without paths or credentials.",
    );
  return url.origin;
}

// Both the file and its directory are synced before the next external mutation.
async function durableWrite(file, value, exclusive = false) {
  const temporary = exclusive ? file : file + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!exclusive) await rename(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close();
    if (!exclusive) await rm(temporary, { force: true });
    throw error;
  }
}

export async function createCdesktopBridge({
  token,
  root,
  repos,
  cdesktopUrl,
  webUrl = cdesktopUrl,
  codexModel = "gpt-5.6-sol",
  executorVariant = "WORKBENCH",
  timeoutMs = 90000,
}) {
  if (typeof token !== "string" || token.length < 32)
    throw Error("A runner token of at least 32 characters is required.");
  const upstream = origin(cdesktopUrl),
    browser = origin(webUrl);
  if (!path.isAbsolute(root || "") || !Array.isArray(repos) || !repos.length)
    throw Error(
      "A dedicated absolute data directory and repository allowlist are required.",
    );
  if (
    typeof codexModel !== "string" ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(codexModel) ||
    !/^[A-Z0-9_]{1,50}$/.test(executorVariant)
  )
    throw Error("Invalid executor configuration.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000)
    throw Error("Invalid upstream timeout.");
  const approved = new Map();
  for (const repo of repos) {
    if (
      !repo ||
      typeof repo.id !== "string" ||
      !/^[A-Za-z0-9:_-]{1,150}$/.test(repo.id) ||
      approved.has(repo.id) ||
      !path.isAbsolute(repo.path || "") ||
      typeof repo.targetBranch !== "string" ||
      !repo.targetBranch.trim() ||
      repo.targetBranch.length > 255 ||
      /[\x00-\x20]/.test(repo.targetBranch)
    )
      throw Error("Invalid repository allowlist.");
    approved.set(repo.id, { ...repo, path: await realpath(repo.path) });
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  root = await realpath(root);
  if (
    [...approved.values()].some(
      (repo) => within(repo.path, root) || within(root, repo.path),
    )
  )
    throw Error(
      "Runner state and source repositories must use separate directories.",
    );
  const markerFile = path.join(root, MARKER);
  let marker;
  try {
    marker = JSON.parse(await readFile(markerFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if ((await readdir(root)).length)
      throw Error("Refusing to use existing non-cdesktop runner state.");
    marker = { version: 1, runtime: upstream, namespace: randomUUID() };
    try {
      await durableWrite(markerFile, marker, true);
    } catch (failure) {
      if (failure.code !== "EEXIST") throw failure;
      marker = JSON.parse(await readFile(markerFile, "utf8"));
    }
  }
  if (
    marker.version !== 1 ||
    marker.runtime !== upstream ||
    !UUID.test(marker.namespace || "")
  )
    throw Error("Runner state belongs to a different cdesktop runtime.");

  const file = (id) => path.join(root, id + ".json");
  const persist = (job) => {
    if (job.workspaceId)
      job.webUrl =
        browser +
        "/workspaces/" +
        job.workspaceId +
        "?embed=1" +
        (job.sessionId ? "&sessionId=" + job.sessionId : "");
    return durableWrite(file(job.id), job);
  };
  const read = async (id) => JSON.parse(await readFile(file(id), "utf8"));
  const busy = new Set();
  // A crash leaves its lock in place. A later request may inspect but must not
  // reclaim the lock or infer that a side effect did not happen.
  async function acquire(id) {
    if (busy.has(id)) return false;
    try {
      await mkdir(path.join(root, id + ".lock"), { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    busy.add(id);
    return true;
  }
  async function release(id) {
    busy.delete(id);
    await rm(path.join(root, id + ".lock"), { recursive: true });
  }
  async function api(route, body) {
    const response = await fetch(upstream + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Error("cdesktop request outcome unavailable.");
    const raw = await response.text();
    if (raw.length > 4_000_000) throw Error("cdesktop response too large.");
    const envelope = JSON.parse(raw);
    if (envelope.success !== true || envelope.data == null)
      throw Error("cdesktop response unavailable.");
    return envelope.data;
  }
  async function validateProfile(executor) {
    const result = await api("/api/profiles");
    const profile = JSON.parse(result.content)?.executors?.[executor]?.[
      executorVariant
    ]?.[executor];
    const set = (value) =>
      value != null &&
      value !== "" &&
      (typeof value !== "object" || Object.keys(value).length > 0);
    if (
      !profile ||
      [
        "base_command_override",
        "additional_params",
        "env",
        "profile",
        "model_provider",
        "base_instructions",
        "developer_instructions",
        "compact_prompt",
        "append_prompt",
      ].some((key) => set(profile[key]))
    )
      throw Error(
        "The explicit Workbench executor profile is missing or has unsupported overrides.",
      );
    if (executor === "CODEX") {
      if (
        !["workspace-write", "read-only"].includes(profile.sandbox) ||
        !["on-request", "unless-trusted"].includes(profile.ask_for_approval) ||
        profile.oss === true ||
        profile.plan === true
      )
        throw Error(
          "The Codex profile must require permissions and use a sandbox.",
        );
    } else if (
      profile.dangerously_skip_permissions !== false ||
      profile.approvals !== true ||
      profile.disable_api_key !== true ||
      profile.claude_code_router !== false ||
      profile.plan === true ||
      (profile.permission_mode_override != null &&
        profile.permission_mode_override !== "default")
    )
      throw Error(
        "The Claude profile must require permissions and subscription authentication.",
      );
  }
  function validateWorkspace(workspace, job) {
    if (
      !workspace ||
      !UUID.test(workspace.id || "") ||
      workspace.name !== job.identity ||
      workspace.use_worktree !== true ||
      (job.workspaceId && job.workspaceId !== workspace.id)
    )
      throw Error("Workspace identity is not isolated.");
    return workspace;
  }
  async function validateRepo(repo, configured) {
    if (
      !repo ||
      !UUID.test(repo.id || "") ||
      repo.is_git !== true ||
      typeof repo.path !== "string" ||
      (await realpath(repo.path)) !== configured.path ||
      typeof repo.name !== "string" ||
      path.basename(repo.name) !== repo.name ||
      [".", "..", ""].includes(repo.name)
    )
      throw Error("Repository identity is not approved.");
    if (
      ["setup_script", "cleanup_script", "archive_script", "copy_files"].some(
        (key) => repo[key] != null && repo[key] !== "",
      )
    )
      throw Error(
        "cdesktop repository scripts or copied files must be disabled for this clean-worktree trial.",
      );
    return repo;
  }
  async function worktree(workspace, repo) {
    if (!path.isAbsolute(workspace.container_ref || ""))
      throw Error("Worktree directory is unavailable.");
    const directory = await realpath(
      path.join(workspace.container_ref, repo.name),
    );
    if (
      [...approved.values()].some(
        (source) =>
          within(source.path, directory) || within(directory, source.path),
      ) ||
      within(root, directory)
    )
      throw Error(
        "cdesktop returned a source repository or shared state directory.",
      );
    return directory;
  }
  function validateSession(session, job) {
    if (
      !session ||
      !UUID.test(session.id || "") ||
      session.workspace_id !== job.workspaceId ||
      session.name !== job.identity ||
      session.executor !== job.executor ||
      (job.sessionId && session.id !== job.sessionId)
    )
      throw Error("Session identity is not approved.");
    return session;
  }
  function processState(process, job) {
    if (
      !process ||
      !UUID.test(process.id || "") ||
      process.session_id !== job.sessionId ||
      (job.executionProcessId && process.id !== job.executionProcessId)
    )
      throw Error("Execution identity is not approved.");
    const action = process.executor_action?.typ;
    if (
      process.run_reason !== "codingagent" ||
      process.executor_action.next_action != null ||
      action?.type !== "CodingAgentInitialRequest" ||
      typeof action.prompt !== "string" ||
      sha(action.prompt) !== job.promptHash ||
      action.executor_config?.executor !== job.executor ||
      action.executor_config?.variant !== executorVariant ||
      action.executor_config?.permission_policy !== "SUPERVISED" ||
      (job.agent === "codex" && action.executor_config?.model_id !== codexModel)
    )
      throw Error("Execution prompt or executor identity does not match.");
    job.executionProcessId = process.id;
    job.processStatus = process.status;
    if (process.status === "running") {
      job.state = "running";
      job.lifecycle = "working";
    } else if (["completed", "failed", "killed"].includes(process.status)) {
      job.state = "exited";
      job.lifecycle =
        process.status === "completed"
          ? "review"
          : process.status === "killed"
            ? "stopped"
            : "failed";
    } else {
      job.state = "unknown";
      job.lifecycle = "unknown";
    }
    job.notice = observed;
  }
  function publicJob(job) {
    const keys = [
      "id",
      "state",
      "lifecycle",
      "worktree",
      "workspaceId",
      "sessionId",
      "executionProcessId",
      "processStatus",
      "notice",
      "stage",
    ];
    const receipt = Object.fromEntries(
      keys
        .filter((key) => job[key] !== undefined)
        .map((key) => [key, job[key]]),
    );
    if (job.workspaceId)
      receipt.webUrl =
        browser +
        "/workspaces/" +
        job.workspaceId +
        "?embed=1" +
        (job.sessionId ? "&sessionId=" + job.sessionId : "");
    return receipt;
  }
  async function checkpoint(job, stage) {
    job.stage = stage;
    await persist(job);
  }
  async function launch(job, spec, configured) {
    await validateProfile(job.executor);
    await checkpoint(job, "registering_repository");
    const registered = await api("/api/repos");
    if (!Array.isArray(registered)) throw Error("Invalid repository list.");
    const matches = registered.filter((repo) => repo.path === configured.path);
    if (matches.length > 1) throw Error("Ambiguous repository registration.");
    const repo = await validateRepo(
      matches[0] || (await api("/api/repos", { path: configured.path })),
      configured,
    );
    job.repoId = repo.id;
    await checkpoint(job, "creating_workspace");
    let workspace = validateWorkspace(
      await api("/api/workspaces", { name: job.identity, use_worktree: true }),
      job,
    );
    job.workspaceId = workspace.id;
    await checkpoint(job, "attaching_repository");
    const attached = await api(`/api/workspaces/${job.workspaceId}/repos`, {
      repo_id: repo.id,
      target_branch: configured.targetBranch,
    });
    workspace = validateWorkspace(attached.workspace, job);
    const attachedRepo = await validateRepo(attached.repo, configured);
    if (attachedRepo.id !== job.repoId)
      throw Error("Attached repository identity mismatch.");
    job.worktree = await worktree(workspace, repo);
    await checkpoint(job, "creating_session");
    const session = validateSession(
      await api("/api/sessions", {
        workspace_id: job.workspaceId,
        executor: job.executor,
        name: job.identity,
      }),
      job,
    );
    job.sessionId = session.id;
    await checkpoint(job, "launching_execution");
    await validateProfile(job.executor);
    const execution = await api(`/api/sessions/${job.sessionId}/follow-up`, {
      prompt: spec,
      executor_config: {
        executor: job.executor,
        variant: executorVariant,
        permission_policy: "SUPERVISED",
        ...(job.agent === "codex" ? { model_id: codexModel } : {}),
      },
    });
    processState(execution, job);
    await checkpoint(job, "execution_recorded");
  }
  // Reconciliation is entirely read-only upstream. It can recover identities;
  // it never finishes an interrupted launch by issuing another mutation.
  async function refresh(job, configured) {
    try {
      if (!job.workspaceId && job.stage === "creating_workspace") {
        const workspaces = await api("/api/workspaces");
        if (!Array.isArray(workspaces)) throw Error("Invalid workspace list.");
        const matches = workspaces.filter(
          (workspace) => workspace.name === job.identity,
        );
        if (matches.length === 1)
          job.workspaceId = validateWorkspace(matches[0], job).id;
      }
      if (job.workspaceId) {
        const workspace = validateWorkspace(
          await api(`/api/workspaces/${job.workspaceId}`),
          job,
        );
        const attached = await api(`/api/workspaces/${job.workspaceId}/repos`);
        if (!Array.isArray(attached) || attached.length > 1)
          throw Error("Workspace repository scope changed.");
        if (attached.length === 1) {
          const repo = await validateRepo(attached[0], configured);
          if (job.repoId && repo.id !== job.repoId)
            throw Error("Workspace repository changed.");
          job.worktree = await worktree(workspace, repo);
        }
        if (!job.sessionId && job.stage === "creating_session") {
          const sessions = await api(
            `/api/sessions?workspace_id=${job.workspaceId}`,
          );
          if (!Array.isArray(sessions)) throw Error("Invalid session list.");
          const matches = sessions.filter(
            (session) => session.name === job.identity,
          );
          if (matches.length === 1)
            job.sessionId = validateSession(matches[0], job).id;
        }
      }
      if (job.executionProcessId) {
        validateSession(await api(`/api/sessions/${job.sessionId}`), job);
        processState(
          await api(`/api/execution-processes/${job.executionProcessId}`),
          job,
        );
      } else {
        job.state = "unknown";
        job.lifecycle = "unknown";
        job.notice = uncertain;
      }
    } catch {
      job.state = "unknown";
      job.lifecycle = "unknown";
      job.notice = uncertain;
    }
    return job;
  }

  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    const expected = Buffer.from("Bearer " + token),
      supplied = Buffer.from(req.headers.authorization || "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return reply(401, { error: "Unauthorized" });
    if (
      req.headers.origin ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      )
    )
      return reply(403, { error: "Loopback server access only" });
    try {
      const match = /^\/jobs\/([0-9a-f-]{36})$/.exec(req.url || "");
      if (req.method === "GET" && match && UUID.test(match[1])) {
        let job;
        try {
          job = await read(match[1]);
        } catch (error) {
          if (error.code === "ENOENT")
            return reply(404, {
              error: "Unknown job. Inspect cdesktop before dispatching again.",
            });
          throw error;
        }
        const configured = approved.get(job.repo);
        if (
          !configured ||
          configured.path !== job.repoPath ||
          configured.targetBranch !== job.targetBranch
        )
          return reply(403, { error: "Repository access changed" });
        if (!(await acquire(job.id)))
          return reply(
            200,
            publicJob({
              ...job,
              state: "unknown",
              lifecycle: "unknown",
              notice:
                "Launch or inspection is in progress, or an interrupted operation requires inspection. No retry was submitted.",
            }),
          );
        try {
          await refresh(job, configured);
          await persist(job);
          return reply(200, publicJob(job));
        } finally {
          await release(job.id);
        }
      }
      if (req.url !== "/jobs" || req.method !== "POST")
        return reply(404, { error: "Not found" });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > 100000) return reply(413, { error: "Request too large" });
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return reply(400, { error: "Invalid JSON" });
      }
      if (
        !input ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !["id", "repo", "agent", "spec", "mode"].includes(key),
        )
      )
        return reply(400, { error: "Invalid worker request" });
      const { id, repo, agent, spec, mode } = input;
      if (
        !UUID.test(id || "") ||
        !approved.has(repo) ||
        !["codex", "claude"].includes(agent) ||
        typeof spec !== "string" ||
        !spec.trim() ||
        spec.length > 50000 ||
        (mode !== undefined && mode !== "direct")
      )
        return reply(400, { error: "Invalid or unapproved worker request" });
      const configured = approved.get(repo);
      const fingerprint = sha({
        repo,
        repoPath: configured.path,
        targetBranch: configured.targetBranch,
        agent,
        spec,
        mode: mode || "direct",
      });
      if (!(await acquire(id)))
        return reply(409, {
          error:
            "Job operation is in progress or its recovery lock requires inspection.",
        });
      try {
        let previous;
        try {
          previous = await read(id);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return reply(409, {
              error: "Job ID already used for a different request",
            });
          await refresh(previous, configured);
          await persist(previous);
          return reply(200, publicJob(previous));
        }
        const job = {
          id,
          repo,
          repoPath: configured.path,
          targetBranch: configured.targetBranch,
          agent,
          executor: agent === "codex" ? "CODEX" : "CLAUDE_CODE",
          fingerprint,
          promptHash: sha(spec),
          identity: `tencent-${marker.namespace}-${id}`,
          state: "launching",
          lifecycle: "starting",
          stage: "reserved",
        };
        await durableWrite(file(id), job, true);
        try {
          await launch(job, spec, configured);
        } catch {
          job.state = "unknown";
          job.lifecycle = "unknown";
          job.notice = uncertain;
          await persist(job);
        }
        return reply(200, publicJob(job));
      } finally {
        await release(id);
      }
    } catch {
      return reply(500, {
        error:
          "Runner operation failed. Inspect cdesktop locally before dispatching again.",
      });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = JSON.parse(
    await readFile(process.env.CDESKTOP_RUNNER_CONFIG, "utf8"),
  );
  const host = config.host || "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(host))
    throw Error("The cdesktop bridge must bind to loopback.");
  if (
    config.port !== undefined &&
    (!Number.isSafeInteger(config.port) ||
      config.port < 1 ||
      config.port > 65535)
  )
    throw Error("Invalid runner port.");
  const server = await createCdesktopBridge({
    ...config,
    root: config.dataDir,
  });
  server.listen(config.port || 8793, host, () =>
    console.log("cdesktop Workbench runner listening on loopback."),
  );
}
