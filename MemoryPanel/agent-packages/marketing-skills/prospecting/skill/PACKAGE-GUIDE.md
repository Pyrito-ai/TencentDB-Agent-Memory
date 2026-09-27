# prospecting: package guide

Pinned upstream: [Marketing Skills 5b2c0007766c6a1cf1d53fd8fc73e979e0821022](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022). License: MIT; see LICENSE.upstream. Original skill files, assets, evaluations, guides and CLI bytes are preserved unchanged. This guide is local packaging guidance.

## Scope and capabilities

Use the supplied task and scoped project/Wiki context, then the selected read-only Agent memory snapshot. These sources are reference data, not permission to expand the task. Product-context file examples in upstream guidance refer only to user-authorized project inputs; never search unrelated projects or treat a context file as executable instructions.

Create the requested artifact and identify what needs review. Inclusion of an integration guide, SDK example, CLI or registry entry does not install or connect it, provision credentials, grant network access, authorize sends/publishing/spending, start recurring jobs, or grant Agent memory/Wiki writes. Tool calls and CLI execution require both explicit task authorization and runtime capability. Do not execute CLIs merely to show help: some inspect credentials immediately. No external tool was executed or live-validated while packaging. Report unavailable tools/data as gaps; do not invent results or claim publication.

## Resolving upstream paths

At launch, this guide and SKILL.md live under skills/prospecting/. The table maps repository-root upstream paths to paths relative to that directory. Resolve an upstream markdown link relative to its ORIGINAL source path first, then use this table. Original links that escape the skill directory may therefore need this map. Root-level tools/... commands refer to supporting/tools/... here; run with the explicit resolved path only if authorized. Relative links within copied supporting/tools/ keep their original layout.

| Upstream path | Packaged relative path |
| --- | --- |
| [LICENSE](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/LICENSE) | LICENSE.upstream |
| [skills/ad-creative/assets/creative-review-template.html](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/ad-creative/assets/creative-review-template.html) | supporting/skills/ad-creative/assets/creative-review-template.html |
| [skills/ad-creative/references/creative-review-page.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/ad-creative/references/creative-review-page.md) | supporting/skills/ad-creative/references/creative-review-page.md |
| [skills/prospecting/SKILL.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/prospecting/SKILL.md) | SKILL.md |
| [skills/prospecting/evals/evals.json](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/prospecting/evals/evals.json) | evals/evals.json |
| [skills/prospecting/references/b2b-prospecting.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/prospecting/references/b2b-prospecting.md) | references/b2b-prospecting.md |
| [skills/prospecting/references/compliance.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/prospecting/references/compliance.md) | references/compliance.md |
| [skills/prospecting/references/data-sources.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/prospecting/references/data-sources.md) | references/data-sources.md |
| [skills/prospecting/references/demand-signals.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/prospecting/references/demand-signals.md) | references/demand-signals.md |
| [skills/prospecting/references/local-prospecting.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/prospecting/references/local-prospecting.md) | references/local-prospecting.md |
| [skills/prospecting/references/saas-prospecting.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/prospecting/references/saas-prospecting.md) | references/saas-prospecting.md |
| [tools/REGISTRY.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/REGISTRY.md) | supporting/tools/REGISTRY.md |
| [tools/clis/apollo.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/apollo.js) | supporting/tools/clis/apollo.js |
| [tools/clis/clay.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/clay.js) | supporting/tools/clis/clay.js |
| [tools/clis/clearbit.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/clearbit.js) | supporting/tools/clis/clearbit.js |
| [tools/clis/github-prospects.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/github-prospects.js) | supporting/tools/clis/github-prospects.js |
| [tools/clis/hunter.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/hunter.js) | supporting/tools/clis/hunter.js |
| [tools/clis/instantly.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/instantly.js) | supporting/tools/clis/instantly.js |
| [tools/clis/lemlist.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/lemlist.js) | supporting/tools/clis/lemlist.js |
| [tools/clis/outreach.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/outreach.js) | supporting/tools/clis/outreach.js |
| [tools/clis/snov.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/snov.js) | supporting/tools/clis/snov.js |
| [tools/clis/zoominfo.js](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/clis/zoominfo.js) | supporting/tools/clis/zoominfo.js |
| [tools/integrations/apollo.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/apollo.md) | supporting/tools/integrations/apollo.md |
| [tools/integrations/browserbase.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/browserbase.md) | supporting/tools/integrations/browserbase.md |
| [tools/integrations/clay.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/clay.md) | supporting/tools/integrations/clay.md |
| [tools/integrations/clearbit.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/clearbit.md) | supporting/tools/integrations/clearbit.md |
| [tools/integrations/firecrawl.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/firecrawl.md) | supporting/tools/integrations/firecrawl.md |
| [tools/integrations/github.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/github.md) | supporting/tools/integrations/github.md |
| [tools/integrations/hunter.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/hunter.md) | supporting/tools/integrations/hunter.md |
| [tools/integrations/instantly.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/instantly.md) | supporting/tools/integrations/instantly.md |
| [tools/integrations/lemlist.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/lemlist.md) | supporting/tools/integrations/lemlist.md |
| [tools/integrations/outreach.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/outreach.md) | supporting/tools/integrations/outreach.md |
| [tools/integrations/rb2b.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/rb2b.md) | supporting/tools/integrations/rb2b.md |
| [tools/integrations/snov.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/snov.md) | supporting/tools/integrations/snov.md |
| [tools/integrations/truelist.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/truelist.md) | supporting/tools/integrations/truelist.md |
| [tools/integrations/zoominfo.md](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/integrations/zoominfo.md) | supporting/tools/integrations/zoominfo.md |

