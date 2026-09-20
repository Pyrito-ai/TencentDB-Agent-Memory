# Workbench: coordinator + Orca subscription workers

This feature branch adds `/workbench` to Memory Hub alongside the existing task board. It implements a first vertical slice: plan → human-approved dispatch → separate Orca worktree → inspect output → advisory coordinator review.

The coordinator uses an API model. The worker is a real Codex or Claude Code process launched by Orca, using the account already authenticated on that runtime. No worker model requests are routed through Tencent's model proxy. Orca does not guarantee a subscription is selected: the runtime owner must verify the client's login and remove any unwanted API billing configuration.

## Components

- Panel routes: `/api/v1/workbench/:team/options|runs|plan|dispatch|refresh|review`.
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

Open Workbench, select a runtime, enter an objective, and optionally attach a Tencent task ID and relevant memory/Wiki excerpts. Preparing a plan makes an API call but launches no workers. Read each worker's ownership and acceptance criteria, then approve dispatch. Refresh to read output. Request an advisory review when evidence is available. Inspect the actual diff and checks in Orca before merging.

Orca's native UI remains the place to answer interactive login/permission prompts, steer or stop workers, and inspect/merge diffs. This surface does not embed Orca's full editor/terminal renderer yet. Setup hooks are skipped; repository setup may need to be included in the approved task or performed on the runtime first.

## Current boundaries

- Manual context excerpts plus an authorized Tencent task are supported. Automatic memory retrieval, MCP provisioning, and memory write-back are not implemented.
- No autonomous scheduling, dependent task DAG, automatic retries, merges, deployment, or automatic completion verdicts.
- Coordinator review is advisory and treats terminal output as untrusted evidence.
- One Panel process and one bridge process per storage directory; distributed dispatch locking is not implemented.
- Terminal output can contain sensitive project data. Only the owning Tencent user can retrieve it; retention follows the private run/bridge stores. Do not use shared customer runtimes.
- No live deployment or subscription worker launch is performed by tests.

## Validation

`npm run typecheck`, `npm test -- tests/workbench.test.ts`, and `node --test scripts/workbench/runner.test.mjs` in MemoryPanel; `npm run build` in MemoryPanel/web. The bridge tests exercise HTTP auth, approved repositories, duplicate requests, persisted receipts after restart, and ambiguous execution outcomes using a fake Orca command. The UI fixture is `/tests/workbench-preview/index.html` on Vite and clearly labels synthetic data.

CLI contract references: Orca `src/cli/handlers/worktree.ts`, `src/cli/handlers/terminal.ts`, `src/shared/runtime-worktree-contracts.ts`, and `docs/site/content/docs/cli/reference.mdx`. A live subscription-backed smoke run remains required before calling the integration production-ready.

Development verification: 31 Panel tests and 2 bridge tests passed; TypeScript and frontend production build passed. The browser fixture was exercised through plan, approval, output, and review. The installed Orca runtime answered `status --json`. No actual worker was launched. CLI source inspected at Orca commit `0cc2b2688d8a4bfe2f69634ad7cdbf2bc8601552`.
