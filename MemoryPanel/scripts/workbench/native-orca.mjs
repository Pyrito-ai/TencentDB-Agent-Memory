import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

export function redactNativeSecrets(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "string"
        ? entry.replace(
            /dcap_[A-Za-z0-9_-]+/g,
            "[redacted dispatch capability]",
          )
        : entry,
    ),
  );
}

export function canReply(job, messageId, operation) {
  const event = job.events?.find((item) => item.id === messageId);
  return !!(
    job.native?.dispatchId &&
    event?.type === "question" &&
    event.runId === job.native.runId &&
    event.taskId === job.native.taskId &&
    event.dispatchId === job.native.dispatchId &&
    (event.questionState === "pending" || event.replyOperation === operation)
  );
}

// Each job owns one controller and Run; no focus-derived or user terminal identity.
export function nativeOrca({ command, persist }) {
  async function mutate(job, key, args) {
    job.nativeJournal ||= {};
    let entry = job.nativeJournal[key];
    if (entry?.state === "done") return entry.result;
    if (!entry) {
      entry = job.nativeJournal[key] = {
        requestId: randomUUID(),
        args,
        state: "pending",
      };
      await persist(job);
    }
    if (JSON.stringify(entry.args) !== JSON.stringify(args))
      throw Error("Mutation changed");
    const result = await command([
      ...entry.args,
      "--retry-request",
      entry.requestId,
    ]);
    if (job.native.runtimeId && result._runtimeId !== job.native.runtimeId)
      throw Error("Runtime changed");
    entry.result = result;
    entry.state = "done";
    await persist(job);
    return result;
  }
  const identity = (job) => [
    "--run",
    job.native.runId,
    "--from",
    job.controller,
  ];
  async function controllerWorkspace(job) {
    const result = await command([
      "worktree",
      "list",
      "--repo",
      job.repo,
      "--limit",
      "1000",
    ]);
    const primary = result.worktrees?.filter(
      (w) =>
        `id:${w.repoId}` === job.repo &&
        w.isMainWorktree === true &&
        w.hostId === "local",
    );
    if (result.truncated || primary?.length !== 1 || !primary[0].id)
      throw Error("Exact local primary workspace unavailable");
    return primary[0].identity?.key
      ? `identity:${primary[0].identity.key}`
      : `id:${primary[0].id}`;
  }
  async function launch(job, spec) {
    job.native ||= {};
    job.lifecycle = "starting";
    if (!job.controller) {
      // Terminal creation has no mutation replay contract: never repeat an uncertain create.
      if (job.controllerCreating) throw Error("Controller creation uncertain");
      const workspace = await controllerWorkspace(job);
      job.controllerCreating = true;
      await persist(job);
      const created = await command([
        "terminal",
        "create",
        "--worktree",
        workspace,
        "--title",
        `Tencent controller ${job.id}`,
      ]);
      if (!created.terminal?.handle || !created.terminal.paneKey)
        throw Error("Controller unavailable");
      job.controller = created.terminal.handle;
      job.controllerPane = created.terminal.paneKey;
      job.native.runtimeId = created._runtimeId;
      await persist(job);
    }
    const run = await mutate(job, "run", [
      "orchestration",
      "run-create",
      "--objective",
      `Tencent Workbench job ${job.id}`,
      "--from",
      job.controller,
    ]);
    if (!run.run?.id) throw Error("Missing Run");
    job.native.runId = run.run.id;
    await persist(job);
    const task = await mutate(job, "task", [
      "orchestration",
      "task-create",
      ...identity(job),
      "--spec",
      spec,
      "--task-title",
      `Workbench ${job.id}`,
    ]);
    if (!task.task?.id || task.task.run_id !== job.native.runId)
      throw Error("Task scope mismatch");
    job.native.taskId = task.task.id;
    await persist(job);
    const worker = await mutate(job, "start", [
      "orchestration",
      "worker-start",
      ...identity(job),
      "--task",
      job.native.taskId,
      "--worktree",
      "new-top-level",
      "--repo",
      job.repo,
      "--name",
      `tencent-${job.id}`,
      "--agent",
      job.agent,
      "--setup",
      "skip",
      "--timeout-ms",
      "60000",
    ]);
    if (
      !worker.dispatchId ||
      worker.taskId !== job.native.taskId ||
      worker.runId !== job.native.runId
    )
      throw Error("Dispatch scope mismatch");
    job.native.dispatchId = worker.dispatchId;
    job.native.launchState = worker.state;
    job.native.failedStage = worker.failedStage;
    job.state = worker.state === "ready" ? "running" : "unknown";
    job.lifecycle = worker.state === "ready" ? "working" : "unknown";
    job.notice =
      "Native Orca worker assigned. Execution completion still requires review.";
    await persist(job);
    await refresh(job);
  }
  async function ensureController(job) {
    const shown = await command([
      "terminal",
      "show",
      "--terminal",
      job.controller,
    ]);
    if (job.native.runtimeId && shown._runtimeId !== job.native.runtimeId)
      throw Error("Runtime changed");
    if (shown.terminal && shown.terminal.connected !== false) {
      if (shown.terminal.handle !== job.controller)
        throw Error("Controller identity changed");
    } else {
      if (job.controllerReplacing)
        throw Error("Controller replacement uncertain");
      const workspace = await controllerWorkspace(job);
      job.controllerReplacing = true;
      await persist(job);
      const created = await command([
        "terminal",
        "create",
        "--worktree",
        workspace,
        "--title",
        `Tencent controller ${job.id}`,
      ]);
      if (!created.terminal?.handle || !created.terminal.paneKey)
        throw Error("Replacement unavailable");
      job.controller = created.terminal.handle;
      job.controllerPane = created.terminal.paneKey;
      job.controllerHandover = true;
      await persist(job);
    }
    if (job.controllerHandover) {
      const result = await mutate(job, `handover:${job.controller}`, [
        "orchestration",
        "run-use",
        "--id",
        job.native.runId,
        "--from",
        job.controller,
      ]);
      if (result.run?.id !== job.native.runId)
        throw Error("Run handover mismatch");
      job.controllerHandover = false;
      job.controllerReplacing = false;
      await persist(job);
    }
  }
  async function mailbox(job) {
    await ensureController(job);
    const args = [
      "orchestration",
      "check",
      "--run",
      job.native.runId,
      "--terminal",
      job.controller,
    ];
    const batch = await command(args);
    if (batch.runId !== job.native.runId || !Array.isArray(batch.messages))
      throw Error("Mailbox scope mismatch");
    job.events ||= [];
    for (const message of batch.messages) {
      if (message.run_id !== job.native.runId || typeof message.id !== "string")
        throw Error("Message scope mismatch");
      if (!job.events.some((event) => event.id === message.id)) {
        let payload = message.payload;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch {
            payload = null;
          }
        }
        const scopedQuestion =
          message.type === "question" &&
          message.from_handle === `dispatch:${job.native.dispatchId}` &&
          payload?.dispatchId === job.native.dispatchId &&
          payload?.taskId === job.native.taskId;
        job.events.push(
          redactNativeSecrets({
            id: message.id,
            type: message.type,
            subject: message.subject || "",
            body: message.body || "",
            payload: message.payload,
            ...(scopedQuestion
              ? {
                  runId: job.native.runId,
                  taskId: job.native.taskId,
                  dispatchId: job.native.dispatchId,
                  questionState: "pending",
                }
              : {}),
          }),
        );
      }
    }
    // Retain every consumed message durably before ack; UI can show a bounded projection.
    await persist(job);
    if (batch.deliveryId) {
      const ack = await mutate(job, `ack:${batch.deliveryId}`, [
        ...args,
        "--ack",
        batch.deliveryId,
      ]);
      // check --ack may immediately return the NEXT delivery. Do not acknowledge it here;
      // its next read is replayed by Orca and durably consumed in the next refresh.
      if (ack.acknowledged !== batch.deliveryId)
        throw Error("Ack not confirmed");
    }
  }
  async function refresh(job) {
    if (job.pendingContinuation) {
      job.state = "unknown";
      job.lifecycle = "unknown";
      job.notice =
        "Continuation outcome requires reconciliation with its original operation ID.";
      return;
    }
    if (job.stopped) {
      job.state = "exited";
      job.lifecycle = "stopped";
      return;
    }
    if (!job.native?.dispatchId) {
      job.state = "unknown";
      job.lifecycle = "unknown";
      return;
    }
    const shown = await command([
      "orchestration",
      "worker-show",
      "--dispatch",
      job.native.dispatchId,
    ]);
    if (job.native.runtimeId && shown._runtimeId !== job.native.runtimeId)
      throw Error("Runtime changed");
    if (
      (shown.worker?.dispatchId ?? shown.worker?.dispatch_id) !==
        job.native.dispatchId ||
      shown.dispatch?.id !== job.native.dispatchId ||
      (shown.dispatch.runId ?? shown.dispatch.run_id) !== job.native.runId ||
      (shown.dispatch.taskId ?? shown.dispatch.task_id) !== job.native.taskId
    )
      throw Error("Worker scope mismatch");
    job.worktree =
      shown.worker.worktreeId || shown.worker.worktree_id || job.worktree;
    job.terminal =
      shown.worker.agentTerminalHandle ||
      shown.worker.agent_terminal_handle ||
      job.terminal;
    const live = shown.observation?.status;
    job.state =
      live === "live" ? "running" : live === "exited" ? "exited" : "unknown";
    job.lifecycle = shown.observation?.agentWait
      ? "needs_input"
      : live === "live"
        ? "working"
        : "unknown";
    if (shown.dispatch?.status === "completed") job.lifecycle = "review";
    else if (
      shown.dispatch?.status === "failed" ||
      shown.worker.state === "failed"
    )
      job.lifecycle = shown.observation?.agentWait ? "needs_input" : "failed";
    if (job.lifecycle === "failed" && job.state === "running")
      job.state = "unknown";
    if (job.stopped) job.lifecycle = "stopped";
    const output = await command([
      "orchestration",
      "worker-read",
      "--dispatch",
      job.native.dispatchId,
      "--source",
      "terminal",
      "--limit",
      "200",
    ]);
    if (output.dispatchId !== job.native.dispatchId)
      throw Error("Output scope mismatch");
    job.output = redactNativeSecrets(
      (output.terminal?.tail || [])
        .filter((x) => typeof x === "string")
        .join("\n")
        .slice(-80000),
    );
    if (job.worktree && !job.directory) {
      const workspace = await command([
        "worktree",
        "show",
        "--worktree",
        `id:${job.worktree}`,
      ]);
      if (
        workspace.worktree?.id !== job.worktree ||
        `id:${workspace.worktree.repoId}` !== job.repo
      )
        throw Error("Workspace scope mismatch");
      job.host = workspace.worktree.hostId;
      job.base = workspace.worktree.git?.head;
      if (job.host === "local" && workspace.worktree.path)
        job.directory = await realpath(workspace.worktree.path);
    }
    if (!job.controllerClosed) await mailbox(job);
    job.notice =
      job.lifecycle === "review"
        ? "Worker reported completion. Review changes and evidence before accepting the task."
        : "Native Orca observation; a live terminal alone does not prove progress or completion.";
  }
  async function assertActiveDispatch(job) {
    const shown = await command([
      "orchestration",
      "worker-show",
      "--dispatch",
      job.native.dispatchId,
    ]);
    if (
      (shown.worker?.dispatchId ?? shown.worker?.dispatch_id) !==
        job.native.dispatchId ||
      shown.dispatch?.id !== job.native.dispatchId ||
      (shown.dispatch.runId ?? shown.dispatch.run_id) !== job.native.runId ||
      (shown.dispatch.taskId ?? shown.dispatch.task_id) !== job.native.taskId
    )
      throw Error("Dispatch identity unavailable");
    if (
      ["completed", "failed", "circuit_broken"].includes(
        shown.dispatch.status,
      ) ||
      ["stopped", "failed"].includes(shown.worker.state)
    ) {
      job.lifecycle =
        shown.dispatch.status === "completed" ? "review" : "failed";
      job.notice =
        "This native worker attempt has finished. A message cannot resume it; create an explicitly approved new attempt.";
      const error = Error(job.notice);
      error.code = "native_worker_settled";
      throw error;
    }
    if (shown.dispatch.status !== "dispatched")
      throw Error("Worker is not accepting guidance");
  }
  async function continueWork(job, input) {
    if (job.pendingContinuation && job.pendingContinuation !== input.operation)
      throw Error("Continuation already pending");
    job.continuations ||= {};
    let continuation = job.continuations[input.operation];
    if (!continuation) {
      const shown = await command([
        "orchestration",
        "worker-show",
        "--dispatch",
        job.native.dispatchId,
      ]);
      if (
        (shown.worker?.dispatchId ?? shown.worker?.dispatch_id) !==
          job.native.dispatchId ||
        shown.dispatch?.id !== job.native.dispatchId ||
        (shown.dispatch.runId ?? shown.dispatch.run_id) !== job.native.runId ||
        (shown.dispatch.taskId ?? shown.dispatch.task_id) !== job.native.taskId
      )
        throw Error("Dispatch scope mismatch");
      if (
        shown.dispatch.status !== "completed" ||
        !job.worktree ||
        (shown.worker.worktreeId ?? shown.worker.worktree_id) !== job.worktree
      ) {
        job.notice =
          "Only a completed native attempt with its verified worktree can continue.";
        const error = Error(job.notice);
        error.code = "native_worker_settled";
        throw error;
      }
      const workspace = await command([
        "worktree",
        "show",
        "--worktree",
        `id:${job.worktree}`,
      ]);
      if (
        workspace.worktree?.id !== job.worktree ||
        `id:${workspace.worktree.repoId}` !== job.repo ||
        workspace.worktree.hostId !== "local"
      )
        throw Error("Continuation workspace unavailable");
      job.pendingContinuation = input.operation;
      continuation = job.continuations[input.operation] = {
        previous: {
          native: { ...job.native },
          worktree: job.worktree,
          lifecycle: job.lifecycle,
        },
        spec: input.spec,
      };
      await persist(job);
    }
    if (continuation.spec !== input.spec)
      throw Error("Continuation specification changed");
    if (continuation.applied) return refresh(job);
    await ensureController(job);
    job.state = "launching";
    job.lifecycle = "starting";
    await persist(job);
    const task = await mutate(job, `continue-task:${input.operation}`, [
      "orchestration",
      "task-create",
      ...identity(job),
      "--spec",
      input.spec,
      "--task-title",
      `Workbench revision ${job.id}`,
      "--parent",
      continuation.previous.native.taskId,
    ]);
    if (!task.task?.id || task.task.run_id !== job.native.runId)
      throw Error("Continuation task scope mismatch");
    const worker = await mutate(job, `continue-start:${input.operation}`, [
      "orchestration",
      "worker-start",
      ...identity(job),
      "--task",
      task.task.id,
      "--worktree",
      `id:${continuation.previous.worktree}`,
      "--agent",
      job.agent,
      "--timeout-ms",
      "60000",
    ]);
    if (
      !worker.dispatchId ||
      worker.runId !== job.native.runId ||
      worker.taskId !== task.task.id
    )
      throw Error("Continuation dispatch scope mismatch");
    if (
      (worker.worktreeId &&
        worker.worktreeId !== continuation.previous.worktree) ||
      worker.effects?.some(
        (effect) =>
          effect.kind === "worktree" &&
          effect.id &&
          effect.id !== continuation.previous.worktree,
      )
    )
      throw Error("Continuation workspace mismatch");
    job.attempts ||= [];
    if (
      !job.attempts.some(
        (attempt) =>
          attempt.native.dispatchId === continuation.previous.native.dispatchId,
      )
    )
      job.attempts.push(continuation.previous);
    job.native = {
      runId: worker.runId,
      taskId: worker.taskId,
      dispatchId: worker.dispatchId,
      runtimeId: job.native.runtimeId,
      launchState: worker.state,
      failedStage: worker.failedStage,
    };
    continuation.applied = {
      taskId: worker.taskId,
      dispatchId: worker.dispatchId,
    };
    delete job.pendingContinuation;
    job.stopped = false;
    job.state = worker.state === "ready" ? "running" : "unknown";
    job.lifecycle = worker.state === "ready" ? "working" : "failed";
    await persist(job);
    await refresh(job);
  }
  async function control(job, action, input) {
    if (!job.native.dispatchId) throw Error("Dispatch unavailable");
    if (action === "continue") return continueWork(job, input);
    if (action === "send") {
      if (input.replyTo && !canReply(job, input.replyTo, input.operation))
        throw Error("Pending question not found in this worker");
      if (!job.nativeJournal?.[`send:${input.operation}`])
        await assertActiveDispatch(job);
      await ensureController(job);
      const args = input.replyTo
        ? [
            "orchestration",
            "reply",
            ...identity(job),
            "--id",
            input.replyTo,
            "--body",
            input.text,
          ]
        : [
            "orchestration",
            "send",
            ...identity(job),
            "--to",
            `dispatch:${job.native.dispatchId}`,
            "--subject",
            "Workbench coordinator follow-up",
            "--body",
            input.text,
            "--type",
            "status",
          ];
      const sent = await mutate(job, `send:${input.operation}`, args);
      if (
        !sent.message?.id ||
        sent.message.run_id !== job.native.runId ||
        sent.message.to_handle !== `dispatch:${job.native.dispatchId}`
      )
        throw Error("Message acceptance unavailable");
      if (input.replyTo) {
        if (
          sent.question?.message_id !== input.replyTo ||
          sent.question.run_id !== job.native.runId ||
          sent.question.dispatch_id !== job.native.dispatchId ||
          sent.question.status !== "answered" ||
          sent.question.answer_body !== input.text ||
          sent.message.thread_id !== input.replyTo
        )
          throw Error("Question answer not confirmed");
        const event = job.events.find((item) => item.id === input.replyTo);
        event.questionState = "answered";
        event.replyOperation = input.operation;
        await persist(job);
      }
      job.notice =
        "Message recorded in Orca's worker mailbox. This does not prove the worker has read or acted on it.";
    } else {
      const stopped = await mutate(job, `stop:${input.operation}`, [
        "orchestration",
        "worker-stop",
        "--dispatch",
        job.native.dispatchId,
      ]);
      if (
        stopped.dispatchId !== job.native.dispatchId ||
        stopped.state !== "stopped" ||
        !["closed_agent_terminal", "closed_exited_terminal"].includes(
          stopped.processAction,
        )
      )
        throw Error("Stop not verified");
      job.state = "exited";
      job.lifecycle = "stopped";
      job.stopped = true;
      await persist(job);
      job.notice =
        "Native worker stopped; worktree and execution history preserved.";
      try {
        await mailbox(job);
        if (!job.controllerClosed) {
          const close = await command([
            "terminal",
            "close",
            "--terminal",
            job.controller,
          ]);
          if (close.close?.ptyKilled === true && !close.close?.ptyStopVerdict)
            job.controllerClosed = true;
          else throw Error("Controller close unconfirmed");
        }
      } catch {
        job.notice =
          "Native worker stop confirmed; controller cleanup remains pending. Worktree preserved.";
      }
    }
  }
  return { launch, refresh, control };
}
