import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeOrca } from "./native-orca.mjs";

function fixture() {
  const calls = [],
    snapshots = [];
  const job = { id: "job", repo: "id:repo", agent: "codex" };
  let acked = false;
  const command = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    if (key === "worktree list")
      return {
        worktrees: [
          {
            id: "repo::/exact/repo",
            repoId: "repo",
            isMainWorktree: true,
            hostId: "local",
          },
        ],
      };
    if (key === "repo show")
      return { repo: { id: "repo", path: "/exact/repo" } };
    if (key === "terminal show")
      return { terminal: { handle: job.controller, connected: true } };
    if (key === "terminal create")
      return { terminal: { handle: "controller", paneKey: "pane" } };
    if (key === "orchestration run-create") return { run: { id: "run" } };
    if (key === "orchestration task-create")
      return { task: { id: "task", run_id: "run" } };
    if (key === "orchestration worker-start")
      return {
        runId: "run",
        taskId: "task",
        dispatchId: "dispatch",
        state: "ready",
      };
    if (key === "orchestration worker-show")
      return {
        dispatch: {
          id: "dispatch",
          runId: "run",
          taskId: "task",
          status: "dispatched",
        },
        worker: { dispatchId: "dispatch", agentTerminalHandle: "worker" },
        observation: { status: "live" },
      };
    if (key === "orchestration worker-read")
      return { dispatchId: "dispatch", terminal: { tail: ["output"] } };
    if (key === "orchestration check") {
      if (args.includes("--ack")) {
        assert.ok(
          snapshots.some((j) => j.events?.some((e) => e.id === "msg")),
          "message persisted before ack",
        );
        acked = true;
        return { acknowledged: "delivery", runId: "run", messages: [] };
      }
      return {
        runId: "run",
        deliveryId: acked ? null : "delivery",
        messages: acked
          ? []
          : [{ id: "msg", run_id: "run", type: "status", body: "progress" }],
      };
    }
    if (key === "orchestration send")
      return {
        message: { id: "sent", run_id: "run", to_handle: "dispatch:dispatch" },
      };
    if (key === "orchestration worker-stop")
      return {
        dispatchId: "dispatch",
        state: "stopped",
        processAction: "closed_agent_terminal",
      };
    if (key === "terminal close") return { close: { ptyKilled: true } };
    throw Error(`Unexpected ${key}`);
  };
  const persist = async (j) => snapshots.push(structuredClone(j));
  return { job, command, persist, calls, snapshots };
}

test("native launch owns its controller, uses task/start IDs, and persists inbox before ack", async () => {
  const f = fixture(),
    runner = nativeOrca(f);
  await runner.launch(f.job, "literal $(prompt)");
  assert.equal(f.job.state, "running");
  assert.equal(f.job.output, "output");
  assert.equal(f.job.native.dispatchId, "dispatch");
  assert.ok(
    f.calls.find((a) => a[1] === "create").includes("id:repo::/exact/repo"),
  );
  assert.ok(!f.calls.flat().includes("--focus"));
  assert.ok(
    f.calls.find((a) => a[1] === "task-create").includes("literal $(prompt)"),
  );
  const starts = f.calls.filter((a) => a[1] === "worker-start");
  assert.equal(starts.length, 1);
  assert.ok(starts[0].includes("--retry-request"));
  await runner.launch(f.job, "literal $(prompt)");
  assert.equal(f.calls.filter((a) => a[1] === "worker-start").length, 1);
  assert.equal(f.job.events.length, 1);
});

test("uncertain native mutation replays exact request while controller create never repeats", async () => {
  const f = fixture();
  let fail = true;
  const command = async (args) => {
    const result = await f.command(args);
    if (args[1] === "worker-start" && fail) {
      fail = false;
      throw Error("lost reply");
    }
    return result;
  };
  const runner = nativeOrca({ ...f, command });
  await assert.rejects(runner.launch(f.job, "spec"));
  await runner.launch(f.job, "spec");
  const attempts = f.calls.filter((a) => a[1] === "worker-start");
  assert.deepEqual(attempts[0], attempts[1]);
  const g = fixture();
  const uncertain = nativeOrca({
    ...g,
    command: async (args) => {
      if (args[1] === "create") throw Error();
      return g.command(args);
    },
  });
  await assert.rejects(uncertain.launch(g.job, "spec"));
  const count = g.calls.length;
  await assert.rejects(uncertain.launch(g.job, "spec"));
  assert.equal(g.calls.length, count);
});

