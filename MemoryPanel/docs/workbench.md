# Workbench: coordinator + Orca subscription workers

This feature branch adds `/workbench` to Memory Hub alongside the existing task board. A full-width coordinator band sits above **Orca's actual browser renderer**, loaded from a configured browser-client URL in a separate-origin iframe. The band can expand or collapse and retains conversations, context, worker proposals, and explicit launch approval. The earlier custom three-pane worker UI has been replaced.

Orca ships `web-index.html`, whose `src/renderer/src/web/main.tsx` installs the browser transport and mounts the same `App` used by its desktop renderer after pairing. We reuse that interface directly. Orca supplies the sidebar, terminals, worktree controls, files, diffs, and review UI; availability depends on the paired Orca version.

The coordinator uses an API model. The worker is a real Codex or Claude Code process launched by Orca, using the account already authenticated on that runtime. No worker model requests are routed through Tencent's model proxy. Orca does not guarantee a subscription is selected: the runtime owner must verify the client's login and remove any unwanted API billing configuration.

## Components

- Panel routes: `/api/v1/workbench/:team/options|runs|start|message|plan|dispatch|refresh|workspace|file|send|stop|decision|review`.
- The existing Tencent auth and active team membership check protect every request. Plans and receipts are scoped to instance, team, and user.
- A server-managed binding grants one user access to one runner/repository. URLs, credentials, CLI arguments, and repository selectors are never accepted from the browser or coordinator output.
- A private Node bridge runs beside Orca under the same OS user. It invokes `worktree create --agent ... --prompt ... --setup skip --no-parent --json` using an argument array, never a shell.
- The bridge persists a launch intent before executing. Repeating the same job ID cannot launch another worker, including after restart. An ambiguous outcome requires local reconciliation; it is never retried automatically.
- Receipts and plans persist in SQLite. Worker output is displayed as text. A terminal exiting is not treated as task success.

## Configure a dedicated runtime

Run one bridge process per Orca owner/runtime. Do not share an OS account, home directory, credentials, or writable repository across unrelated customers. Git worktrees are not a security sandbox. This first version is intended for a trusted single-owner pilot; a shared-host SaaS execution service needs isolated tenant runtimes.

1. Install/open Orca, register the intended repository, and sign into Codex or Claude Code on that host. Check `orca status --json` and `orca repo list --json`.
2. Create a mode-0600 JSON configuration outside the repository:

```json
{
  "token": "GENERATE_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS",
  "orcaBinary": "/absolute/path/to/orca",
  "dataDir": "/absolute/private/path/workbench-jobs",
  "repos": ["id:YOUR_ORCA_REPOSITORY_ID"],
  "host": "127.0.0.1",
  "port": 8791
}
```

3. Start `WORKBENCH_RUNNER_CONFIG=/private/config.json node scripts/workbench/runner.mjs` from MemoryPanel. Keep one process per data directory. Loopback is the default. For a remote panel, use a private tunnel or HTTPS reverse proxy; do not expose plain HTTP or put the bearer token in a URL.
4. Create a mode-0600 bindings file on the Panel host:

```json
[
  {
    "id": "john-tencent",
    "label": "John’s Orca · Tencent",
    "instance": "default",
    "team": "EXACT_TENCENT_TEAM_ID",
    "user": "EXACT_TENCENT_USER_ID",
    "repo": "id:YOUR_ORCA_REPOSITORY_ID",
    "url": "https://PRIVATE_RUNNER_HOST",
    "webUrl": "https://PRIVATE_ORCA_WEB_HOST/web-index.html",
    "token": "SAME_RANDOM_RUNNER_SECRET"
  }
]
```

5. Set Panel environment:

```text
WORKBENCH_BINDINGS_FILE=/private/bindings.json
WORKBENCH_DATA_DIR=/persistent/workbench
WORKBENCH_LLM_BASE_URL=https://openrouter.ai/api/v1
WORKBENCH_LLM_MODEL=openai/gpt-5.6-sol
WORKBENCH_LLM_API_KEY=<coordinator key>
```

The coordinator key is explicit: it does not silently borrow the Wiki, memory, or proxy key. The user may intentionally assign an existing key. Restart Panel after configuration. Bindings are read afresh per request, so removing a binding blocks further access to that runtime through this surface.

## Try it

Open Workbench, select a runtime, and send an objective to the coordinator. Optionally attach a Tencent task ID and relevant memory/Wiki excerpts. Conversation messages make coordinator API calls but do not launch workers. Read a proposed worker's ownership and acceptance criteria, then approve its launch.

The coordinator remains in the top band while Orca fills the rest of the page. Use the conversation selector to resume saved conversations, Context for excerpts, and expand/hide to adjust the band. Approve proposals in the band, then inspect and steer the worker in Orca. “Sync workers” refreshes the coordinator's dispatch receipts from the bridge.

## Connect the real Orca interface

`webUrl` is optional and administrator-managed per user/team/runtime binding. It must be HTTPS (or loopback HTTP for development), use a separate origin from Tencent, and contain no credentials, query, or fragment. Serve Orca's browser build (`out/web`, built upstream with `pnpm build:web`) on that origin, or use the runtime's existing browser endpoint. Preserve assets and upstream license when distributing a copy. The host must permit framing by the Tencent origin. HTTPS Tencent needs HTTPS Orca and a reachable secure WebSocket endpoint. A browser loopback URL refers to the user's computer, not the Tencent server.

