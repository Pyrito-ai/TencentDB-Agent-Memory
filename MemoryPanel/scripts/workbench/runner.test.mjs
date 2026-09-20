import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBridge } from "./runner.mjs";
test("private runner enforces allowlist, persists idempotency, and reads the Orca envelope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orca-bridge-"));
  const calls = [];
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
    server = await createBridge({ token, root, repos: ["id:repo"], command });
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
  const server = await createBridge({ token, root, repos: ["id:r"], command });
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