test("follow-up mailbox and confirmed native stop target only the owned dispatch", async () => {
  const f = fixture(),
    runner = nativeOrca(f);
  await runner.launch(f.job, "spec");
  await runner.control(f.job, "send", { operation: "send-id", text: "hello" });
  await runner.control(f.job, "send", { operation: "send-id", text: "hello" });
  assert.equal(f.calls.filter((a) => a[1] === "send").length, 1);
  assert.ok(f.calls.find((a) => a[1] === "send").includes("dispatch:dispatch"));
  await runner.control(f.job, "stop", { operation: "stop-id" });
  assert.equal(f.job.stopped, true);
  assert.equal(f.job.controllerClosed, true);
  assert.ok(!f.calls.some((a) => a[0] === "worktree" && a[1] === "rm"));
});

test("wrong dispatch rejected and lost contact never implies exit", async () => {
  const f = fixture(),
    runner = nativeOrca(f);
  await runner.launch(f.job, "spec");
  const wrong = nativeOrca({
    ...f,
    command: async () => ({ worker: { dispatchId: "other" } }),
  });
  await assert.rejects(wrong.refresh(f.job));
  const unknown = nativeOrca({
    ...f,
    command: async (args) => {
      const result = await f.command(args);
      if (args[1] === "worker-show")
        result.observation = { status: "unverifiable" };
      return result;
    },
  });
  await unknown.refresh(f.job);
  assert.equal(f.job.state, "unknown");
});

test("installed snake-case failed worker in live shell is failed, never working", async () => {
  const f = fixture(),
    runner = nativeOrca(f);
  await runner.launch(f.job, "spec");
  const installed = nativeOrca({
    ...f,
    command: async (args) => {
      if (args[1] === "worker-show")
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
          observation: { status: "live", exactWorker: true, agentWait: null },
        };
      return f.command(args);
    },
  });
  await installed.refresh(f.job);
  assert.equal(f.job.lifecycle, "failed");
  assert.equal(f.job.state, "unknown");
});

test("positive controller exit rebinds existing Run without launching another worker", async () => {
  const f = fixture(),
    runner = nativeOrca(f);
  await runner.launch(f.job, "spec");
  const recovered = nativeOrca({
    ...f,
    command: async (args) => {
      if (
        args[0] === "terminal" &&
        args[1] === "show" &&
        f.job.controller === "controller"
      )
        return { terminal: { handle: "controller", connected: false } };
      if (args[0] === "terminal" && args[1] === "create")
        return {
          terminal: { handle: "replacement", paneKey: "replacement-pane" },
        };
      if (args[1] === "run-use") {
        f.calls.push(args);
        return { run: { id: "run" } };
      }
      return f.command(args);
    },
  });
  await recovered.refresh(f.job);
  assert.equal(f.job.controller, "replacement");
  assert.equal(f.calls.filter((a) => a[1] === "run-use").length, 1);
  assert.equal(f.calls.filter((a) => a[1] === "worker-start").length, 1);
});

test("mailbox persistence failure never acknowledges delivery", async () => {
  const f = fixture();
  const runner = nativeOrca({
    ...f,
    persist: async (job) => {
      if (job.events?.length) throw Error("disk full");
      await f.persist(job);
    },
  });
  await assert.rejects(runner.launch(f.job, "spec"));
  assert.ok(!f.calls.some((args) => args.includes("--ack")));
});

test("native pending question replies are scoped, idempotent, and marked answered only from confirmed receipt", async () => {
  const f = fixture();
  const command = async (args) => {
    if (args[1] === "reply") {
      f.calls.push(args);
      return {
        message: {
          id: "answer",
          run_id: "run",
          to_handle: "dispatch:dispatch",
          thread_id: "msg_question",
        },
        question: {
          message_id: "msg_question",
          run_id: "run",
          dispatch_id: "dispatch",
          status: "answered",
          answer_body: "MARKER",
        },
      };
    }
    const result = await f.command(args);
    if (args[1] === "check" && !args.includes("--ack")) {
      result.messages.push({
        id: "msg_question",
        run_id: "run",
        from_handle: "dispatch:dispatch",
        type: "question",
        body: "Which marker?",
        payload: JSON.stringify({ taskId: "task", dispatchId: "dispatch" }),
      });
    }
    return result;
  };
  const runner = nativeOrca({ ...f, command });
  await runner.launch(f.job, "spec");
  const event = f.job.events.find((e) => e.id === "msg_question");
  assert.equal(event.questionState, "pending");
  await assert.rejects(
    runner.control(f.job, "send", {
      operation: "bad",
      replyTo: "msg_other",
      text: "No",
    }),
  );
  const input = {
    operation: "reply-operation",
    replyTo: "msg_question",
    text: "MARKER",
  };
  await runner.control(f.job, "send", input);
  await runner.control(f.job, "send", input);
  assert.equal(f.calls.filter((args) => args[1] === "reply").length, 1);
  assert.equal(event.questionState, "answered");
  await assert.rejects(
    runner.control(f.job, "send", { ...input, operation: "different" }),
  );
  assert.ok(!f.calls.some((args) => args[1] === "send"));
});