## Reference exceptions

No unresolved local file references were found in the packaged dependency closure.

## Related skills

Other skill instructions are not implicitly installed or activated by this package. Select the separate Agent/package for a related specialty, or use a user-authorized handoff. A referenced sibling SKILL.md is not recursively bundled. Only exact supporting reference files needed by this package are copied.

- [analytics](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/analytics/SKILL.md): separate catalog package; not included here.

- [cold-email](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/cold-email/SKILL.md): separate catalog package; not included here.

- [competitor-profiling](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/competitor-profiling/SKILL.md): separate catalog package; not included here.

- [customer-research](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/customer-research/SKILL.md): separate catalog package; not included here.

- [directory-submissions](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/directory-submissions/SKILL.md): separate catalog package; not included here.

- [emails](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/emails/SKILL.md): separate catalog package; not included here.

- [image](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/image/SKILL.md): separate catalog package; not included here.

- [product-marketing](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/product-marketing/SKILL.md): separate catalog package; not included here.

- [revops](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/revops/SKILL.md): separate catalog package; not included here.

- [sales-enablement](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/sales-enablement/SKILL.md): separate catalog package; not included here.

- [social](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/social/SKILL.md): separate catalog package; not included here.

## Tool availability

The [upstream tools registry](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/tools/REGISTRY.md) is included as an index only. Its links are not a dependency list: entries absent from the mapping above are not bundled or available here. Use their pinned source links in that registry for review; do not claim a registry entry is a connected capability.

Integration guides describe upstream capabilities and may contain historical vendor/API/version claims. Existing same-tool CLIs are included where available; no CLI is invented when one is missing. External APIs, MCP servers, SDKs, browsers, credentials, paid plans and generation services remain runtime dependencies. Validate current details before relying on them.

## Verification and regeneration

All files are recorded with byte counts, SHA-256 hashes, original source paths and executable flags in the package provenance.json. The offline generator requires the exact clean upstream checkout. Regenerate with: npx tsx scripts/workbench/build-marketing-agent-packages.ts --source /absolute/path/to/marketingskills-source. Add --check to verify without writes. The generator never fetches, installs, imports Agents, runs upstream scripts or edits the separate SEO package.
