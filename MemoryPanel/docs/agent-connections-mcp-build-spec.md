# Agent Connections & MCP Access

Version 1 — 27 September 2026. Status: planned; no implementation or connector activation is claimed. This is the durable build specification for the Baren project of the same name.

## Planning records

- [Baren project: Agent Connections & MCP Access](https://tencent.167.235.234.97.sslip.io/#/?manageProjects=1&projectDetails=af3d480c-f2a3-4216-be6e-ed66bd433827)
- [Backlog task: Plan and build specification](https://tencent.167.235.234.97.sslip.io/#/?task=task-bcrm04mrnz)
- The task holds the original v1 Markdown attachment. This repository copy adds these navigation links; future revisions should record their version and be reflected in the Baren planning record.
- [Marketing Agent catalog and operator guide](marketing-agents.md)

## Outcome and product flow

Connect a service account once, grant specific capabilities to a Baren Agent, then select the account and narrow access per task. Keep service credentials separate from the user's Claude/Codex subscription and model selection. Keep Orca and cdesktop available; use the existing task-to-project-to-clean-worktree flow. The Agent continues to carry its skills, scripts as source resources, selected Wiki/project context and authorized memory; these materials never grant tool access themselves.

Connections displays service, verified account identity, owner, permitted sharing scope, runtime location, available capabilities and last tested status. Actions: connect, test, reconnect, disable and disconnect. Agent settings chooses explicit tools/resources from authorized connections. Task launch inherits those defaults, allows account selection within authorized bindings and narrower tools/resources, and explains missing readiness. Detailed tools and diagnostics use progressive disclosure. No duplicate sign-in per Agent. No coordinator LLM call is needed to evaluate grants or launch a task.

## Baseline and boundaries

The current local bridge inspection found no per-run MCP isolation/injection in runner.mjs or cdesktop-runner.mjs. Orca inherits its process environment; cdesktop validates supervised executor profiles and rejects arbitrary command/environment overrides. The existing Agent bundle schema contains skills, Wiki references and memory, not connection grants. Existing marketing packages provide source files and context; they do not authenticate services. Recheck these facts against the implementation branch before editing.

This project adds connection management and enforceable grants. It does not replace the worker runtimes, import OpenWorker's agent loop, repair unrelated subscription authentication, enable automatic memory writeback, authorize bulk sends/publishing, or import every connector at once. An MCP tool filter is not an OS sandbox: arbitrary shell/network access and unrelated credentials require a separately verified runtime boundary.

## OpenWorker reuse decision

Use https://github.com/andrewyng/openworker as the reference. Adapt React connection UI and ToolsDisclosure, connector descriptors, curated tool definitions and relevant tests. Port useful Python connection-policy and MCP lifecycle/OAuth logic to the existing TypeScript architecture. Do not add the whole Python engine solely to reuse a small helper. If a Python companion proves necessary, record that decision and its maintenance cost first.

Pin an upstream commit when implementation begins; record copied/ported files and modifications; preserve MIT copyright/permission notices and audit dependencies. The reviewed main branch is research evidence, not a pinned vendor dependency. OpenWorker's connections helper can inherit enabled access and permit session overrides; do not copy those semantics as our authorization ceiling. Its plaintext local JSON secret store is not the hosted multi-user credential design. The source license does not supply OpenWorker Cloud, OAuth app registrations, provider approvals or hosted broker access.

## Proposed architecture and data contracts

Baren is the policy/control plane. A paired worker-side adapter hosts local credentials and local stdio servers where supported. A scoped MCP gateway enforces authorization before upstream invocation. Gateway placement and transport remain Phase 0 decisions: prefer the existing local bridge boundary for local secrets; do not expose an unauthenticated localhost service or assume a hosted page can execute local commands. A hosted gateway needs its own encrypted credential store and explicit ownership/sharing controls.

Logical records (proposed names, not existing APIs):

- ConnectorDefinition: provider key, version, transport/auth mode, pinned tool identifiers/schema hashes, read/write/approval classification, supported resource restrictions and identity check.
- Connection: id, instance/team, owner, explicit authorized principals/projects, provider, verified account/organization identifier, runtime binding, credential reference, lifecycle state, last checked time and policy revision. Secrets are never returned by ordinary read APIs.
- AgentConnectionGrant: instance/team, Agent, connection or explicitly authorized account binding, exact tool allowlist, enforceable resource constraints, approval requirements, grantor and revision. No implicit all-tools wildcard for catalog growth.
- TaskConnectionSelection: task/project, selected account binding and a subset of Agent-granted tools/resources. Store user changes with version checks; the model cannot expand a grant.
- RunCapability: authenticated issuer, audience/runtime, run, task, project, Agent, connection bindings, policy versions, expiry and revocation reference. Issue only after user/team/project authorization and readiness validation. Use short-lived handles; do not put provider secrets in prompts or bundles.
- AuditEvent: actor, team, account reference, Agent, task/run, runtime, tool, resource scope, authorization decision, approval provenance, timestamp and safe error code. Redact payloads and tokens; do not collect full tool output by default.

Connection states: disconnected, connecting, connected, degraded, reconnect_required, disabled and revoked. Record configured/authenticated/discovered/tested independently; an HTTP 200 or a saved configuration is not proof a worker can use the connection.

Effective access is the intersection of live connection authorization, user/team/project access, the Agent grant and the task restriction. Runtime identity must be server-issued, not supplied by model arguments. Deny missing, expired, mismatched or revoked scope. Recheck on every tool call, including direct gateway calls. Filter discovery and reject prohibited invocation even when the tool name is known. Validate connector-specific account/resource parameters before forwarding. If resource restrictions cannot be enforced, disclose the unsupported granularity and block that scoped use case rather than claiming isolation.

Proposed operations: connection list/create/connect/test/reconnect/disable/disconnect; Agent grant read/update; task access preview/update; run capability issue/revoke; gateway tools/list and tools/call; redacted audit retrieval. Preserve existing API routing/auth conventions. Mutations need server-side role checks, optimistic revision checks and idempotency where retries can duplicate state. OAuth requires state/PKCE/callback binding, explicit interactive initiation, safe refresh and actionable reconnect errors. Server-side remote endpoints must enforce destination/redirect policy; local stdio launch must use approved commands and explicit environment allowlists.

## Worker integration requirements

Use supported launch/configuration mechanisms in each runtime. Do not modify the user's global Claude/Codex configuration or silently bypass cdesktop's profile validation. Prove how to prevent inherited global/project MCP servers and subscription-provided connectors from bypassing the selected grants. If a host cannot enforce the selected restriction, block the restricted launch with an explanation; never silently launch with broader access.

Keep upstream credentials behind the gateway. Give each worker only the scoped gateway capability using a supported secure mechanism. Keep the existing skills/Wiki/memory package unchanged except for versioned non-secret capability metadata if required. Bind authorization to the launch identity; switching model/provider must not widen tools or alter the service account. Approval rules are deterministic gateway policy, not prompt text. Destructive or consequential tools need the required user authorization and a trustworthy approval channel.

On revocation/disconnect, reject subsequent calls from existing sessions immediately after the revocation commits. Cancel in-flight operations when the connector supports cancellation; otherwise record that cancellation cannot undo a dispatched operation. Do not retry non-idempotent writes automatically. Worker exit expires the run capability and releases gateway sessions. Runtime restarts must not resurrect revoked grants.

## Delivery plan and exit criteria

P0 — Runtime discovery and design gate. Pin OpenWorker and local runtime versions. Test Orca/Claude, Orca/Codex, cdesktop/Claude and cdesktop/Codex separately; mark unsupported combinations explicitly. Use a disposable local MCP fixture to prove isolated configuration, authenticated run identity, tool denial, approval signaling, callback reachability and cancellation. Record chosen gateway placement, secret backend and transport. No downstream launch-isolation claim until this passes.

P1 — Connection lifecycle. Implement scoped persistence, secure credential references, account identity, connect/test/reconnect/disable/disconnect and status UI. Demonstrate two distinguishable accounts for one provider, restart/refresh recovery, host availability and secret redaction. Sharing is explicit; never equate team membership with every private connection.

P2 — Agent grants and task selection. Build the deterministic policy service, Agent tool/resource UI, launch preview, task narrowing, catalog-change handling and audit. Pass authorization tests without relying on a model or UI. Existing Agents begin with no new grants.

P3 — Gateway and worker adapters. Implement the authenticated per-run gateway and supported Orca/cdesktop adapters. Prove actual tools/list and harmless tools/call through each supported worker combination; verify unrelated inherited tools cannot bypass policy. Preserve clean worktree selection, context handoff and normal worker behavior.

P4 — SEO Audit read-only pilot. Start with one selected MCP service and explicitly authorized client account. Red Barn Investment Counsel (https://www.redbarninvestmentcounsel.ca/) is the candidate audit target, not proof of account access. Choose the connector and exact scopes in P0; do not assume Search Console or analytics credentials exist. Complete an evidence-led audit, then demonstrate task narrowing, denied access, disconnect and revocation. Reuse the same connection for a second explicitly granted Agent without another sign-in.

P5 — Controlled expansion. Add write capabilities only after reliable approval/denial tests and explicitly authorized canaries. Add connectors and marketing Agents incrementally. Keep unsupported combinations and account-scope limits visible. Publish a support matrix and operator recovery instructions.

## Acceptance test matrix

1. One connection serves two authorized Agents without duplicate authentication; an ungranted Agent cannot list or invoke its tools.
2. A task can narrow tools/resources; expanding beyond its Agent grant is rejected server-side.
3. Cross-team, cross-user, cross-Agent, cross-project, cross-account and mismatched run identifiers fail before secret retrieval or upstream invocation.
4. Two accounts for one service route only to the explicitly selected account. Resource arguments cannot switch the client silently.
5. Model changes and Claude/Codex switching preserve account and permission choices; service reconnection is not caused merely by model selection.
6. Newly discovered tools receive no automatic grant. Removed tools and changed schemas require reconciliation before use.
7. Expiry refresh is safe; rejected refresh produces reconnect_required without opening a browser in the background.
8. Revocation/disconnect blocks new calls from already-running workers. In-flight semantics and no-retry rules are verified.
9. Direct tools/call cannot bypass tools/list filtering, identity checks, grants, resource checks or approvals.
10. Provider secrets never appear in prompts, bundles, generated worker configuration, transcripts, Wiki/memory, ordinary API responses or audit logs. Redaction covers upstream errors.
11. Invalid/expired/wrong-audience run handles are denied; reconnecting a worker does not restore revoked access.
12. Unsupported configuration isolation blocks restricted launches; original global MCP settings remain unchanged after completion, failure and cancellation.
13. Approval denial/cancellation causes no upstream write. Approved write canaries are bounded, attributable and not duplicated on retry.
14. Existing Task Board dispatch, project selection, clean worktree creation, Agent package delivery and Orca/cdesktop behavior pass regression checks.
15. UI persists changes across reload, states clearly identify the account/runtime, keyboard operation works, and details remain progressively disclosed.

## Rollout, rollback and completion evidence

Use additive migrations and feature flags for new connections and per-runtime adapters. Back up relevant configuration/policy data and rehearse migration/rollback on a fixture. First enable a private read-only pilot. Rollback disables new capability issuance and revokes active handles before reverting adapters; it must never fall back to broader tool access. Preserve audit and policy records; do not delete user credentials as incidental cleanup.

Done requires recorded source revisions, license notices, unit/integration results, negative authorization tests, the supported-runtime matrix, live read-only pilot evidence, approval canaries for any write feature, secret/redaction checks, and documented reconnect/revocation/rollback behavior. Track implemented, tested, deployed and visibly working separately. No implementation, runtime launch, paid research, external writes or deployment is authorized by this planning record alone.

## Primary references

- License: https://github.com/andrewyng/openworker/blob/main/LICENSE
- Connection policy: https://github.com/andrewyng/openworker/blob/main/coworker/connections.py
- MCP configuration/client/OAuth/tool adapters: https://github.com/andrewyng/openworker/tree/main/coworker/mcp
- Catalog: https://github.com/andrewyng/openworker/blob/main/coworker/connectors/descriptors.py
- Tool classifications: https://github.com/andrewyng/openworker/blob/main/coworker/connectors/tool_defs.py
- React UI: https://github.com/andrewyng/openworker/tree/main/surfaces/gui/src/components/connectors
- Secret store: https://github.com/andrewyng/openworker/blob/main/coworker/secrets.py
- Cloud dependency: https://github.com/andrewyng/openworker/blob/main/coworker/cloud.py
- Reference tests: https://github.com/andrewyng/openworker/blob/main/tests/test_mcp_connectors.py

Local integration points reviewed: MemoryPanel/scripts/workbench/runner.mjs; MemoryPanel/scripts/workbench/cdesktop-runner.mjs; MemoryPanel/src/panel/workbench/agent-bundles.ts. These paths identify adaptation surfaces, not completed features.
