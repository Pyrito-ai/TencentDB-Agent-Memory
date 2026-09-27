# Marketing Agents

The catalog adds **49 private native Agents**, each with one complete, pinned
Marketing Skills package. Together with the existing SEO Audit Agent, this gives
**50 marketing Agents**. The new importer deliberately excludes `seo-audit` and
does not replace its Agent, Skill, journal, or locally authored HTML inspector.
The SEO pilot remains documented in [seo-audit-agent-pilot.md](seo-audit-agent-pilot.md).

The upstream source is [Corey Haines's Marketing Skills](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022),
pinned to commit `5b2c0007766c6a1cf1d53fd8fc73e979e0821022` under its MIT license.
This is a vendored revision, not a promise to track upstream automatically.
The [catalog](../agent-packages/marketing-skills/catalog.json) records each
Agent's name, slug, category, upstream Skill version, and package directory.

## What each Agent receives

Each directory under `agent-packages/marketing-skills/` contains `agent.json`,
`provenance.json`, and the Skill tree. The full upstream `SKILL.md` and supporting
files are preserved. Relevant referenced tool guides and scripts are included
with their provenance; local wrapper instructions identify their role and limits.
The manifest records file paths, byte lengths, SHA-256 hashes, executable flags,
upstream revision, and authorship. Native import stores the instructions as Skill
content and all supporting files as Skill resources. It does not reduce a Skill
to its first paragraph or omit its references.

Workbench assembles a task snapshot containing:

- `agent.md` and `manifest.json` with selected Agent, Skill version, and source provenance.
- `skills/<slug>/SKILL.md` and every supporting resource in that Skill version.
- `context/wiki.md` with selected, authorized project/task/Agent Wiki context.
- `context/memory.md` with that Agent's authorized, read-only native L3 snapshot.

The same package validator is used by the Orca and cdesktop bridges. Each bridge
stages the files outside the repository and includes their location and digest
in the worker's instructions. A newer native Skill revision does not silently
replace the version pinned in an Agent's package selection or an existing saved
handoff. Package/resource integrity is checked before delivery.

## Tools, Wiki, and memory boundaries

Importing these packages creates instructions and native resources. It does not
install global skills, connectors, MCP servers, runtime dependencies, credentials,
or paid service subscriptions. Included scripts are source files until a worker
explicitly runs them. Executable flags are preserved; they do not grant execution
permission. A script or guide may require tools, credentials, network access, or
budget that the runtime and user still need to supply. The Agent must report a
missing capability instead of inventing its output.

Each Agent selects its own `chat_memory-<team>-<agent>` asset. A new Agent has
readable but empty memory. Native L3 memory is shared across that Agent's projects
within its team; it is not project-private. Assembly only reads a snapshot. It
does not extract new memories, write memory, run a model, call Hindsight, or launch
a worker. The package prompts do not authorize memory writes.

Wiki links are optional. Import does not create Wiki content or seed synthetic
memory. To add an Agent Wiki reference, attach an existing authorized `llm_wiki`
asset through native Agent fixed-asset APIs and add a `wikiReferences` selection
to its existing `metadata_json.workbench_bundle`, preserving other metadata:

```json
{
  "kind": "wiki_page",
  "wikiId": "EXISTING_WIKI_ASSET_ID",
  "ref": "product-marketing.md"
}
```

The selected Wiki asset must belong to the same team and remain readable by the
launching user. Task/project Wiki links are merged with Agent references without
replacing already assembled excerpts. Wiki text and memory are reference material;
neither can expand the user's task or grant new permissions.

Delivery currently supports UTF-8 text: at most four Skills, 64 files, 128 KiB
per file, and 512 KiB total. Wiki context is limited to eight selected pages,
4,000 characters per page, and 12,000 characters total. Memory is limited to
8,000 characters. Truncation is recorded in the package. A selection that cannot
include every required page within its budget fails instead of silently omitting
pages. Binary resources and remote-host file transfer are outside this transport.

## Preview without API calls

Run from `MemoryPanel` with Node.js 22 or newer and the existing package
dependencies available:

```sh
node --import tsx scripts/workbench/import-marketing-agents.ts
```

Preview verifies the local catalog, source inventory, hashes, file modes, native
Skill constraints, and package budgets. It prints the intended Agent slugs and
resource counts. It creates no remote records and launches no worker. To inspect a single
catalog entry, for example `copywriting`:

```sh
node --import tsx scripts/workbench/import-marketing-agents.ts --only copywriting
```

## Import into an authorized environment

Use compatible deployed Panel and Core code and the actual instance/team IDs.
Keep the user's Panel key in a private file, outside the repository. The key file
must be an absolute path, owned by the operator, with no group or other access
(for example mode `0600`). The journal directory must also be an absolute,
operator-owned private directory (for example mode `0700`). The origin
must use HTTPS, or HTTP on loopback for a local test environment. Redirects and
credentials embedded in a URL are rejected.

Create a private journal directory, then apply. Replace the placeholders with the
authorized target and existing private credential file:

```sh
mkdir -m 700 /private/path/marketing-agent-import
node --import tsx scripts/workbench/import-marketing-agents.ts --apply \
  --url https://PANEL_ORIGIN --instance INSTANCE_ID --team TEAM_ID \
  --key-file /private/path/panel-key \
  --journal-dir /private/path/marketing-agent-import
```

The authenticated user must be an active member of the selected team. Import
creates private Agents and their owned Skills using native authenticated APIs,
pins the returned native Skill versions, and selects each Agent's self-memory.
It performs no deployment or worker launch. To apply one entry, use the same
target and journal directory with `--only copywriting`:

```sh
node --import tsx scripts/workbench/import-marketing-agents.ts --apply \
  --url https://PANEL_ORIGIN --instance INSTANCE_ID --team TEAM_ID \
  --key-file /private/path/panel-key \
  --journal-dir /private/path/marketing-agent-import --only copywriting
```

## Retry and recovery

Keep the journal directory as durable operator state. Imports run sequentially
and record each Agent ID, Skill ID, pinned version, package hash, and completion
checkpoint in `<journal-dir>/<slug>.json`. Each journal identifies the origin,
instance, team, authenticated owner, and package slug. A completed replay verifies the existing records and preserved source
bytes, then returns them without rewriting subsequent Agent metadata edits.
Reusing the same target and journals is the supported retry path.

Before mutation, the importer checks ownership, team membership, existing Agent
provenance, journal identity, and package hashes. An existing matching marketing
Agent without its original journal is a collision to reconcile, not permission
to create another Agent. A changed package hash is not an automatic upgrade.

Each write records a pending checkpoint first. If a request may have succeeded
without returning a durable result, the journal remains uncertain and replay is
refused. Inspect the native Agent/Skill records and reconcile the recorded IDs
and versions before retrying. Do not delete journals to force an import through.
The importer takes one lock for the target owner/team across journal directories,
stored under `os.tmpdir()/marketing-agent-import-<uid>/<target-hash>.lock`.
Likewise, inspect any lock or `<slug>.json.next` file left after interruption; confirm the
previous importer is no longer running and establish which checkpoint reached
the target before manually recovering local state. The importer does not
automatically delete uncertain native records or roll back other completed Agents.

## Local validation and its limits

The native contract test uses temporary SQLite metadata and Skill stores, native
metadata routes, native Skill handlers/resource storage, and the actual L3 read
handler. It imports all 49 packages and assembles them with the production Panel
assembler, then validates their serialized files with the bridge validator.
Checks include pinned selection, full content/resource hashes and executable
flags, readable empty self-memory, private/team isolation, source attachment
revocation, context limits, completed replay, and unchanged SEO/prompt-only behavior.
No network, model, connector, or worker call is allowed in this fixture. Wiki
metadata and ACL checks are native; optional Wiki bodies come from a local test
adapter.

As with the existing SEO native contract fixture, this suite needs the local
MemoryCore dependencies and built `MemoryCore/dist` modules available. It uses
temporary databases and storage; it does not connect to a production Core.

The 2026-09-27 native run passed all five contract tests, including the full
49-package loop. The `ads` stress fixture delivered 43 files totaling 514,736
bytes under the 524,288-byte cap. Its Wiki text expanded to 72,000 JSON bytes and
its memory text to 24,000 UTF-8 bytes. This fixture supplied no project metadata;
additional context can still exceed the total budget and will fail assembly.

```sh
npm test -- tests/marketing-catalog.test.ts tests/marketing-agent-import.test.ts \
  tests/marketing-agent-core-contract.test.ts \
  tests/seo-audit-core-contract.test.ts tests/seo-audit-import.test.ts \
  tests/workbench-agent-bundles.test.ts
node --test scripts/workbench/agent-bundle.test.mjs
npm run typecheck
```

These checks establish local import, persistence, isolation, assembly, and bridge
validation. They do not prove production import, live Agent visibility, a
production Wiki fetch, connector credentials, actual packaged-script execution,
or successful work by all 49 Agents. Any live import or worker trial needs its own
record of target, package digest, native IDs, delivered files, actions observed,
result, and remaining gaps. The existing SEO trials are evidence for the SEO
pilot described in its own guide; they are not worker trials of this new catalog.

## Verified live import: 2026-09-27

All 49 additions were imported into the existing live `default-team` using the
native APIs. The Agents library and Workbench profile endpoint both show 51 total
Agents: these 49, the existing SEO Audit Agent, and the default assistant. Existing
Agent records and SEO Skill/resource hashes were verified unchanged.

The deployed Hub assembled every new package successfully: 726 delivered files
were checked against local source hashes, byte counts, and executable flags.
Every new self-memory asset was readable and empty. The largest bundle with empty
context was 416,569 bytes. A completed Copywriting import replay returned the same
Agent and Skill IDs without creating duplicates. Browser verification confirmed
the Agent count and Copywriting's Skill and memory attachments.

The final focused suite passed 112 tests, including exact clean-source
reproduction and native assembly of all 49 packages. No runtime redeployment,
worker launch, model call, or bundled CLI execution was needed. These results
verify creation and delivery; they do not establish the quality of all 49
specialists' work or authenticate their external integrations. Private per-package
journals and the release report were retained by the deployment operator.
