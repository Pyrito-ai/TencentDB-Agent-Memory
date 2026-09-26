import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBridge } from "./runner.mjs";
test("private runner enforces allowlist, persists idempotency, and reads the Orca envelope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orca-bridge-"));
  const calls = [];
  const responseLocks = [];
  const token = "x".repeat(32);
  const command = async (args) => {
    calls.push(args);
    return args[0] === "worktree"
      ? { worktree: { id: "wt1" }, agentTerminalHandle: "term1" }
      : { terminal: { status: "running", tail: ["evidence line"] } };
  };
  let server;
  let base;
  async function start() {
    server = await createBridge({
      native: false,
      token,
      root,
      repos: ["id:repo"],
      command,
    });
    // Observe the exact response boundary, so the regression does not depend
    // on a client retry winning a race against asynchronous lock removal.
    server.prependListener("request", (_req, res) => {
      const end = res.end;
      res.end = function (...args) {
        if (res.statusCode === 200)
          responseLocks.push(
            readdirSync(root).some((name) => name.endsWith(".lock")),
          );
        return end.apply(this, args);
      };
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((r) => server.close(r));
  }
  async function post(data, auth = token) {
    return fetch(base + "/jobs", {
      method: "POST",
      headers: { Authorization: "Bearer " + auth },
      body: JSON.stringify(data),
    });
  }
  try {
    await start();
    const input = {
      id: randomUUID(),
      repo: "id:repo",
      agent: "codex",
      spec: "Literal $(touch /tmp/no) task prompt",
    };
    assert.equal((await post(input, "bad")).status, 401);
    assert.equal(
      (await post({ ...input, repo: "/arbitrary/path" })).status,
      400,
    );
    const first = await (await post(input)).json();
    assert.equal(first.state, "running");
    assert.equal(
      responseLocks.at(-1),
      false,
      "release the job lock before acknowledging launch",
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes(input.spec));
    assert.ok(calls[0].includes("--no-parent"));
    assert.equal((await post(input)).status, 200);
    assert.equal(calls.length, 1);
    assert.equal((await post({ ...input, spec: "other" })).status, 409);
    await stop();
    await start();
    assert.equal((await post(input)).status, 200);
    assert.equal(calls.length, 1);
    const read = await (
      await fetch(base + "/jobs/" + input.id, {
        headers: { Authorization: "Bearer " + token },
      })
    ).json();
    assert.equal(read.output, "evidence line");
    assert.equal(read.state, "running");
    assert.equal(read.fingerprint, undefined);
    assert.deepEqual(responseLocks, [false, false, false, false]);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
test("uncertain command outcomes are persisted, never automatically retried", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orca-bridge-"));
  let calls = 0;
  const token = "y".repeat(32);
  const server = await createBridge({
    native: false,
    token,
    root,
    repos: ["id:r"],
    command: async () => {
      calls++;
      throw Error("sensitive diagnostics");
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = {
      id: randomUUID(),
      repo: "id:r",
      agent: "claude",
      spec: "Task",
    };
    for (let i = 0; i < 2; i++) {
      const r = await fetch(base + "/jobs", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      assert.ok(!text.includes("sensitive"));
      assert.equal(JSON.parse(text).state, "unknown");
    }
    assert.equal(calls, 1);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("worker follow-ups verify identity and are never replayed; stop preserves worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orca-control-"));
  const calls = [];
  const token = "z".repeat(32);
  let identity = "codex";
  const command = async (args) => {
    calls.push(args);
    if (args[0] === "worktree")
      return { worktree: { id: "wt1" }, agentTerminalHandle: "term1" };
    if (args[1] === "show")
      return { terminal: { writable: true, agentIdentity: identity } };
    if (args[1] === "send") return { send: { accepted: true } };
    if (args[1] === "close") return { close: { ptyKilled: true } };
    throw Error("unexpected command");
  };
  const server = await createBridge({
    native: false,
    token,
    root,
    repos: ["id:r"],
    command,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) =>
    fetch(base + url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
  try {
    const id = randomUUID();
    await post("/jobs", { id, repo: "id:r", agent: "codex", spec: "Task" });
    const body = {
      operation: randomUUID(),
      text: "Please add the missing check.",
    };
    await post(`/jobs/${id}/send`, body);
    await post(`/jobs/${id}/send`, body);
    assert.equal(calls.filter((a) => a[1] === "send").length, 1);
    assert.ok(calls.find((a) => a[1] === "send").includes("--wait-submit"));
    const stopped = await (
      await post(`/jobs/${id}/stop`, { operation: randomUUID() })
    ).json();
    assert.equal(stopped.state, "exited");
    assert.equal(stopped.worktree, "wt1");
    const other = randomUUID();
    await post("/jobs", {
      id: other,
      repo: "id:r",
      agent: "codex",
      spec: "Task",
    });
    identity = undefined;
    const refused = await (
      await post(`/jobs/${other}/send`, {
        operation: randomUUID(),
        text: "Never send to a shell",
      })
    ).json();
    assert.equal(refused.state, "unknown");
    assert.equal(calls.filter((a) => a[1] === "send").length, 1);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("native jobs keep durable identities private, replay once across bridge instances, and retain failed launch receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orca-native-http-"));
  const token = "n".repeat(32),
    calls = [];
  const command = async (args) => {
    calls.push(args);
    switch (args.slice(0, 2).join(" ")) {
      case "worktree list":
        return {
          worktrees: [
            {
              id: "r::/repo",
              repoId: "r",
              isMainWorktree: true,
              hostId: "local",
            },
          ],
        };
      case "repo show":
        return { repo: { id: "r", path: "/repo" } };
      case "terminal show":
        return { terminal: { handle: "controller", connected: true } };
      case "terminal create":
        return { terminal: { handle: "controller", paneKey: "pane" } };
      case "orchestration run-create":
        return { run: { id: "run" } };
      case "orchestration task-create":
        return { task: { id: "task", run_id: "run" } };
      case "orchestration worker-start":
        return {
          runId: "run",
          taskId: "task",
          dispatchId: "dispatch",
          state: "failed",
          failedStage: "dispatch_input",
          residualResources: [{ kind: "terminal", id: "worker" }],
        };
      case "orchestration worker-show":
        return {
          dispatch: {
            id: "dispatch",
            run_id: "run",
            task_id: "task",
            status: "failed",
          },
          worker: {
            dispatch_id: "dispatch",
            state: "failed",
            agent_terminal_handle: "worker",
          },
          observation: { status: "live" },
        };
      case "orchestration worker-read":
        return { dispatchId: "dispatch", terminal: { tail: ["blocked"] } };
      case "orchestration check":
        return { runId: "run", messages: [] };
      default:
        throw Error("unexpected");
    }
  };
  const servers = await Promise.all(
    [1, 2].map(() => createBridge({ token, root, repos: ["id:r"], command })),
  );
  await Promise.all(
    servers.map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))),
  );
  const input = {
    id: randomUUID(),
    repo: "id:r",
    agent: "claude",
    spec: "spec",
  };
  const post = (s) =>
    fetch(`http://127.0.0.1:${s.address().port}/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
  try {
    const concurrent = await Promise.all(servers.map(post));
    assert.ok(concurrent.some((r) => r.status === 200));
    assert.ok(concurrent.some((r) => r.status === 409));
    const receipt = await (await post(servers[0])).json();
    assert.equal(receipt.native.dispatchId, "dispatch");
    assert.equal(receipt.native.launchState, "failed");
    assert.equal(receipt.lifecycle, "failed");
    assert.equal(receipt.state, "unknown");
    assert.equal(receipt.controller, undefined);
    assert.equal(receipt.nativeJournal, undefined);
    const operation = randomUUID();
    const send = await fetch(
      `http://127.0.0.1:${servers[0].address().port}/jobs/${input.id}/send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ operation, text: "Continue" }),
      },
    );
    const refused = await send.json();
    assert.deepEqual(refused.lastOperation, {
      id: operation,
      action: "send",
      status: "refused",
    });
    assert.equal(refused.lifecycle, "failed");
    assert.match(refused.notice, /cannot resume/);
    assert.equal(calls.filter((a) => a[1] === "worker-start").length, 1);
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await rm(root, { recursive: true, force: true });
  }
});

test("continuation accepts full approved task context up to launch specification limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orca-large-continuation-"));
  const token = "c".repeat(32),
    id = randomUUID();
  let taskId = "original-task",
    dispatchId = "original-dispatch",
    receivedSpec;
  const job = {
    id,
    repo: "id:r",
    agent: "codex",
    state: "running",
    lifecycle: "review",
    controller: "controller",
    worktree: "r::workspace",
    directory: root,
    host: "local",
    native: { runId: "run", taskId, dispatchId },
  };
  await writeFile(path.join(root, id + ".json"), JSON.stringify(job));
  const command = async (args) => {
    switch (args.slice(0, 2).join(" ")) {
      case "orchestration worker-show":
        return {
          dispatch: {
            id: dispatchId,
            runId: "run",
            taskId,
            status:
              dispatchId === "original-dispatch" ? "completed" : "dispatched",
          },
          worker: { dispatchId, worktreeId: "r::workspace" },
          observation: { status: "live" },
        };
      case "worktree show":
        return {
          worktree: {
            id: "r::workspace",
            repoId: "r",
            hostId: "local",
            path: root,
          },
        };
      case "terminal show":
        return { terminal: { handle: "controller", connected: true } };
      case "orchestration task-create":
        receivedSpec = args[args.indexOf("--spec") + 1];
        return { task: { id: "revision-task", run_id: "run" } };
      case "orchestration worker-start":
        taskId = "revision-task";
        dispatchId = "revision-dispatch";
        return { runId: "run", taskId, dispatchId, state: "ready" };
      case "orchestration worker-read":
        return { dispatchId, terminal: { tail: [] } };
      case "orchestration check":
        return { runId: "run", messages: [] };
      default:
        throw Error("Unexpected command");
    }
  };
  const server = await createBridge({ token, root, repos: ["id:r"], command });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = (spec) =>
    fetch(`http://127.0.0.1:${server.address().port}/jobs/${id}/continue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation: randomUUID(), spec }),
    });
  const context =
    "Approved revision: simplify header.\nAcceptance: preserve keyboard navigation.\nWiki context: " +
    "Context excerpt with project decisions. ".repeat(1500);
  const spec = context.slice(0, 50000);
  try {
    assert.equal(spec.length, 50000);
    const response = await post(spec);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.lastOperation.status, "accepted");
    assert.equal(receipt.native.dispatchId, "revision-dispatch");
    assert.equal(receivedSpec, spec);
    assert.equal((await post(spec + "x")).status, 400);
    assert.equal((await post("x".repeat(100001))).status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("direct mode uses worktree CLI even with native orchestration enabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orca-direct-"));
  const calls = [];
  const server = await createBridge({
    token: "x".repeat(32),
    root,
    repos: ["id:repo"],
    command: async (args) => {
      calls.push(args);
      return { worktree: { id: "fresh" }, agentTerminalHandle: "agent" };
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/jobs`;
  const body = {
    id: randomUUID(),
    repo: "id:repo",
    agent: "claude",
    spec: "Approved task",
    mode: "direct",
  };
  const send = (b) =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + "x".repeat(32) },
      body: JSON.stringify(b),
    });
  try {
    assert.equal((await send(body)).status, 200);
    assert.equal((await send(body)).status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ["worktree", "create"]);
    assert.ok(calls[0].includes("--no-parent"));
    assert.ok(calls[0].includes("Approved task"));
    assert.equal((await send({ ...body, mode: undefined })).status, 409);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
