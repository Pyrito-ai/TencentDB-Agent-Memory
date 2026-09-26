# cdesktop comparison trial

This trial adds cdesktop alongside Orca. Orca routes, receipts, bindings, and
worktrees remain intact. Nothing routes to cdesktop unless the user chooses it.

## User flow

1. Open a Task Board task and choose **cdesktop (trial)** in its work controls.
2. Select an allowlisted repository, Codex or Claude, and optionally a Tencent
   agent profile. Click **Send to cdesktop**.
3. Open Workbench. The exact saved cdesktop workspace and session load inside
   Tencent, with the main navigation and global Coordinator still available.
4. Switch to **Orca** to inspect or launch that task's independent Orca handoff.
   Switching runtimes never launches work. Both work surfaces stay mounted.

The task, project context, linked Wiki excerpts and selected agent profile use
the existing authenticated context assembly. Each runtime snapshots its own
launch; changing context later does not rewrite an existing session. For a fair
comparison, launch both before changing the brief or linked context. Direct
handoffs do not invoke the Coordinator model or OpenRouter.

## Boundaries

- `cdesktop-*` Workbench operations allow only options, handoff-get,
  handoff-launch and handoff-sync. The normal team/owner checks apply.
- cdesktop handoffs live in their own `cdesktop_handoffs` table in the existing
  Workbench database. An Orca handoff is not replaced or migrated.
- `CDESKTOP_BINDINGS_FILE` uses the existing server-side binding schema. Bindings
  are scoped to instance, team and user; URLs/tokens never come from a task.
- `scripts/workbench/cdesktop-runner.mjs` is a separate bearer-authenticated
  loopback bridge. It accepts configured repository IDs and creates a fresh
  worktree plus a native session. It refuses copied files and repo setup hooks.
- The bridge persists mutation stages and returned IDs before proceeding.
  Retrying a saved handoff inspects it; it never repeats an uncertain prompt.
  A crashed operation lock requires inspection rather than automatic replay.
- Process completion means review is required. No automatic task completion,
  merge, push or deployment occurs.

This is a **single-owner runtime trial**. cdesktop's native API assumes a trusted
local user; do not expose its port publicly or treat an iframe as tenant
isolation. The hosted Tencent page can embed this owner's loopback UI on the
same Mac (deployment below). Access from another device would need an
authenticated transport for assets, API, WebSocket traffic and reconnects.

## Runtime configuration

Build the isolated fork `cdesktop-workbench` (upstream `75bd015`, branch
`workbench-embed`). Its `WORKBENCH-MODIFICATIONS.md` records the embedded UI
contract. Preserve upstream `LICENSE`, `NOTICE` and attribution.

Start cdesktop with an absolute `CDT_DATA_DIR`, dedicated `TMPDIR`,
`CDT_SKIP_SKILL_INSTALL=1`, `CDT_NO_OPEN=1`, `DISABLE_WORKTREE_CLEANUP=1`,
`HOST=127.0.0.1`, explicit backend/preview ports, and an exact frontend origin in
`CDT_ALLOWED_ORIGINS`. In its isolated config, set a separate `workspace_dir`,
disable analytics/relay and automatic commit reminders. Do not copy shared
provider keys or alter the user's global CLI settings.

Use an explicit `WORKBENCH` executor variant. Codex uses workspace-write and
on-request approvals; Claude uses cdesktop approval hooks with API-key use
disabled. Claude's hooks are not an OS sandbox. The bridge checks the profile
before launch. An explicit model must be supported by the user's CLI account.

Bridge configuration (`CDESKTOP_RUNNER_CONFIG` points to a private JSON file):

```json
{
  "token": "GENERATE_A_PRIVATE_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS",
  "dataDir": "/absolute/private/cdesktop-jobs",
  "host": "127.0.0.1",
  "port": 8793,
  "cdesktopUrl": "http://127.0.0.1:8131",
  "webUrl": "http://127.0.0.1:5190",
  "executorVariant": "WORKBENCH",
  "codexModel": "gpt-5.6-sol",
  "repos": [
    {
      "id": "comparison-fixture",
      "path": "/absolute/repository",
      "targetBranch": "main"
    }
  ]
}
```

