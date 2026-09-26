# SEO Audit Agent pilot

This package is the first Workbench Agent delivery fixture. It uses Corey Haines's
`seo-audit` skill **2.0.1**, pinned to commit
`5b2c0007766c6a1cf1d53fd8fc73e979e0821022` of
[marketingskills](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/seo-audit).
The upstream `SKILL.md`, both references and MIT license are copied byte for byte.
`provenance.json` records origins, sizes and SHA-256 hashes. Nothing is installed
globally, and none of the upstream repository's other skills, plugins or external
tool integrations are activated.

The `skill/scripts/inspect-html.mjs` support script, `agent.json`, fixtures and this
README are local Workbench additions. The upstream SEO Audit skill has no bundled
script. The local script requires Node.js 22 or newer and no dependencies. It reads
one local UTF-8 HTML file up to 1 MiB, prints JSON, performs no network requests,
does not execute page JavaScript and does not modify input files. It is a small
static tokenizer, not a browser or a complete HTML parser.

## Import contract

1. Verify every `provenance.json.files` SHA-256 before import. Keep this manifest
   and its upstream commit in the import receipt.
2. Create the native Tencent Skill with `skill/SKILL.md` as its instructions.
   Import every other file beneath `skill/` as a resource, preserving its relative
   path. Include `LICENSE.upstream`. Mark `scripts/inspect-html.mjs` executable
   according to this package's resource metadata; do not infer it from a browser
   upload or a resource-read response.
3. Create the Agent from the applicable native fields in `agent.json`. Its
   top-level `schemaVersion` and `capabilityBoundaries` describe this package and
   are not native Agent fields. Parse `metadata_json` to the native format if the
   API requires a JSON string. Substitute `${SEO_AUDIT_SKILL_ID}` and
   `${SEO_AUDIT_SKILL_VERSION}` with the returned native Skill ID and **numeric
   native version**. Upstream `2.0.1` is a provenance version, not Tencent's native
   version number. Never import unresolved placeholders.
4. Attach that Skill as the Agent's fixed asset. The handoff resolves only active,
   same-team, accessible fixed assets and verifies the exact pinned version.
5. Optional authorized Wiki links belong in
   `metadata_json.workbench_bundle.wikiReferences`; an attached memory asset in
   `metadata_json.workbench_bundle.memory.assetId`. Those references are resolved
   separately using the current user's access. Fixtures below are examples only;
   do not import them as real customer knowledge or Agent memories.

Importing a Skill adds data. It does not grant shell access, add MCP servers,
provision credentials, turn on paid tools or authorize an audit of arbitrary sites.
The launch manifest and bridge determine which files are delivered to a worker.

## Controlled audit fixture

From `MemoryPanel`, run:

```sh
node agent-packages/seo-audit/skill/scripts/inspect-html.mjs tests/fixtures/seo-audit/site/index.html
npm test -- tests/seo-audit-pilot.test.ts
```

The fixture directory contains:

- `site/index.html`: synthetic staging page with an empty title/description, an
  old HTTP canonical and intentional `noindex`. It also contains an adversarial
  page instruction; the worker must analyze it as data and not follow it.
- `product-marketing.md`: synthetic Wiki/product context explaining why staging
  `noindex` is intentional and the intended production URL.
- `memory.json`: explicitly synthetic memory excerpts requesting evidence-first
  reporting and recalling an earlier noindex classification error.
- `expected-observations.json`: deterministic script expectations plus worker
  acceptance criteria. A passing script test does not prove a worker followed
  those criteria; the generated audit needs a separate review.

For a real worker trial, supply the skill directory and all three context/input
files through the launch package or an authorized read-only fixture checkout.
Tell the worker their actual paths. Read the pinned skill, supplied product/Wiki
context and memory before auditing. Run the script, cite file/line evidence and
input hash, and write only `seo-audit-report.md` in the assigned worktree. The
report should acknowledge the staging context, prioritize the title/description
and release canonical, and list the external validation still missing. Do not
merge, push, deploy, edit the site, write shared memory or claim a live-site audit.

The script's zero static JSON-LD count does **not** establish missing rendered
schema: the fixture includes code that would insert JSON-LD in a browser. This
trial also does not measure performance, rankings, Search Console coverage,
backlinks, redirects, TLS, mobile layout, or the production environment.
