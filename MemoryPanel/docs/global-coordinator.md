# App-wide Coordinator

The shared console shell replaces the task-page team card with a compact chat. Its conversation survives navigation and is stored per instance, team and signed-in user in `WORKBENCH_DATA_DIR/coordinator.sqlite`. Conversation history is expandable; normal app controls remain available.

The model connection uses `WORKBENCH_LLM_API_KEY`, `WORKBENCH_LLM_MODEL`, and `WORKBENCH_LLM_BASE_URL` (OpenRouter by default). These remain server-side. Direct Orca handoffs continue to work without a coordinator model call.

## Actions and boundaries

`src/panel/coordinator/actions.ts` is the explicit action registry. The model can read through it or propose one change at a time. Each change has an Apply/Cancel review. Approval is tied to the saved proposal ID and conversation revision; a retry cannot repeat an executed proposal. Interrupted writes are marked unknown and require checking the app. Auth and active team membership are rechecked on each request; the action itself uses the existing authenticated endpoint.

Coverage includes task and agent records, projects, areas, loops, time tracking/review, task notes, linked Wiki context, Orca project creation/handoff/status, Wiki and code-graph reads, Wiki source text/ingestion, skills and memory search. It is not yet every app function: credential management, membership changes, permanent deletion, binary uploads, payments, code-graph creation, memory import/binding, and board-transition controls stay in their dedicated UI. Existing unavailable Core board endpoints are not replaced or upgraded by this feature. API errors are surfaced rather than described as successful changes.

Model read results are bounded and credential-shaped fields are removed. User-readable content is treated as untrusted context. There is no arbitrary URL, shell, or credential tool. The server keeps the latest 100 conversation entries and sends at most 24 to the model per step, with eight read steps per turn. The model can still misunderstand requests; the visible proposal and existing app permissions remain the execution boundary.

## Verification

`npm test` and `npm run typecheck` in MemoryPanel; `npm run build` in MemoryPanel/web. `tests/global-coordinator.test.ts` covers user isolation, removed memberships, credential redaction, fixed action paths, foreign resources/teams, GET filters, proposal approval, stale/replayed approvals and ambiguous write failures.

Live browser checks: project listing using the configured model, conversation retained when moving Upcoming to Projects, and proposal/cancellation without executing the proposed project creation. Production rollout is separate from those local checks.

## Deployment, 2026-09-26

Production Hub image: `pyrito/tencent-memory-hub:coordinator-d04fa87`, source commit `d04fa87`. Core and Proxy unchanged. The configured Coordinator model is `openai/gpt-5.6-sol`; credentials are server-side. Production authenticated state/read check passed and the browser shows the shared chat on Projects and Upcoming. All 107 Panel tests, typecheck and web build passed before rollout.

Rollback image: `pyrito/tencent-memory-hub:pre-coordinator-d04fa87`. Consistent Hub volume backup and prior rendered Compose are in `/opt/tencent-workbench/d04fa87/backup/` on the server. Restore the image/config through both Coolify's stored raw Compose and the rendered service Compose if rolling back; do not overwrite newer data unnecessarily. GitHub push failed because CLI authentication was unavailable; the commit exists locally and the exact archive is on the deployment server.
