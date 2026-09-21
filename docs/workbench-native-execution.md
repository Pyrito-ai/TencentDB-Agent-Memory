# Workbench native execution pilot

Implementation branch: `workbench`. This is an opt-in, single-owner, local Git-worktree pilot. It uses installed Orca's native Runs, Tasks, Dispatches, mailbox, worker observations and lifecycle operations. No Symphony service or replacement worker scheduler is installed.

## Ownership and flow

Tencent owns business tasks, project assignment, permission, approved instructions and human acceptance. Orca owns worker execution. A native Task is linked execution state, not a second business backlog.

1. Select or create a Task Board task in Workbench and assign a Tencent project.
2. Map that project to an authorized Orca repository/runtime.
3. Explicitly approve the current task instructions and worker provider. Approval includes task title, description, acceptance criteria, planned start, project mapping and selected source context.
4. Mark the task Ready and launch. Old Ready tasks without approval do not launch. A conditional Core transition and durable local claims precede the external effect.
5. Follow the native worker status, output and messages. A live terminal is not proof of worker progress. Native questions have an explicit answer action.
6. Worker success moves the board task to Review. Inspect the current changes and accept the matching snapshot to reach Done. Nothing automatically merges, deploys, accepts a Loop occurrence, or approves timesheets.
7. To request changes after completion, approve explicit revision instructions. Orca creates a new child Task/Dispatch in the same Run and worktree, preserving prior attempts. A normal mailbox message cannot restart a completed Dispatch.

The coordinator uses its configured API model. Workers use the provider account configured in Orca. Workbench does not route worker inference through the coordinator's API, and does not itself establish whether a provider account bills a subscription or API usage.

## Runtime bridge

`MemoryPanel/scripts/workbench/runner.mjs` defaults new jobs to native orchestration. Existing saved legacy jobs retain their previous control path. Each new job provisions a dedicated plain-shell controller in the exact authorized local primary worktree, then persists Run/Task/Dispatch IDs. No extra model runs in the controller shell.

Mutation request IDs are written before invoking Orca. Explicit retries replay the same operation and payload. Uncertain non-idempotent controller creation does not repeat automatically. Inbox messages are persisted and deduplicated before acknowledgment. A positively missing controller can be replaced using native Run handover; transport failure alone is not proof of disappearance.

A cross-process job lock serializes bridge operations. A crash-held `.lock` directory requires operator inspection against the native Run before removal. Never remove a lock solely because a request timed out. Inspect existing IDs before retrying or rolling back. Worktrees are retained.

The bridge remains private and token-authenticated. Do not expose the owner-level Orca CLI as a public customer API. The pilot supports locally discoverable Git repositories with a primary worktree; remote/folder execution and customer runtime isolation require separate verification.

## Required rollout

Deploy the updated Core and Panel together before enabling the local page against them. Core adds `task/board-state`, `task/board-transition` and `task/execution-grant`; Panel adds them to its proxy allowlist. A local UI against an older Core must fail closed, not fall back to unversioned updates.

Persist and back up both the existing Task Board database and Workbench's `runs.sqlite`, plus the private bridge job directory. New execution tables are additive. Core revisions derive from current task contents; protected legacy updates cannot overwrite service-grant metadata.

Configuration:

- `WORKBENCH_DATA_DIR`: existing Workbench conversation and execution records.
- `TASK_BOARD_DATA_DIR`: existing board `time.sqlite` containing projects and task assignments.
- Existing Workbench binding configuration: restrict instance, team, owner, repository and private bridge URL/token. Bindings must refer to the runtime actually displayed in the UI.
- `WORKBENCH_EXECUTION_MODE=off|shadow|active`: off/shadow block new execution; existing observation and stop remain available. When unset, explicit interactive launches are allowed, but the background poller requires `active`. Start with shadow, then explicitly enable a single-project pilot. Do not infer active authorization from a Ready column alone.
- `WORKBENCH_SERVICE_PRINCIPALS_FILE`: optional private JSON file for unattended polling. Without a dedicated service principal, use authenticated interactive dispatch.

Service-principal file shape (values are placeholders):

```json
[
  {
    "instance": "configured-instance",
    "team": "team-id",
    "owner": "human-user-id",
    "serviceUser": "dedicated-service-user-id",
    "keyFile": "/private/path/to/service-user-key"
  }
]
```

Both owner and service user must have active membership. The owner must explicitly opt each approved task into background execution; this writes a task-scoped Core grant. Revocation or stale task instructions prevent a new reservation. The poller checks every 15 seconds, with one active worker slot per configured runtime endpoint. Selected Wiki sources currently require interactive execution and cannot be combined with background approval.

These new Core execution APIs enforce scoped service grants. Existing upstream metadata read APIs are not comprehensively narrowed by this change; this is not a multi-tenant security certification.

The standalone `local-server.ts` keeps the owner key server-side, exposes only public user fields, and gates local routes with its private cookie/origin checks. Its project/Loop lookup uses the authenticated remote Board rather than an unrelated local database. It is a development host, not a public authentication layer.

## Context and review boundaries

Selected Wiki pages require fresh asset authorization and a matching team/reference. Content is bounded, carries provenance, is included in the approved worker specification, and is revalidated before dispatch. See [context boundary](workbench-context.md).

Automatic broad memory retrieval and automatic outcome-memory writes are not enabled. A reviewed outcome draft helper is available; a governed memory-write flow still needs an authorized destination and UI. Task dependencies/code-artifact propagation, an embedded Orca shell with unified navigation, remote execution, and automatic release of retained worktrees remain separate follow-up work.

## Verification

Final branch validation: 90 Panel tests, 19 native bridge/HTTP tests, and 9 Core tests pass. Panel and standalone-host typechecks, focused frontend lint, web build, and Core plugin build pass. The broad Core typecheck limitation below remains.

- Core SQLite service/schema and real HTTP route authorization tests cover grant scope, stale revisions, archive behavior, revoked/removed owners and human-only Done. Mongo's atomic predicate has fixture coverage, not a live replica-set test.
- Panel contract tests use the real SQLite Core service and schemas, with a fake worker, to verify approval through Review and human acceptance; revocation between read and reservation prevents launch.
- Bridge tests cover native identity, request replay, mailbox persistence/acknowledgment, failed worker versus live terminal, scope and private-state redaction.
- Browser QA uses an isolated synthetic fixture for task selection/creation, approval, launch receipts, questions and review. It is not evidence of production deployment.
- Live installed Orca 1.4.196 test: initial configured worker stalled at workspace trust and correctly failed; an explicitly created normal-permission Claude Max session then accepted native dispatch, asked the controller for a marker, received `WORKBENCH_NATIVE_OK`, and reported native `worker_done` success. No project file changes occurred. Exact resource release was tested; reused external terminals are correctly retained by native release. Both remaining test-owned terminals were explicitly closed with confirmed process termination. The worktree and history remain.

Core's plugin build passes. A broad targeted Core TypeScript check still reports upstream errors (77 versus 79 on clean HEAD in the same isolated dependency environment); there were no new normalized diagnostics. Do not represent that as a clean Core typecheck.

No production rollout or service credentials were activated by these implementation tests.
