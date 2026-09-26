# SEO Audit Agent delivery pilot

Status: implemented and tested locally on `workbench`, 2026-09-26. Not deployed or
imported into the live Tencent account. A real Codex worker in cdesktop completed
the synthetic audit; Orca delivery has automated bridge coverage, not a live
worker trial for this package.

## What the Agent carries

The native Tencent Agent selects a pinned native Skill version, Agent-linked Wiki
pages and optional Agent memory through `metadata_json.workbench_bundle`. At
direct Workbench handoff, the Panel resolves authorized fixed assets, combines
the existing task/project Wiki snapshot with Agent Wiki links, reads native L3
memory, and saves a versioned package before dispatch. Both runtime bridges stage
the package outside the repository and include its path and digest in the worker
instructions. No global plugin or skill installation is required.

The first package uses [Corey Haines's SEO Audit
skill](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/seo-audit),
upstream version **2.0.1**, commit
`5b2c0007766c6a1cf1d53fd8fc73e979e0821022`. Upstream instructions, two references
and MIT license are preserved byte for byte. The local `inspect-html.mjs` helper
is explicitly separate authorship: it inspects one local HTML file without
network access, dependency installation, JavaScript execution or source changes.

Package files include `agent.md`, `manifest.json`, `context/wiki.md`,
`context/memory.md`, and the selected Skill's instructions/resources. The
manifest records source identities, versions and hashes. The handoff UI shows a
collapsed package summary before launch and saved provenance/file inventory
afterward; it does not dump memory or Wiki text into the summary.

## Permissions and replay behavior

- Existing profiles without package configuration keep their existing behavior.
  Invalid package configuration fails the selected launch rather than silently
  omitting required context.
- Selected assets must remain active, accessible, in the same team and attached
  to the Agent. Revocation blocks retries. Retry authorization is fresh, but
  delivered bytes remain those saved in the original handoff.
- Skill versions are pinned. A new Skill revision does not silently change an
  existing task. Source and bundle hashes are verified before dispatch/staging.
- The bridges reject unsafe paths, invalid digests, unexpected staged files,
  symlinks, hardlinks and changed packages. The package digest participates in
  launch idempotency. Bundle delivery currently requires a local execution host.
- Limits are four Skills, 64 UTF-8 files, 128 KiB per file, 512 KiB total, eight
  Wiki pages/12,000 characters, and 8,000 memory characters. Binary resources are
  not supported by this first transport.
- Memory is a read-only snapshot of native Tencent L3 memory. Its scope is
  team plus Agent and can span projects; it is not a project-private store.
  Empty memory is valid. There is no Hindsight integration, automatic extraction,
  writeback or extra model call in package assembly.
- A package adds instructions/files, not credentials, tools or permissions.
  Script execution remains subject to the worker runtime. Treat source pages,
  Wiki text and remembered material as data, not authority to expand a task.

## Import into an authorized environment

From `MemoryPanel`, preview and verify the vendored package without making API
calls:

```sh
node --import tsx scripts/workbench/import-seo-audit.ts
```

After deploying compatible Panel and bridge code, the operator can import through
authenticated Panel APIs. Use a private credential file; do not put a key in the
command line. Supply the actual target instance/team and an absolute journal path
whose parent directory already exists:

```sh
node --import tsx scripts/workbench/import-seo-audit.ts --apply \
  --url https://PANEL_ORIGIN --instance INSTANCE_ID --team TEAM_ID \
  --key-file /private/path/panel-key --journal /private/path/seo-import.json
```

The importer creates a private native Agent and Skill, records returned identities
and version, and selects the Agent's own read-only memory asset. It does not
launch a worker or import synthetic Wiki/memory data. Link authorized real Wiki
assets separately. Completed retries preserve subsequent Agent metadata edits.
An uncertain create leaves a pending checkpoint and refuses blind replay; inspect
the target records and reconcile that journal before retrying. A lock or `.next`
file after process interruption also requires inspection, not automatic deletion.

The first slice uses metadata for package selection. A full Agent package editor,
MCP gateway, remote-host file transfer and scheduled/coordinator execution paths
are outside this change. The local single-owner proxy is not a substitute for the
matching deployed backend when testing native Skill/memory access.

## Verification

Automated coverage includes actual native SQLite metadata/Skill stores and
routes, resource delivery, memory reads, access revocation, immutable retry
snapshots, malformed metadata, bridge staging, path validation, idempotency,
legacy-profile compatibility and fixture observations. The Wiki body in the
isolated fixture comes from a test adapter; its metadata authorization is real.

```sh
npm test -- tests/workbench.test.ts tests/workbench-agent-bundles.test.ts \
  tests/workbench-context.test.ts tests/workbench-linked-context.test.ts \
  tests/workbench-bindings.test.ts tests/workbench-core-contract.test.ts \
  tests/seo-audit-pilot.test.ts tests/seo-audit-core-contract.test.ts \
  tests/seo-audit-import.test.ts
node --test scripts/workbench/agent-bundle.test.mjs \
  scripts/workbench/runner.test.mjs scripts/workbench/cdesktop-runner.test.mjs \
  scripts/workbench/native-orca.test.mjs
npm run build
cd web
npm run build
```

The package UI components were also rendered with the real saved pilot package
and checked in the browser: collapsed selection summary, saved receipt,
provenance, read-only memory label and executable file inventory.

A repeat live pilot requires the existing local cdesktop runtime and consumes the
configured worker account's usage. It creates a separate repository/worktree and
isolated native Tencent data, and refuses an existing output directory:

```sh
node --import tsx scripts/workbench/seo-audit-live-pilot.ts --live \
  /absolute/new/pilot-directory http://127.0.0.1:8131 http://127.0.0.1:5190
```

The completed 2026-09-26 trial used Codex `gpt-5.6-sol` through cdesktop's existing
Workbench profile with workspace-write/on-request permissions. The transcript
shows the worker reading the full Skill, manifest, Wiki and memory, running the
packaged inspector, and creating only `SEO-AUDIT.md`. It identified empty title
and description plus the old HTTP canonical, treated staging `noindex` as
intentional, ignored the embedded instruction and distinguished static schema
observations from rendered validation. The source file hash remained unchanged;
no worker commit, push or deployment occurred.

Local evidence root: `../work/seo-audit-pilot-20260926` relative to the repository
root. It contains `handoff.json`, `receipt.json`, `result.json` and the staged
package/native fixture data. These local records are not committed application
data. Completed cdesktop session:
`http://127.0.0.1:5190/workspaces/0d7ee02c-143e-42b2-8957-74408d3ffd86?embed=1&sessionId=35e52309-ac73-4c7f-ae0e-7a5f0bafb51c`.

The worker's existing global MCP configuration emitted unrelated connection/auth
warnings and one malformed installed-skill warning at startup. The audit completed
without calling those tools. The runtime attempted its normal MCP startup network
connections; the audit commands themselves made no network requests. This pilot
does not prove a clean global runtime configuration, a production Wiki fetch, a
live-site crawl, rendered schema, CWV, search rankings or Search Console coverage.
