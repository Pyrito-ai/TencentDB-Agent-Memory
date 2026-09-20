# Project task board — first version

A project task remains independent of an agent session. People can create tasks, move work through five stages, assign a teammate, set priority/due date, edit a brief and acceptance criteria, add notes, and upload/download files without invoking an LLM or starting a session. Existing linked-agent and participation records remain available in task details.

## Data and compatibility

`metadata_json.project_board` stores workflow, assignee, priority, dueDate and acceptanceCriteria. Existing metadata namespaces are preserved. New tasks start in Backlog. Legacy running tasks display In progress and completed tasks display Done. Moving to Done writes the core's `completed` lifecycle status; other columns write `running`, retaining compatibility with existing agent clients. Manual card ordering within a column is not included; cards use update time.

The board fetches every API page before applying filters. It provides title/description search and assignee/priority filters. Drag-and-drop has an equivalent native select for keyboard and touch users. Failed edits keep the draft open; failed moves do not change the displayed status.

Task field editing and deletion follow the upstream creator-only backend rule. Other active team members may read/add notes and attachments; the activity author or task creator may remove an activity. Broader collaborator/assignee edit permissions require a separate backend policy change. The fork does not claim to remediate all upstream tenant authorization behavior.

Notes and attachments use new authenticated Panel routes under `/api/v1/task/activity/:taskId/`. Every request verifies the caller and current active team membership. Storage paths are derived from instance and task IDs; uploaded names are never filesystem paths. Downloads are attachment-only, octet-stream, no-store, nosniff. Maximum file size is 10 MB; notes are capped at 20,000 characters. These files are not automatically indexed into Wiki or memory.

## Deployment requirement

Set `TASK_BOARD_DATA_DIR=/data/knowledge/task-board` for the bundled Hub, using its existing persistent Knowledge volume, and include that directory in backups. For standalone Panel deployments, mount a persistent directory explicitly. Default local path: `data/task-board`. Do not deploy with ephemeral storage. Both Panel backend and frontend need rebuilding; the Core and Proxy images can remain pinned upstream images.

Notes and attachments are retained on disk if the parent task is deleted, but become inaccessible through the API. Retention cleanup, storage quotas, and multi-replica shared storage are not implemented. Metadata updates inherit upstream last-writer-wins behavior; concurrent task-field edits are not conflict-aware. Notes use separate, atomically published records to avoid lost concurrent appends.

## Verification

- `cd MemoryPanel && npm test`: task status compatibility, metadata preservation, concurrent notes, isolation by task/instance, current membership, attachment byte round trips, safe download headers, deletion permissions, size and traversal rejection.
- `cd MemoryPanel && npm run typecheck`
- `cd MemoryPanel/web && npm run build`
- Synthetic browser fixture: run `node --import tsx scripts/board-preview-server.ts` in MemoryPanel and `npm run dev -- --host 127.0.0.1` in MemoryPanel/web. Visit `/tests/board-preview/index.html`. Fixture tasks are in-memory; activity uses temporary local storage and no production credentials. No production API calls are made by this fixture.

The board release was deployed to Coolify and verified with a disposable task, note, and attachment round trip through the public HTTPS service. Labels, checklists, dependencies, subtasks, linked Wiki selection and agent execution controls remain subsequent work.

## Human time tracking

Task details include a start/stop timer, manual past-work entries (1 minute to 24 hours), optional work notes, and totals by teammate. Active team members can log their own time regardless of who created the task. Entries are attributed from the authenticated session; only their author can stop a timer or remove a completed entry. A person can run one timer per instance at a time. Timers use server timestamps and continue while the browser is closed.

Time records are stored in `TASK_BOARD_DATA_DIR/time.sqlite` using SQLite WAL and an atomic uniqueness constraint for running timers. Back up the persistent directory consistently, including SQLite sidecar files, or stop the Hub before copying. Node 22 with node:sqlite support is required. Tests cover concurrent starts, restart persistence, authorship, active membership, task/instance isolation, and manual duration validation. Browser QA verified timer start/stop and manual entries updating totals.

This version provides task-level tracking, not billing, timesheet exports, or organization-wide reports. Stop a timer before deleting its task or removing its author from the team; retained records on inaccessible tasks currently require administrator maintenance.

## Projects and team timesheets

Projects are first-class, team-scoped records in the persistent Panel SQLite database (`time.sqlite`), with stable IDs, names, descriptions, creator, creation time, and archive state. `task_projects` associates a Core task ID with one project; this extends the Panel data model without modifying upstream Core tables. Projects are not yet exposed through the Core MCP interface. Team members can create projects; their creator or a team admin/owner can rename/archive/restore them. Task creators and team admins/owners can assign tasks to an active project in the same team. Archiving retains links/history. The board offers project creation, editing, filtering, and task assignment.

Workbench → Timesheets provides contributor and inclusive UTC date filters, entries across tasks, daily and period totals, and CSV. Entries belong in full to their UTC start date; crossing midnight does not split or duplicate an entry. Running timers are flagged and excluded from completed, pending, payable, and paid hour totals. Normal active members see their own timesheet; active reviewers, team admins and team owners see the team. Reviewer/admin/owner can approve or return approved time to pending; only admin/owner can mark approved entries paid. Global administrator status alone does not bypass active team membership.

Payment marking records an already completed external payment; it does not transfer money. A payment reference is required. Batch transitions run in a SQLite transaction and reject the entire batch if any record is stale, running, from another team, or ineligible. Only approved unpaid time contributes to payable totals. Approval locks deletion; paid entries cannot be reopened, deleted, or marked paid a second time through the application. Audit events record actor/action/time/reference. Authors can remove only their own pending completed entries. Corrections to paid records require a future audited adjustment workflow; the UI does not silently rewrite payment history. This prevents duplicate marking of an entry, not duplicate external transfers or manually duplicated time logs.

Time entries retain task/team/project snapshots. Pending time follows task project changes; approval records the current project, which stays fixed while approved/paid even if the task moves, the project is renamed, or the task is deleted. Existing time rows migrate additively, defaulting to pending; team/title attribution is resolved from Core tasks. Unresolvable legacy tasks are flagged to team administrators for reconciliation instead of silently treating the report as complete. Existing pre-migration deleted tasks need administrative recovery to determine their team.

CSV includes stable entry/person/task IDs, task and project names, start timestamps, exact seconds and decimal hours, notes, approval/payment actors and timestamps, and payment reference. Formula-like cells are neutralized and quotes/newlines escaped. Rates, currency, tax, payment execution, and financial amount calculations are not included.
