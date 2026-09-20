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

Not yet deployed to Coolify or verified against the live task dataset. Labels, checklists, dependencies, subtasks, linked Wiki selection and agent execution controls remain subsequent work.