test("question from another dispatch is recorded but cannot be answered through this worker", async () => {
  const f = fixture();
  const runner = nativeOrca({
    ...f,
    command: async (args) => {
      const result = await f.command(args);
      if (args[1] === "check" && !args.includes("--ack"))
        result.messages.push({
          id: "msg_other",
          run_id: "run",
          from_handle: "dispatch:other",
          type: "question",
          payload: { taskId: "task", dispatchId: "other" },
        });
      return result;
    },
  });
  await runner.launch(f.job, "spec");
  assert.equal(
    f.job.events.find((e) => e.id === "msg_other").questionState,
    undefined,
  );
  await assert.rejects(
    runner.control(f.job, "send", {
      operation: "reply",
      replyTo: "msg_other",
      text: "No",
    }),
  );
});

test("completed dispatch cannot be resumed by generic mailbox send", async () => {
  const f = fixture(),
    runner = nativeOrca(f);
  await runner.launch(f.job, "spec");
  const complete = nativeOrca({
    ...f,
    command: async (args) => {
      const result = await f.command(args);
      if (args[1] === "worker-show") result.dispatch.status = "completed";
      return result;
    },
  });
  await assert.rejects(
    complete.control(f.job, "send", {
      operation: "new-message",
      text: "Continue",
    }),
    { code: "native_worker_settled" },
  );
  assert.equal(f.job.lifecycle, "review");
  assert.ok(!f.calls.some((args) => args[1] === "send"));
  assert.match(f.job.notice, /cannot resume/);
});

test("explicit continuation creates child task and new dispatch on exact existing worktree, preserving lineage", async () => {
  const f = fixture();
  await nativeOrca(f).launch(f.job, "spec");
  f.job.worktree = "repo::/worktree";
  let completed = true;
  const command = async (args) => {
    if (args[1] === "worker-show")
      return {
        dispatch: {
          id: f.job.native.dispatchId,
          runId: "run",
          taskId: f.job.native.taskId,
          status: completed ? "completed" : "dispatched",
        },
        worker: {
          dispatchId: f.job.native.dispatchId,
          worktreeId: f.job.worktree,
        },
        observation: { status: "live" },
      };
    if (args[0] === "worktree" && args[1] === "show")
      return {
        worktree: { id: f.job.worktree, repoId: "repo", hostId: "local" },
      };
    if (args[1] === "task-create") {
      f.calls.push(args);
      return { task: { id: "revision", run_id: "run" } };
    }
    if (args[1] === "worker-start") {
      f.calls.push(args);
      completed = false;
      return {
        runId: "run",
        taskId: "revision",
        dispatchId: "dispatch-revision",
        state: "ready",
      };
    }
    if (args[1] === "worker-read")
      return {
        dispatchId: f.job.native.dispatchId,
        terminal: { tail: ["revised"] },
      };
    return f.command(args);
  };
  const runner = nativeOrca({ ...f, command });
  const input = {
    operation: "continue-op",
    spec: "Apply approved review changes",
  };
  await runner.control(f.job, "continue", input);
  assert.equal(f.job.native.dispatchId, "dispatch-revision");
  assert.equal(f.job.attempts[0].native.dispatchId, "dispatch");
  const start = f.calls.filter((args) => args[1] === "worker-start").at(-1);
  assert.ok(start.includes("id:repo::/worktree"));
  assert.ok(!start.includes("--retry-of"));
  assert.ok(!start.includes("new-top-level"));
  await runner.control(f.job, "continue", input);
  assert.equal(f.calls.filter((args) => args[1] === "worker-start").length, 2);
  assert.equal(f.job.attempts.length, 1);
});

