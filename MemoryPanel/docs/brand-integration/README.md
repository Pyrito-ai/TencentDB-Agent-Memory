# Pyrito branding integration

Integrated the dark amber Pyrito branding onto the latest remote app, including the newer private Ops notes and Coordinator discussion work.

## Source and scope

| Layer                   | Source                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Latest app base         | `origin/feat/server_team` at `634505f334a42044ac2da5b9588fca5b12b36f27` (includes PR16)                                          |
| Branding                | Uncommitted work in `../tencent-workbench`, branch `codex/pyrito-app-brand`, based on `e29edf6c58536a5f8fa6dbf9acca21705689a1fb` |
| Newer Ops functionality | Uncommitted work in `../pyrito-gmail-connections`, branch `codex/gmail-connections`, based on the same `e29edf6` revision        |
| Integration             | `../pyrito-brand-integration`, branch `codex/pyrito-brand-integration`                                                           |

The two source worktrees remain unchanged. Their tracked diffs and new files were captured in the ignored `.integration-snapshots/` directory, with a SHA-256 manifest. The source snapshots were checked against both worktrees after integration.

The branding includes the supplied crystal mark, lowercase wordmark, dark surfaces, amber actions, warm text, shared semantic and Tea tokens, smaller radii, restrained dock movement, and revised login, header, Guide, Coordinator, Today, and reading surfaces. See [the original branding notes](../pyrito-brand-alignment.md).

Additional integration adjustments apply those tokens to Ops notes, fill missing Tea warning/success tokens, use the theme focus ring for onboarding, and fit the eight-control dock at 320px. Existing routes, labels, role filters, and application behavior remain in place.

## Functional preservation

- Latest cdesktop gateway, authentication, logout revocation, and browser-session files remain unchanged from the latest app base. No runtime worker is launched by navigation or branding controls.
- Private Markdown notes and their owner/revision checks are retained. Discussing a note attaches its reference to the Coordinator; the server resolves the current authorized note. Saving a proposed change still requires Apply.
- Coordinator conversation and draft state persist through route changes. On narrow screens the Coordinator occupies layout space below the app rather than obscuring it.
- The sole three-way merge conflict was in Panel shutdown. Both the Ops scheduler stop and the runtime gateway close are retained, alongside telemetry shutdown.
- No dependencies, production configuration, databases, remote branches, or deployments were changed by this integration.

## Verification

| Check                                                                                    | Result                                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Panel TypeScript check                                                                   | Passed                                                          |
| Frontend TypeScript and Vite build                                                       | Passed; existing mixed-import and bundle-size advisories remain |
| Frontend lint                                                                            | Passed with zero errors and 31 existing warnings                |
| Formatting of changed/new source files                                                   | Passed                                                          |
| Gateway, browser-session, runtime visibility, private Ops, and Coordinator Vitest suites | 186 tests passed                                                |
| cdesktop browser-server and runner Node tests                                            | 29 tests passed                                                 |
| Ops Markdown and preview fixture tests                                                   | 13 tests passed                                                 |

Total: **228 focused tests passed**. Tests requiring loopback listeners initially encountered sandbox `EPERM`; those suites passed when rerun with local listener permission.

Authenticated browser verification used synthetic data in this integration checkout:

- Discussed a note, requested an addition, reviewed the proposal, applied it, and confirmed the note changed.
- Confirmed the Coordinator draft and note context survived navigation to Task board.
- Created a synthetic task and opened its detail view.
- Reviewed Today, Ops, Task board, Loops, Workbench, Knowledge, Memory, Agents through More, and login. Logged out and verified the Pyrito login screen; a reload restores the preview identity.
- At 320px, all eight dock controls fit with a 304px scroll/client width and no document overflow. More remained keyboard accessible.
- At 390px, selecting a note focused the composer and the Coordinator began at the work area's bottom edge, without overlaying the app.

Live provider authentication, live mail, production mutations, and a real native cdesktop session were not exercised in this pass. The preview is synthetic; the gateway regression suites establish preservation of the newer runtime behavior.

## Preview

Open [the integrated preview](http://127.0.0.1:5195/#/ops). It uses an isolated synthetic backend on `127.0.0.1:8195`; it does not contact a real model or mailbox. Each backend start creates a fresh encrypted fixture database under the ignored `.ops-preview/` directory.

Run the following in separate terminals from this worktree. Node 22 matches the installed SQLite native dependency:

```sh
cd MemoryPanel
/opt/homebrew/opt/node@22/bin/node --import tsx scripts/ops-preview-server.ts
```

```sh
cd MemoryPanel/web
/opt/homebrew/opt/node@22/bin/node node_modules/vite/bin/vite.js --config tests/ops-preview/vite.config.ts
```

The earlier [private Ops notes](../private-ops/README.md) describe the source preview on ports 5193/8193. This integration uses 5195/8195 so it can run alongside that preview.

## Screenshots

- [Ops and Coordinator](screenshots/ops-desktop.png)
- [Today](screenshots/today-desktop.png)
- [Login](screenshots/login.png)
