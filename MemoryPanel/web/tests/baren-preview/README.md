# Isolated Baren preview

This development-only entry mounts the real `App`, auth flow, router, shell and page components with entirely invented data. It never calls a backend, a model or a worker runtime. Its fixture records reset on full reload; changes persist only while that document remains open.

From `MemoryPanel/web`:

```sh
npm exec vite -- --config tests/baren-preview/vite.config.ts
```

Open [Today](http://127.0.0.1:5191/#/today). The server listens only on `127.0.0.1:5191`; stop it with Ctrl+C. It uses a separate Vite config with **no proxies** and rejects `/api`, `/v3` and `/health` network requests with HTTP 501. The browser fetch interceptor never calls the original fetch; unknown reads and writes fail explicitly. XHR and beacon calls are disabled, and CSP disallows frames and external connections. Runtime pages show their real disconnected/selection interfaces; no iframe or worker session launches.

## Scenarios

Query parameters go before the hash route. Example: `/?scenario=empty&role=member#/projects`.

| Parameter     | Values                                                      | Default                         |
| ------------- | ----------------------------------------------------------- | ------------------------------- |
| `scenario`    | `populated`, `empty`, `loading`, `error`                    | `populated`                     |
| `role`        | `admin`, `member`, `reviewer`                               | `admin`                         |
| `onboarding`  | `1` to show first-run onboarding                            | hidden                          |
| `auth`        | `login` to show the real login UI                           | synthetic authenticated session |
| `coordinator` | `offline`, `error`, `conflict` (first approval returns 409) | synthetic ready state           |
| `analytics`   | `off` to hide the capability                                | enabled                         |

The auth, team membership and capability responses stay available in loading/error scenarios so the shell remains usable while the pages exercise their normal states. `empty` keeps the team and members but removes work/resources. Identity/session labels use document-local in-memory storage, so parallel role/login tabs do not change each other. No native localStorage is read or written by the fixture.

## Implemented synthetic mutations

- Create/update/delete tasks; task board state and revision-checked transitions.
- Create/update/archive projects and project assignments.
- Approve/reopen synthetic timesheet entries.
- Start human loop occurrences, creating an in-memory task and project assignment. A repeated request ID returns the same occurrence; a different request ID for an occupied scheduled deadline returns HTTP 409 with its `occurrenceId`, matching the backend. Agent handoffs are explicitly refused.
- Coordinator messages, task creation proposals, revision-checked Apply and Dismiss. Include “create” or “propose” in a message to generate a proposal.

Other actions return an explicit “Synthetic preview does not implement…” error. This boundary is intentional: a successful fixture interaction validates UI wiring only, never backend authorization, payment, ingestion, real LLM output or native runtime behaviour.

`window.__barenPreview` holds synthetic request logs, blocked requests and fixture state for test diagnostics. It contains no user credentials or production data.

## Loop performance data

Dates are relative to the document's load day in `Europe/Madrid`. The fixture uses the backend's pure calendar helpers to calculate actual recurrence slots, completion periods and summary statistics. Completed occurrences have historical `completed_at` timestamps; flexible occurrences have no scheduled deadline.

The weekly product review has nine accepted occurrences, including two late completions; two skipped deadlines; an unstarted overdue deadline 21 days ago; and a deadline due today. Its unoccupied overdue deadline exercises **Start**. The customer conversation loop has seventeen completed occurrences across the last 90 days and one open human occurrence linked to `baren-task-3`, which exercises **Continue**. Historical task details live in the separate `loopTasks` pool and are available through single-task API reads; the original seven-task board and time fixtures stay unchanged. Starting new work adds a task to the board.

For inclusive windows ending today (`today − days + 1` through today), expected initial counts are:

| Window  | Scheduled completions | Flexible completions | Total completions | Scheduled on time / completed | Overdue deadlines | Skipped deadlines |
| ------- | --------------------- | -------------------- | ----------------- | ----------------------------- | ----------------- | ----------------- |
| 7 days  | 0                     | 2                    | 2                 | 0 / 0                         | 0                 | 0                 |
| 30 days | 3                     | 9                    | 12                | 2 / 3                         | 1                 | 0                 |
| 90 days | 9                     | 17                   | 26                | 7 / 9                         | 1                 | 2                 |

These records verify the UI's date filtering and start/continue wiring. Loop completion, skipping and timer mutations remain unsupported by this preview.

## Validation

```sh
node --import tsx --test tests/baren-preview/mock-api.test.ts
npm exec tsc -- --noEmit --project tests/baren-preview/tsconfig.json
npm exec prettier -- --check 'tests/baren-preview/*.{ts,tsx,json,html,md}'
```

The production Vite build lists only `web/index.html`; this entry is not imported by product code or included in that build. The entry also refuses non-development and non-localhost execution. Never deploy the development server.