Pair inside Orca's own connection screen using its runtime browser-access link. Tencent never forwards its login or bridge bearer token to the iframe, reads Orca's pairing storage, or exchanges arbitrary postMessage commands. The coordinator bridge and paired interface must target the same Orca runtime. Selecting a Tencent conversation does not automatically select an Orca worktree; runtime identity matching is not yet automatically verified. Navigate to the created worker in Orca's sidebar.

**Orca browser pairing is a separate access grant.** Full runtime pairing can expose repositories and terminals beyond the coordinator bridge's allowlisted repository. Use a dedicated runtime for the intended owner. Tencent team authorization does not narrow an Orca pairing grant. Revoking a Tencent binding does not revoke an existing Orca pairing; revoke that separately in Orca.

The local preview loads the real browser bundle from installed Orca 1.4.196 at loopback port 5188. Coordinator conversations and approvals remain synthetic. It initially displays Orca's genuine connection screen. Pairing enables live control inside the Orca pane. The bundle is a local verification artifact, not checked into Tencent or deployed. A paired session remains unverified pending approval.

The prior scoped file/diff/review API and tests remain available, but the primary UI delegates those interactions to Orca. No worker launch or production deployment is implied by opening this page.

## Current boundaries

- Manual context excerpts plus an authorized Tencent task are supported. Automatic memory retrieval, MCP provisioning, and memory write-back are not implemented.
- No autonomous scheduling, dependent task DAG, automatic retries, merges, deployment, or automatic completion verdicts.
- Coordinator review is advisory and treats terminal output as untrusted evidence.
- One Panel process and one bridge process per storage directory; distributed dispatch locking is not implemented.
- Terminal output can contain sensitive project data. Only the owning Tencent user can retrieve it; retention follows the private run/bridge stores. Do not use shared customer runtimes.
- No live deployment or subscription worker launch is performed by tests.

## Validation

Run `npm run typecheck` and `npm test` in MemoryPanel, `npm run build` and component ESLint in MemoryPanel/web. 39 Panel tests, TypeScript, frontend production build, and component ESLint passed. Browser checks confirmed band collapse/restore and a sample coordinator reply without replacing the Orca iframe. This revision adds browser-URL validation tests for HTTPS, loopback, credential rejection, and pairing-token rejection. The unchanged bridge/workspace suite previously passed four tests.

The revised browser fixture loads the actual Orca connection screen beneath the coordinator band. Coordinator actions remain synthetic; the Orca pane becomes live if paired. Prior custom-UI browser checks are not proof of the new embedded runtime connection.

Orca source inspected at `0cc2b2688d8a4bfe2f69634ad7cdbf2bc8601552`; local browser bundle from installed Orca 1.4.196. No live worker launched and no production deployment performed. A paired end-to-end run is required before calling this production-ready.

## Live local Workbench — 2026-09-21

Use `/workbench/index.html` on the local Vite host. `/tests/workbench-preview/index.html` is explicitly a demo and does not dispatch tasks. The live page has no fetch replacement. It uses real Tencent owner authentication through the loopback-only `scripts/workbench/local-server.ts`, a short-lived HttpOnly browser cookie, the existing Workbench routes, Sol via the supplied Model Proxy OpenRouter key, and the local Orca bridge. The long-lived Tencent owner key and provider key stay server-side. This local single-owner helper is not a production authentication service; production uses normal Tencent sessions.

Start the bridge with `WORKBENCH_RUNNER_CONFIG=/private/runner.json node scripts/workbench/runner.mjs`. Start the local development backend with `WORKBENCH_LOCAL_CONFIG=/private/local.json node_modules/.bin/tsx scripts/workbench/local-server.ts`. The private local config specifies `ownerKeyFile`, `tencentUrl`, `instance`, `browserOrigin`, and an `env` map containing normal Panel instance/auth paths plus `WORKBENCH_*` coordinator configuration. It listens only on 127.0.0.1:8123, reached through the Vite proxy. Browser bootstrap requires the configured origin's referrer; cross-origin writes and requests without the local cookie are rejected. Restarting the helper invalidates the cookie; reload the live page to reconnect.

An owner runtime binding with `manageProjects:true` and `repo:"managed"` enables project discovery and creation. The bridge's `repos` allowlist still controls existing project access. Its optional `projectRoot` controls where new repositories are created; project names cannot contain paths or shell syntax. Creation initializes a local Git repository, makes a README baseline commit with hooks disabled, and registers it with Orca. No remote repository is created or pushed. Newly created IDs persist privately in the bridge's project registry.

The coordinator can propose selecting an existing project or creating a named project, with an explicit **Confirm project** action. The project picker and **New project** control provide direct alternatives. Worker dispatch is refused while the conversation has no selected project; once workers have launched, change projects in a new conversation. Project selection is included in the coordinator context and every launch resolves it server-side.

Live verification: authenticated owner/team access, real project listing, creation of `workbench-verification`, a real Sol proposal, and approved dispatch all succeeded. Orca created worktree `tencent-cc09ca72-885e-414b-af57-53785c002228` and Codex terminal `term_601bfdae-5d82-43f2-a2a5-f1565f7f79ee` with the bounded verification instructions. Codex paused at **Hooks need review** before execution. The file-writing test is therefore not complete; the user can choose **Continue without trusting** in the Codex terminal to proceed without enabling the new hook. No hook was trusted by the integration. Refresh through **Sync workers** and inspect **Worker output / startup prompts** for actual evidence; terminal running is not task success.

Validation for this revision: 40 Panel tests, 5 bridge/project/workspace tests, TypeScript, frontend build, and component ESLint passed. Browser checks covered the real authenticated page, project creation, coordinator response, approved dispatch, and persistent receipt after reload. Production deployment remains unchanged.
