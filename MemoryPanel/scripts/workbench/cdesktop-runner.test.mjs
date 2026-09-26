import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCdesktopBridge } from "./cdesktop-runner.mjs";

const token = "c".repeat(48);
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    );
  });
const close = (server) => new Promise((resolve) => server.close(resolve));

async function fixture(t, options = {}) {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "cdesktop-bridge-")),
  );
  const root = path.join(base, "receipts"),
    source = path.join(base, "source"),
    container = path.join(base, "cdesktop-worktrees", randomUUID());
  await Promise.all([
    mkdir(root),
    mkdir(source),
    mkdir(path.join(container, "repo"), { recursive: true }),
  ]);
  const input = {
    id: randomUUID(),
    repo: "trial-repo",
    agent: "codex",
    spec: "Exact prompt\nLiteral $(touch /tmp/never-executed) and `shell` syntax.\n",
    mode: "direct",
  };
  const repo = {
    id: randomUUID(),
    path: source,
    name: "repo",
    is_git: true,
    setup_script: null,
    cleanup_script: null,
    archive_script: null,
    copy_files: null,
    ...options.repo,
  };
  let registered = false,
    workspace,
    session,
    process,
    attached = false;
  const calls = [],
    errors = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, url: req.url, body });
    const reply = (data) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data }));
    };
    try {
      if (req.url === "/api/profiles") {
        const profiles = {
          executors: {
            CODEX: {
              WORKBENCH: {
                CODEX: {
                  sandbox: "workspace-write",
                  ask_for_approval: "on-request",
                  plan: false,
                },
              },
            },
            CLAUDE_CODE: {
              WORKBENCH: {
                CLAUDE_CODE: {
                  dangerously_skip_permissions: false,
                  approvals: true,
                  disable_api_key: true,
                  claude_code_router: false,
                },
              },
            },
          },
        };
        if (options.unsafeProfile)
          profiles.executors.CODEX.WORKBENCH.CODEX.sandbox =
            "danger-full-access";
        if (options.missingProfile) delete profiles.executors.CODEX.WORKBENCH;
        if (
          options.changeProfile &&
          calls.filter((call) => call.url === "/api/profiles").length > 1
        )
          profiles.executors.CODEX.WORKBENCH.CODEX.ask_for_approval = "never";
        return reply({ content: JSON.stringify(profiles) });
      }
      if (req.method === "POST") {
        const stage =
          req.url === "/api/repos"
            ? "registering_repository"
            : req.url === "/api/workspaces"
              ? "creating_workspace"
              : req.url.endsWith("/repos")
                ? "attaching_repository"
                : req.url === "/api/sessions"
                  ? "creating_session"
                  : "launching_execution";
        const journal = JSON.parse(
          await readFile(path.join(root, input.id + ".json"), "utf8"),
        );
        assert.equal(
          journal.stage,
          stage,
          "durable checkpoint exists before every mutation",
        );
        if (
          [
            "attaching_repository",
            "creating_session",
            "launching_execution",
          ].includes(stage)
        )
          assert.equal(journal.workspaceId, workspace.id);
        if (stage === "launching_execution")
          assert.equal(journal.sessionId, session.id);
      }
      if (req.url === "/api/repos") {
        if (req.method === "GET") return reply(registered ? [repo] : []);
        assert.deepEqual(body, { path: source });
        registered = true;
        return reply(repo);
      }
      if (req.url === "/api/workspaces") {
        if (req.method === "GET") return reply(workspace ? [workspace] : []);
        assert.equal(body.use_worktree, true);
        workspace = {
          id: randomUUID(),
          name: body.name,
          use_worktree: true,
          container_ref: null,
          branch: "cdesktop/test-branch",
        };
        if (options.dropWorkspace) return req.socket.destroy();
        return reply(workspace);
      }
      if (workspace && req.url === `/api/workspaces/${workspace.id}`)
        return reply(workspace);
      if (workspace && req.url === `/api/workspaces/${workspace.id}/repos`) {
        if (req.method === "GET")
          return reply(attached ? [{ ...repo, target_branch: "main" }] : []);
        assert.deepEqual(body, { repo_id: repo.id, target_branch: "main" });
        attached = true;
        workspace.container_ref = container;
        return reply({ workspace, repo: { ...repo, target_branch: "main" } });
      }
      if (req.url === "/api/sessions") {
        assert.equal(body.workspace_id, workspace.id);
        session = {
          id: randomUUID(),
          workspace_id: workspace.id,
          executor: body.executor,
          name: body.name,
        };
        if (options.dropSession) return req.socket.destroy();
        return reply(session);
      }
      if (workspace && req.url === `/api/sessions?workspace_id=${workspace.id}`)
        return reply(session ? [session] : []);
      if (session && req.url === `/api/sessions/${session.id}`)
        return reply(session);
      if (session && req.url === `/api/sessions/${session.id}/follow-up`) {
        process = {
          id: randomUUID(),
          session_id: session.id,
          status: "running",
          run_reason: "codingagent",
          executor_action: {
            typ: {
              type: "CodingAgentInitialRequest",
              prompt: body.prompt,
              executor_config: body.executor_config,
            },
            next_action: null,
          },
        };
        if (options.malformedProcess) delete process.executor_action.typ.prompt;
        if (options.dropLaunch) return req.socket.destroy();
        if (options.delayLaunch)
          await new Promise((resolve) =>
            setTimeout(resolve, options.delayLaunch),
          );
        return reply(process);
      }
      if (process && req.url === `/api/execution-processes/${process.id}`)
        return reply(process);
      throw Error("Unexpected mock endpoint: " + req.url);
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end("sensitive upstream diagnostic");
    }
  });
  const cdesktopUrl = await listen(upstream);
  const config = {
    token,
    root,
    repos: [{ id: input.repo, path: source, targetBranch: "main" }],
    cdesktopUrl,
  };
  let bridge = await createCdesktopBridge(config),
    url = await listen(bridge);
  const request = (route, body, headers = {}) =>
    fetch(url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const restart = async () => {
    await close(bridge);
    bridge = await createCdesktopBridge(config);
    url = await listen(bridge);
  };
  t.after(async () => {
    await close(bridge);
    await close(upstream);
    await rm(base, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return {
    input,
    config,
    calls,
    root,
    source,
    container,
    request,
    restart,
    get url() {
      return url;
    },
    get workspace() {
      return workspace;
    },
    get session() {
      return session;
    },
    get process() {
      return process;
    },
  };
}

test("bridge requires bearer authentication and a server-owned allowlist without CORS", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("/jobs", f.input, { Authorization: "Bearer wrong" }))
      .status,
    401,
  );
  const crossOrigin = await f.request("/jobs", f.input, {
    Origin: "https://untrusted.example",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);
  for (const changed of [
    { repo: f.source },
    { repo: "other-repo" },
    { path: f.source },
    { url: "http://127.0.0.1:1" },
    { mode: "yolo" },
    { id: "../" },
    { agent: "other" },
    { spec: " " },
  ]) {
    assert.equal(
      (await f.request("/jobs", { ...f.input, ...changed })).status,
      400,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("staged launch uses one isolated worktree, exact prompt, explicit permissions, and durable receipts", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/jobs", f.input);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.state, "running");
  assert.equal(receipt.worktree, path.join(f.container, "repo"));
  assert.notEqual(receipt.worktree, f.source);
  assert.equal(receipt.workspaceId, f.workspace.id);
  assert.equal(receipt.sessionId, f.session.id);
  assert.equal(receipt.executionProcessId, f.process.id);
  assert.equal(
    receipt.webUrl,
    `${f.config.cdesktopUrl}/workspaces/${f.workspace.id}?embed=1&sessionId=${f.session.id}`,
  );
  assert.equal(receipt.fingerprint, undefined);
  assert.equal(receipt.repoPath, undefined);
  const launch = f.calls.find((call) => call.url.endsWith("/follow-up"));
  assert.deepEqual(launch.body, {
    prompt: f.input.spec,
    executor_config: {
      executor: "CODEX",
      variant: "WORKBENCH",
      permission_policy: "SUPERVISED",
      model_id: "gpt-5.6-sol",
    },
  });
  assert.equal(launch.body.selected_provider_id, undefined);
  const journal = JSON.parse(
    await readFile(path.join(f.root, f.input.id + ".json"), "utf8"),
  );
  assert.equal(journal.sessionId, f.session.id);
  assert.equal(journal.stage, "execution_recorded");
  assert.ok(!JSON.stringify(journal).includes(f.input.spec));
  f.process.status = "completed";
  const settled = await (await f.request(`/jobs/${f.input.id}`)).json();
  assert.equal(settled.state, "exited");
  assert.equal(settled.lifecycle, "review");
  assert.match(settled.notice, /not task acceptance/);
});

test("same job is not replayed across retries or restarts, and changed requests conflict", async (t) => {
  const f = await fixture(t);
  await f.request("/jobs", f.input);
  const mutations = () => f.calls.filter((call) => call.method === "POST");
  assert.equal(mutations().length, 5);
  assert.equal((await f.request("/jobs", f.input)).status, 200);
  await f.restart();
  assert.equal((await f.request("/jobs", f.input)).status, 200);
  assert.equal(
    (await f.request("/jobs", { ...f.input, spec: "different prompt" })).status,
    409,
  );
  assert.equal(mutations().length, 5);
});

test("concurrent same-id launches submit only one execution", async (t) => {
  const f = await fixture(t, { delayLaunch: 75 });
  const responses = await Promise.all([
    f.request("/jobs", f.input),
    f.request("/jobs", f.input),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );
  assert.equal(
    f.calls.filter((call) => call.url.endsWith("/follow-up")).length,
    1,
  );
});

test("a dropped execution response is uncertain and is never resubmitted", async (t) => {
  const f = await fixture(t, { dropLaunch: true });
  const receipt = await (await f.request("/jobs", f.input)).json();
  assert.equal(receipt.state, "unknown");
  assert.equal(receipt.stage, "launching_execution");
  assert.ok(receipt.sessionId);
  assert.ok(receipt.webUrl);
  assert.equal(receipt.executionProcessId, undefined);
  await f.restart();
  const retry = await (await f.request("/jobs", f.input)).json();
  assert.equal(retry.state, "unknown");
  assert.match(retry.notice, /will not be submitted again/);
  assert.equal(
    f.calls.filter((call) => call.url.endsWith("/follow-up")).length,
    1,
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 5);
});

test("lost workspace and session creation responses reconcile by unique identity without new side effects", async (t) => {
  for (const stage of ["dropWorkspace", "dropSession"]) {
    await t.test(stage, async (t) => {
      const f = await fixture(t, { [stage]: true });
      assert.equal(
        (await (await f.request("/jobs", f.input)).json()).state,
        "unknown",
      );
      const count = f.calls.filter((call) => call.method === "POST").length;
      await f.restart();
      const recovered = await (await f.request(`/jobs/${f.input.id}`)).json();
      assert.equal(recovered.workspaceId, f.workspace.id);
      if (stage === "dropSession")
        assert.equal(recovered.sessionId, f.session.id);
      assert.equal(recovered.state, "unknown");
      assert.equal(
        f.calls.filter((call) => call.method === "POST").length,
        count,
      );
    });
  }
});

test("Claude uses its subscription executor with supervised permissions and no model override", async (t) => {
  const f = await fixture(t);
  f.input.agent = "claude";
  const receipt = await (await f.request("/jobs", f.input)).json();
  assert.equal(receipt.state, "running");
  assert.deepEqual(
    f.calls.find((call) => call.url.endsWith("/follow-up")).body
      .executor_config,
    {
      executor: "CLAUDE_CODE",
      variant: "WORKBENCH",
      permission_policy: "SUPERVISED",
    },
  );
});

test("configured scripts or copied files prevent a clean-worktree launch", async (t) => {
  const f = await fixture(t, { repo: { copy_files: ".env" } });
  const receipt = await (await f.request("/jobs", f.input)).json();
  assert.equal(receipt.state, "unknown");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  assert.ok(!f.workspace);
});

test("bridge refuses remote endpoints and any existing foreign runner state", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () =>
      createCdesktopBridge({ ...f.config, cdesktopUrl: "https://example.com" }),
    /loopback/,
  );
  await assert.rejects(
    () =>
      createCdesktopBridge({
        ...f.config,
        cdesktopUrl: f.config.cdesktopUrl + "/api",
      }),
    /loopback/,
  );
  const other = path.join(path.dirname(f.root), "orca-state");
  await mkdir(other);
  await writeFile(path.join(other, "existing-orca-receipt.json"), "{}");
  await assert.rejects(
    () => createCdesktopBridge({ ...f.config, root: other }),
    /existing non-cdesktop/,
  );
  await assert.rejects(
    () => createCdesktopBridge({ ...f.config, root: f.source }),
    /separate directories/,
  );
});

test("missing or unsafe profiles fail closed, including a change just before execution", async (t) => {
  for (const option of ["missingProfile", "unsafeProfile", "changeProfile"]) {
    await t.test(option, async (t) => {
      const f = await fixture(t, { [option]: true });
      const receipt = await (await f.request("/jobs", f.input)).json();
      assert.equal(receipt.state, "unknown");
      assert.equal(
        f.calls.filter((call) => call.url.endsWith("/follow-up")).length,
        0,
      );
      if (option !== "changeProfile")
        assert.equal(
          f.calls.filter((call) => call.method === "POST").length,
          0,
        );
    });
  }
});

test("split UTF-8 bytes preserve the exact approved prompt", async (t) => {
  const f = await fixture(t);
  f.input.spec = "Keep exactly: café 🍰 東京";
  const data = Buffer.from(JSON.stringify(f.input));
  const split = data.indexOf(Buffer.from("🍰")) + 1;
  const receipt = await new Promise((resolve, reject) => {
    const req = http.request(
      f.url + "/jobs",
      { method: "POST", headers: { Authorization: "Bearer " + token } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(JSON.parse(text)));
      },
    );
    req.on("error", reject);
    req.write(data.subarray(0, split));
    setTimeout(() => req.end(data.subarray(split)), 10);
  });
  assert.equal(receipt.state, "running");
  assert.equal(
    f.calls.find((call) => call.url.endsWith("/follow-up")).body.prompt,
    f.input.spec,
  );
});

test("malformed execution identity is never reported as running", async (t) => {
  const f = await fixture(t, { malformedProcess: true });
  const receipt = await (await f.request("/jobs", f.input)).json();
  assert.equal(receipt.state, "unknown");
  assert.equal(receipt.executionProcessId, undefined);
});
