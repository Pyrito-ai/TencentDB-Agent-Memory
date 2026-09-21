# Workbench selected context

`MemoryPanel/src/panel/workbench/context.ts` provides `collectWorkbenchContext` for explicitly selected Wiki pages. It is a retrieval helper, not a search engine, memory agent, or permission grant. Routes pass their server-resolved `MetaCallContext`; never construct this from unchecked caller JSON.

## Integration contract

- Input: `{teamId, userId, taskId?, references: [{kind: "wiki_page", wikiId, ref}]}`.
- `userId` is the authenticated route caller, not a user chosen by the coordinator.
- Result: `{excerpts, text}`; excerpts include instance/team/task provenance, Wiki version, page reference, content, and truncation flag.
- Append text to the run's untrusted reference context. Preserve manual context excerpts as fallback. Source text must not select projects, authorize launches, or override worker instructions.
- No selected reference is inferred from model output, task title, or a similar asset name.

Authorization repeats at collection time: `auth/verify`, active `team-member/get`, and (when task ID is supplied) same-team `task/get`. Each selected Wiki must have matching same-team `asset/get` metadata of type `llm_wiki` and `acl/check` read permission. The instance-bound Knowledge client must return matching Wiki ID/team. Content is fetched only after the entire selection is authorized and the page response must echo the requested ref. Unknown/mismatched/missing data fails closed.

These are the repository's real API contracts from `http/routes/knowledge/common.ts`, `wiki-routes.ts`, and `kernel/ports/knowledge-client-port.ts`. Metadata and content are accessed through instance-specific dependencies. The upstream Wiki ownership must remain stable during a request; this helper is not a cross-service transaction.

Limits: eight references, 4,000 characters per page, 12,000 source-content characters in total. Duplicate selections are removed. Once the total is reached, later pages are not fetched. Returned excerpts, rather than the requested list, identify what was actually included. Source snippets are an execution-time snapshot; later revocation does not erase existing run history.

## Memory and reviewed outcomes

Automatic chat-memory retrieval is intentionally unavailable here. Existing chat-memory routes have owner, shared-team, and imported-agent binding authorization plus layer-specific identifiers. Reimplementing that as broad team search or guessing memory IDs would be unsafe. Manual excerpts remain supported until a governed adapter reuses those checks.

`prepareReviewedOutcomeDraft` only validates and formats an explicitly approved outcome with task/execution/reviewer identifiers and evidence. It cannot prove reviewer authority on its own, perform ingestion, or persist anything. The caller must load the actual authorized review; never trust an LLM or arbitrary request's `approved` string. Persisting requires a separate explicit destination selection, current write permission, confirmation of the exact reviewed content, and idempotent receipt. Existing Wiki write endpoints can be used once that route is designed. Worker completion alone must never trigger memory or Wiki writeback.

No paid models, ingestion jobs, live mutations, or application deployments were used to validate this module. Tests cover cross-team/task/caller denial, inactive membership, denied ACL, mismatched source metadata/ref, bounded source content, traversal rejection, and review draft status.