test("public native output and persisted events redact dispatch capability tokens", async () => {
  const f = fixture();
  const runner = nativeOrca({
    ...f,
    command: async (args) => {
      const result = await f.command(args);
      if (args[1] === "worker-read")
        result.terminal.tail = [
          "orca --dispatch-capability dcap_SECRET_token_123",
        ];
      if (args[1] === "check" && !args.includes("--ack"))
        result.messages[0].body = "dcap_EVENT_secret";
      return result;
    },
  });
  await runner.launch(f.job, "spec");
  assert.ok(!f.job.output.includes("dcap_"));
  assert.ok(!JSON.stringify(f.job.events).includes("dcap_"));
  assert.match(f.job.output, /redacted dispatch capability/);
});

test("lost continuation receipt freezes old completion and only exact operation can reconcile", async () => {
  const f = fixture();
  await nativeOrca(f).launch(f.job, "spec");
  f.job.worktree = "repo::/worktree";
  let loseResponse = true;
  const command = async (args) => {
    if (args[1] === "worker-show")
      return {
        dispatch: {
          id: f.job.native.dispatchId,
          runId: "run",
          taskId: f.job.native.taskId,
          status: "completed",
        },
        worker: {
          dispatchId: f.job.native.dispatchId,
          worktreeId: f.job.worktree,
        },
        observation: { status: "live" },
      };
    if (args[0] === "worktree" && args[1] === "show")
      return {
        worktree: { id: f.job.worktree, repoId: "repo", hostId: "local" },
      };
    if (args[1] === "task-create")
      return { task: { id: "revision", run_id: "run" } };
    if (args[1] === "worker-start") {
      f.calls.push(args);
      if (loseResponse) {
        loseResponse = false;
        throw Error("lost response");
      }
      return {
        runId: "run",
        taskId: "revision",
        dispatchId: "revision-dispatch",
        state: "ready",
      };
    }
    if (args[1] === "worker-read")
      return { dispatchId: f.job.native.dispatchId, terminal: { tail: [] } };
    return f.command(args);
  };
  const runner = nativeOrca({ ...f, command });
  const input = { operation: "approved-continuation", spec: "Change header" };
  await assert.rejects(runner.control(f.job, "continue", input));
  await runner.refresh(f.job);
  assert.equal(f.job.lifecycle, "unknown");
  await assert.rejects(
    runner.control(f.job, "continue", { ...input, operation: "duplicate" }),
  );
  await runner.control(f.job, "continue", input);
  const starts = f.calls.filter((args) => args[1] === "worker-start");
  assert.deepEqual(starts[1], starts[2]);
  assert.equal(f.job.pendingContinuation, undefined);
  assert.equal(f.job.native.dispatchId, "revision-dispatch");
});

test("replaying an applied old continuation cannot rewind a newer dispatch after refresh failure", async () => {
  const f = fixture();
  await nativeOrca(f).launch(f.job, "spec");
  f.job.worktree = "repo::/worktree";
  let sequence = 0,
    failRefresh = true;
  const command = async (args) => {
    if (args[1] === "worker-show")
      return {
        dispatch: {
          id: f.job.native.dispatchId,
          runId: "run",
          taskId: f.job.native.taskId,
          status: "completed",
        },
        worker: {
          dispatchId: f.job.native.dispatchId,
          worktreeId: f.job.worktree,
        },
        observation: { status: "live" },
      };
    if (args[0] === "worktree" && args[1] === "show")
      return {
        worktree: { id: f.job.worktree, repoId: "repo", hostId: "local" },
      };
    if (args[1] === "task-create") {
      sequence++;
      return { task: { id: `revision-${sequence}`, run_id: "run" } };
    }
    if (args[1] === "worker-start")
      return {
        runId: "run",
        taskId: `revision-${sequence}`,
        dispatchId: `dispatch-${sequence}`,
        state: "ready",
      };
    if (args[1] === "worker-read") {
      if (failRefresh) {
        failRefresh = false;
        throw Error("refresh unavailable after launch");
      }
      return { dispatchId: f.job.native.dispatchId, terminal: { tail: [] } };
    }
    return f.command(args);
  };
  const runner = nativeOrca({ ...f, command });
  const first = { operation: "first", spec: "First revision" };
  await assert.rejects(runner.control(f.job, "continue", first));
  assert.equal(f.job.continuations.first.applied.dispatchId, "dispatch-1");
  await runner.control(f.job, "continue", {
    operation: "second",
    spec: "Second revision",
  });
  assert.equal(f.job.native.dispatchId, "dispatch-2");
  await runner.control(f.job, "continue", first);
  assert.equal(f.job.native.dispatchId, "dispatch-2");
  assert.equal(sequence, 2);
  assert.equal(f.job.attempts.length, 2);
});
