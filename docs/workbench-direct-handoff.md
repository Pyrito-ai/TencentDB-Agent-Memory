# Direct Task Board → Orca handoff

Implemented locally on workbench, 2026-09-25. Coordinator UI is hidden; its code and native orchestration integration are preserved.

Open a Task Board task, choose an Orca project and Codex or Claude, then click **Send to Orca**. The title, description and acceptance criteria form the instructions. No coordinator model call is made.

The authenticated Panel calls the private bridge with `mode: direct`. The bridge invokes Orca `worktree create --repo <exact repository> --name tencent-<saved ID> --agent <agent> --prompt <instructions> --setup skip --no-parent`. Orca owns the worker and fresh Git worktree. The agent uses its existing authentication and permission settings.

SQLite `orca_handoffs` binds instance, team, task, owner, repository, agent, immutable instructions and launch ID. Only the active task creator can launch. Repeated clicks and uncertain retries reuse that ID and brief; the bridge journals outcomes and rejects conflicting request fingerprints. Existing handoffs cannot be redirected into a different repository or agent. Review and follow-up happen in Orca. Task status stays manual; no automatic acceptance, merge, push or deployment.

The runner allowlist remains enforced. This direct flow requires no Core board-state API, background principal, coordinator shell or production upgrade. This is a local single-owner development host; public production has not been updated.

## Verification

32 Panel tests, six bridge tests, Panel typecheck and frontend build passed. Browser verified project/agent/Send controls.

Live task `task-6yurqrzzx0`, handoff `d6328cfc-608b-4c1e-ba92-a3aaad399d70`, project `workbench-verification`: Claude Max returned `DIRECT_HANDOFF_OK`; separate Git status confirmed a clean worktree. Disposable task/worktree retained as evidence.

Earlier native probe `task-6yqzq4yts5` created a worktree but Codex stopped at its hooks-review gate. No hook trust was granted. That diagnostic attempt remains separate from the direct CLI flow.

An open terminal does not prove worker progress or completion. Startup login/trust/hook gates must be handled in Orca. The direct flow does not automatically approve them or create native coordinator Runs.

## Project and Wiki context (2026-09-25)

Projects now have a directory and detail route (`/#/projects?id=<id>`), editable project context, assigned tasks and Wiki connections. Task details show their own links and inherited project links. The existing dropdown remains a filter/assignment control.

New direct handoffs contain the task brief, acceptance criteria, project name/description and explicitly linked Wiki page excerpts. This is deterministic assembly with no coordinator/OpenRouter request. Preview shows the selected context before launch. Each handoff stores an immutable snapshot, provenance and hash; editing links does not change already-saved handoffs.

Connections are persisted in local `workbench_context_links`, scoped by instance/team/target, with revision conflict checks. Wiki reads enforce active membership, team ownership and read ACL. Revoked or missing sources block a new launch or retry; saved snapshot retrieval also rechecks source access. Already-delivered worker context cannot be recalled.

Limits: eight distinct linked pages, up to 4,000 characters per page and 12,000 total. Truncation is indicated in preview; selection overflow blocks launch rather than silently omitting a selected page. The whole launch brief is capped at 48,000 characters.

Validation: 33 focused Panel tests pass, plus Panel typecheck and frontend build. Live project create/update/assignment/preview was verified using a disposable project, then unassigned and archived. The live team has no accessible Wikis, so actual Wiki selection/content injection was verified with fixtures, not a live customer Wiki. No worker was launched for this context validation. Changes and link storage remain local; production is unchanged.

## Agent profile selection

The handoff form now loads active profiles from the app's Agents page. Users can select an owned profile or one shared with their team, or choose no profile. A disclosure previews its description and canonical prompt (role plus rules). The launch validates the profile server-side and embeds an immutable snapshot (id, name, description, prompt, update timestamp) into the brief sent to Orca. Retries preserve that snapshot; changing profiles requires a new task/handoff. Removed/private/inactive profiles cannot be launched or retrieved by an unauthorized user.

This selects instructions, not CLI configuration: it does not install profile assets, MCP connections or skills, change models, or expand worker permissions. Existing handoffs show their original selection and cannot be retroactively changed. No coordinator model call is used.

## Production deployment — 2026-09-25

Deployed source `6ebb097` to the Tencent trial on `167.235.234.97`, Coolify service `7gz2gpmjasxuzhuxowhe7yxd`, image `pyrito/tencent-memory-hub:workbench-6ebb097`. The release layers the new Panel/web build on the exact prior running Hub image, retaining its Knowledge runtime. Core and Proxy were not upgraded. Coolify's raw compose and the rendered compose both contain the release image and Workbench persistence paths.

Runtime bindings and SQLite handoff/context storage are in the existing Hub volume at `/data/knowledge/workbench`. The local SQLite database was copied with the SQLite backup API before activation, retaining previous handoff IDs. The authenticated runner connection uses an SSH-forwarded Unix socket, `/data/knowledge/workbench/orca.sock`, rather than a public TCP listener. It connects to the existing owner-scoped local bridge on port 8791. The reconnecting tunnel is started with `python3 work/run-production-orca-tunnel.py` from the parent workspace. Mac, Orca, bridge and tunnel must remain running; automatic startup after a Mac reboot is not configured. Production does not publish the local Orca web interface; use the desktop app for worker sessions.

Recovery artifacts on the server: `/opt/tencent-workbench/6ebb097/backup/hub-data.tgz`, `backup/rendered-compose.yml`, and image `pyrito/tencent-memory-hub:pre-workbench-6ebb097`. The original Coolify raw compose is saved privately in parent `work/private/workbench-compose-before.yml`. Rollback should restore that raw compose through Coolify, restore the saved rendered compose, and recreate only `memory-hub` with `--no-deps --pull never`. Restore the volume backup only if necessary, with the Hub stopped, accounting for any writes since deployment.

Verified strict HTTPS, healthy release container, authenticated project catalog (17 Orca projects plus the runtime entry), profile catalog, context preview and preservation of the Baren task's existing handoff ID. No additional worker task was dispatched by this deployment. Targeted validation: 36 Panel tests, six bridge tests, Panel typecheck and server image frontend build passed.