The paired Tencent binding points to port 8793, contains the same private token
and repository ID, and sets `webUrl` to port 5190. The browser receives only the
public binding identity and session URL; Tencent credentials are not sent to
the iframe.

## Verification and recovery

- Panel unit tests cover separate runtime receipts, owner/runtime boundaries,
  identical context/profile assembly, revoked Wiki access, repeat launches and
  rejection of a foreign iframe origin.
- Bridge mock tests cover auth, allowlists, uncertain network responses,
  concurrent retries, clean worktrees and explicit profiles.
- The cdesktop fork includes tests for direct session selection and stale
  workspace/session responses. UI checks cover compact embed and standalone
  navigation, plus preserving forms and frames when switching providers.
- Live test details are recorded below.

To stop the trial, stop its loopback UI, server and bridge processes. Remove
`CDESKTOP_BINDINGS_FILE` from the local Tencent configuration to disable new
launches. Preserve its data/worktrees for review. Orca uses its original binding,
bridge and handoff table throughout; there is no cutover to reverse.

## Live comparison, 2026-09-26

The initial local comparison at `http://127.0.0.1:5187` enabled both runtimes
before the subsequent hosted deployment below. cdesktop's frontend runs on 5190,
native API on 8131, preview proxy on 8132, and authenticated bridge on 8793.
Orca retains its original bridge on 8791 and web surface on 5188.

Task `task-86bqz1ul1c` (Workbench comparison verification) used a dedicated Git
fixture, separate from product repositories. Both runtimes received the same
bounded instruction to create `comparison.txt` containing
`WORKBENCH_COMPARISON_OK`, read it back, and report the directory and branch.

| Runtime | Handoff | Result |
| --- | --- | --- |
| cdesktop | `ad881a49-021c-4cc7-8302-88771e629d85` | Codex completed, native process exit 0; expected file in a fresh worktree. |
| Orca | `57153deb-1f4f-4b36-8ef4-277b27fd6ff3` | Codex reported completion; expected file in its separate worktree. |

Filesystem checks confirmed identical 24-byte outputs (including newline),
only the intended untracked file in each worktree, and a clean source repository
on `main`. Nothing was committed, pushed or deployed by either test worker.
cdesktop's exact session opened inside Tencent; switching back to Orca retained
the existing runtime. The cdesktop Changes panel showed the generated diff.
A read-only follow-up in the existing cdesktop chat returned `FOLLOWUP_OK`.
Its native receipt retained `gpt-5.6-sol`, medium reasoning, `WORKBENCH` and
`SUPERVISED`, without a provider override. The composer displays those inherited
model settings rather than an unrelated browser default.

The live cdesktop launch used `gpt-5.6-sol`, `WORKBENCH`, `SUPERVISED` and medium
reasoning. Orca used its existing `gpt-5.6-sol` high configuration. This validates
the handoff and isolation, not a controlled performance or model-quality
benchmark. Claude and linked-Wiki/profile launches were not exercised live;
the latter context and access boundaries are covered by the Panel tests.

Existing global Codex MCP and skill configuration produces startup warnings in
the cdesktop transcript. They did not prevent this task completing. Global
credentials and MCP configuration were not modified. Handoff status tracks the
initial dispatched process; subsequent native chat turns are viewed in
cdesktop. Public runtime exposure and multi-user runtime access remain outside
this trial.

### Checks and limits

Panel Workbench tests passed (21), bridge tests passed (17), and the Panel
typecheck and Tencent web build passed. The Panel suite passed before the final
additional Wiki-access test; the final Workbench test run includes that test.
The cdesktop server built with stable Rust, and its local frontend typecheck
and build passed. Embed/session selection and follow-up model restoration have
focused regression tests.

The repository-wide pnpm format entrypoint could not finish because its package
manager bootstrap required an unavailable install/TTY path. Scoped frontend
format/lint checks were used. Repository-wide Rust formatting reports existing
unrelated upstream differences, and the unused remote-web package has existing
type errors. Those packages/files were not expanded into this trial.

