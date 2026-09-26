# Versioned Task Board transitions

The Workbench execution integration uses three authenticated POST APIs under
`/v3/meta/task/`. Existing task CRUD payloads remain compatible for unversioned tasks; protected tasks require conditional edits. These APIs require the
existing gateway authentication and a real `x-tdai-user-key`; they never accept a
user ID in the payload as caller identity or grant an administrator bypass.

| Endpoint | Body | Result |
|---|---|---|
| `board-state` | `{task_id}` | `{task, revision}` |
| `board-transition` | `{task_id, expected_revision, status}` | `{task, revision}` |
| `execution-grant` | `{task_id, expected_revision, service_user_id}` | `{task, revision}` |

Results are inside the usual v3 `data` envelope. The revision is an opaque
SHA-256 string covering task/team/creator identity, title, description, Core
status, and the complete metadata. On conflict the envelope code is 409; reread
and reconcile, rather than replacing a revision and blindly replaying intent.

Board status values: `backlog`, `ready`, `in_progress`, `review`, `done`.
The transition changes only `metadata_json.project_board.status`, a fresh
`board_revision` nonce, the corresponding Core status (`completed` for Done,
otherwise `running`), and `updated_at`. Other board and task metadata survives.
The nonce prevents repeated transitions back to an old state from restoring an
old revision. Both SQLite and MongoDB use a conditional atomic update matching
the original revision-bearing fields; Mongo returns the updated document from
that operation rather than doing a separate read.

The task creator must be an active team member to transition or grant access.
A delegated service also loses these scoped reads/writes if the grant owner
leaves the team.
They may nominate a *different*, active team member as the dedicated execution
service user. This is an explicit per-task grant, stored as
`execution_service_grant: {service_user_id, granted_by}`. Passing null revokes it.
Grant changes require the same revision contract. The grant is part of the same
metadata value compared by the transition, so concurrent revocation defeats a
stale service write.

An active grantee can read this task through `board-state`, and project only
`in_progress` or `review` from an existing Ready/In progress/Review task. It cannot
accept Done, reopen completed work, grant further access, or transition other
statuses. The creator remains responsible for human acceptance. No service user
or credentials are provisioned by this change. Execution approval, approved-spec
hash, project/runtime binding, and attempt identity are additional Panel checks;
a Core projection grant by itself is not permission to launch a worker.

## Compatibility and operational limits

- These are scoped APIs, **not a new globally restricted authentication token**.
  Existing Core read APIs retain their current authorization behavior. Do not
  expose a service key to workers or claim it is a tenant-isolated context token.
- `task/update` accepts optional `expected_revision` and returns the usual TaskEntity.
  A task with `board_revision` or an execution grant requires this revision for
  edits, including `task/archive` (which now accepts expected_revision).
  Missing/stale revisions return 409. Use board-state, merge edited fields
  into its snapshot, and submit the revision. Both versioned and legacy writes
  use conditional atomic updates. Legacy edits cannot change the reserved grant
  or nonce fields: the server preserves their current values. A stale human edit
  cannot restore a revoked grant. Unversioned tasks retain the old request shape,
  but concurrent changes can now return a conflict rather than be overwritten.
- SQLite checks current active membership within its conditional update.
  Mongo uses the configured transaction for membership read + conditional task
  update. Grant revocation is guarded on the task document on both backends;
  membership revocation has ordinary Mongo snapshot transaction semantics.
- Test coverage uses real in-memory SQLite and a Mongo query-contract fake.
  A replica-set integration trial remains required before Mongo rollout.

Run focused tests from the repository root with Node 22+ and dependencies:

```
cd MemoryCore
npm run test:board
```

Validation completed: eight service/store/schema tests and one real loopback HTTP
route test passed with the declared Core runtime dependencies. `build:plugin`
completed. The HTTP fixture exercises v3 routing, user-key authentication, and
service authorization; it does not launch the full gateway or test its outer
bearer-token middleware. No upstream metadata tests are present in this checkout.

Targeted TypeScript validation (NodeNext, ES2022, skipLibCheck, route + both
adapters + new tests) reports 77 existing diagnostics. The same check on clean
HEAD reports 79; the only difference after normalizing checkout paths is two
fixed missing `IMetadataStore` type imports. There are no added diagnostics, but
this is **not** a clean Core typecheck. Dependencies for this local verification
were installed without lifecycle scripts in `/tmp/tencent-core-validation`; no
repository lockfile was changed. Mongo replica-set behavior remains unverified.