During the initial local check, browser automation could read the embedded cdesktop session but could not click
its cross-origin controls in this tool environment. Diff and follow-up actions
were therefore verified in a temporary direct tab against the same embedded
route and session. The user-facing Workbench retains the session in its iframe;
ordinary workflow navigation does not open another browser window.

## Hosted deployment, 2026-09-26

Tencent Hub now serves the comparison build at
`https://tencent.167.235.234.97.sslip.io/`. Hub image:
`pyrito/tencent-memory-hub:cdesktop-6eb0887`, source `6eb0887`. The local
cdesktop fork is checkpoint `ef0014d` on `workbench-embed`. Core and Model Proxy
retain their existing images and data. Coolify service remains
`7gz2gpmjasxuzhuxowhe7yxd`.

The hosted Panel reaches the bearer-authenticated local cdesktop bridge through
the private SSH-forwarded Unix socket
`/data/knowledge/workbench/cdesktop.sock`. Its new binding file is
`/data/knowledge/workbench/cdesktop-bindings.json`, scoped to the existing owner
and team. Orca retains its own socket, token, and handoff records. The existing
comparison task's two receipts were imported additively; no existing production
handoff was overwritten or relaunched.

The browser loads cdesktop from `http://127.0.0.1:5190` inside the hosted page.
Its API and WebSockets remain on the Mac. The existing Orca binding also exposes
its loopback web view at `http://127.0.0.1:5188/web-index.html`. Orca's browser
view may require its normal pairing in this hosted-page browser context;
desktop dispatch remains independent of that pairing.

**Testing requirements:** use this Mac, keep the local runtimes/bridges and SSH
tunnels running, and keep the Mac awake. Another device's `127.0.0.1` does not
reach this Mac. No automatic Mac-login startup is configured. Browser local
network permission, if requested, belongs to the user; no browser protections
were disabled. The Codex in-app browser loaded cdesktop without a prompt.

The two tunnel commands in the parent workspace remain
`python3 work/run-production-orca-tunnel.py` and
`python3 work/run-production-cdesktop-tunnel.py`. They invoke the tested
`MemoryPanel/scripts/workbench/ssh-runtime-tunnel.py` with private configuration
files. The launcher verifies the pinned SSH host key, holds a per-destination
lock, preserves active/non-socket paths, and removes only an unchanged, refused,
unbound stale socket before reconnecting. The server's effective
`StreamLocalBindUnlink` is `no`. Twenty-two focused launcher tests pass.

Verified on the live HTTPS app:

- Healthy replacement Hub container and exact new frontend bundle.
- Four owner-scoped cdesktop bindings and the original Orca project catalog.
- Both comparison receipt IDs preserved; read-only sync reaches both bridges.
- Existing Baren Orca handoff retained. Missing/invalid credentials cannot read
  cdesktop bindings (400 missing required auth context / 401 invalid key).
- cdesktop rendered under the global Coordinator and navigation. Clicking
  Changes inside the iframe showed `WORKBENCH_COMPARISON_OK`.
- Sending a read-only message inside that same iframe returned
  `DEPLOYED_WORKBENCH_OK`, using `gpt-5.6-sol` medium with the Workbench profile.

### Recovery

Consistent pre-release Hub volume archive and configuration are under
`/opt/tencent-workbench/6eb0887/backup/`:
`hub-data.tgz`, `rendered-compose.yml`, `cdesktop-compose-before.yml`, and
`orca-bindings-before.json`. The previous image
`pyrito/tencent-memory-hub:icon-ec9d3c9` is retained. These are on-server release
backups, not a scheduled/off-server backup system.

For application rollback, restore the saved raw service definition through
Coolify, restore the rendered compose and prior Orca binding, then recreate
only `memory-hub` with `--no-deps --pull never`. Preserve current data unless a
data rollback is specifically necessary; restoring the archive discards writes
made since deployment. The new handoff table is additive and can remain in the
database when running the previous image. Stop only the cdesktop tunnel to
disable its remote handoff connection while preserving Orca.
