# Private Ops notes

This isolated local build in `codex/gmail-connections` refactors Ops into a private Markdown note board. Gmail is an optional source of notes. Local verification is recorded below; this is not a deployment record.

## What users can do

- Create and edit private Markdown notes, then trash or restore them without changing any source mailbox.
- Ask the coordinator to propose a note. Its note-write action requires user approval before saving and cannot send email.
- Attach a note to a Coordinator message to discuss it or give direction. The server resolves its content from the signed-in user's board; discussion does not change the note.
- Optionally connect Gmail through Composio-managed Google OAuth, search email, read a thread, and prepare concise notes about what needs attention.
- Create, edit, pause, resume, and run scheduled email checks. The coordinator can propose these operations for review. A routine finds relevant threads and prepares notes; it cannot send email.

The Ops note UI contains Markdown notes, not recipient, subject, reply-body, or send controls. Notes may include a short suggested response when useful, but Gmail generation is instructed to produce concise notes rather than formal reply drafts. Notes live in Pyrito, not Gmail's Drafts folder. Attachments, reply-all, shared company mailboxes, calendar actions, and arbitrary integration tools are outside this build.

## Note API and compatibility

Every public note has exactly these fields:

```ts
{ id, revision, markdown, trashed, createdAt }
```

Mailbox identifiers, thread snapshots, deduplication data, legacy reply fields, and send state are not part of that public object. New Gmail notes retain only the private source metadata needed to recognize unchanged threads.

`POST /api/v1/ops/:team/note-save` accepts a strict JSON object with `markdown` and an optional `id`/`revision` pair. Omit both to create a note; supply both to edit one. Supplying only one or adding any other field is invalid. Markdown is trimmed, must remain nonempty, and must contain at most 16,000 characters. Edits require the current positive integer revision; stale revisions are rejected.

```json
{ "markdown": "## Follow up\n\nConfirm the workshop attendees." }
```

```json
{ "id": "<note-id>", "revision": 1, "markdown": "## Follow up\n\nConfirm two attendees by Friday." }
```

Existing encrypted email-draft records remain readable as Markdown notes with their subject and comment. Drafts include quoted suggested wording; sent or uncertain records instead show their send state, with a Gmail Sent check for uncertain outcomes. Read-time normalization does not migrate or rewrite the stored record and does not increment its revision. Legacy draft-edit and send endpoints remain available with their existing authorization, revision, source-thread, and uncertain-send protections. These compatibility operations are not exposed by the current note UI or coordinator. A generic Markdown note cannot be sent as a legacy email draft.

Coordinator messages accept an optional strict `note: { id, revision }` attachment. The backend uses authenticated `ops/note-get` to verify the owner and exact active revision before saving the user message or calling the model. Malformed attachments fail with 400, missing or foreign notes with 404, and changed or dismissed notes with 409. The model receives the complete server-resolved Markdown as a separate, explicitly untrusted context message; the user's direction stays separate. The saved user message contains only the direction and optional `{ id, revision, title }` attribution, with the title derived from the note. Later model turns receive the historical note reference, with instructions to read current content and revision before editing; the full attached Markdown is not stored with the user message. A proposed `ops/note-save` update still requires approval and rejects a changed revision when applied.

## Private ownership and execution

Every API request resolves the user from the existing authenticated Pyrito credential/session, verifies active workspace membership, and uses the tuple `(instance, workspace, user)` for ownership. No request can choose its user or provider identity. Other users, including other workspace members, receive no access to these records by knowing an identifier.

For Gmail, each owner gets an opaque Composio user identity and PRIVATE connected accounts. Every mailbox operation checks the local ownership mapping and remote account's user, toolkit, visibility, and active status. The browser and model never receive the Composio API key, provider account ID, or Google tokens. There is no generic proxy endpoint available to clients or the coordinator. Pyrito never asks for a Google password and does not receive or store usable Google access/refresh tokens.

Ops records, including Markdown notes, private source metadata, legacy drafts, routine credentials, and the scheduler's owner registry, are AES-256-GCM encrypted in a separate SQLite database. Existing coordinator conversation storage is unchanged and is not covered by this encryption claim. Email discussed in that conversation uses the existing private conversation and model path.

Routine authorization is an encrypted copy of the current Pyrito credential. It is checked against the original user and active membership on every run, before each thread, and after note generation. Pausing or disconnecting removes the saved credential. Revocation or membership removal prevents future authorized runs. Browser logout alone is not the same as revoking the underlying application credential; pause a routine to stop its background authorization.

SQLite leases serialize operations for an owner across processes using the same local database. Revision checks reject stale edits. For retained legacy send operations, approval applies to the exact saved revision and sending is recorded before the external call. An interrupted or ambiguous send becomes **unknown** and cannot be automatically retried; check Gmail Sent manually. A changed source thread blocks legacy sending; review and reply in Gmail. These protections do not add a send action to the Markdown board or coordinator.

## Board setup

Supply the server variables in [env.example](./env.example) using the normal secret manager. Secrets must never be `VITE_*` variables or browser config.

The service's `boardReady` state requires a valid `PYRITO_OPS_ENCRYPTION_KEY` and `PYRITO_PUBLIC_URL`. The public URL must use HTTPS and contain no embedded username or password. HTTP is permitted only for local development on `localhost`, `127.0.0.1`, or `[::1]`. Missing or invalid board configuration leaves the board unavailable; there is no unencrypted fallback.

Gmail configuration is optional. `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_AUTH_CONFIG_ID` enable the Gmail integration; their absence does not disable the Markdown board. The state field `configured` reports Gmail provider readiness, while `draftReady` requires both the provider and note model. Gmail operations remain gated on provider configuration and, where required, an active verified connection. The existing coordinator model variables enable Gmail note generation; manual note storage does not require a model. Without a model, a connection can be established but routines cannot be enabled.

Generate a 32-byte encryption key with a secure secret manager or `openssl rand -hex 32`; save the result directly as a secret. Keep the same key across restarts and back it up separately from the database. Changing or losing it makes existing records unreadable. Back up the SQLite database using a consistent SQLite backup/snapshot, including correct WAL handling. Do not copy a live database file alone.

Set `PYRITO_OPS_DATA_DIR` to a persistent directory writable only by the app's service identity. If omitted, it defaults to `data/private-ops` relative to the server's working directory. Use one local filesystem shared by this app's worker processes; this implementation is not a distributed scheduler for independent replicas or network filesystems. Notes do not yet have retention or pagination controls.

## Optional managed Gmail OAuth setup

Use a dedicated Composio project and an **enabled, Composio-managed Gmail authentication configuration**. No Pyrito-owned Google Cloud OAuth app is required for this chosen path. The adapter rejects custom/unmanaged auth configurations.

1. Supply the optional Composio variables in [env.example](./env.example).
2. In Composio **Settings → General → Configuration**, set the **OAuth callback URL verifier** to `https://<pyrito-host>/api/v1/ops-oauth/callback`. This is separate from the per-link redirect URL. Use a publicly reachable HTTPS staging or production host. Composio rejects private/localhost verifier URLs even though the Markdown board supports local development.
3. Use **Connect Gmail in Pyrito** while signed into the intended account/workspace. Do not pre-create user connections in the Composio dashboard. The provider's verifier sends a short-lived, single-use `session_uri` to the public callback; the callback only redirects to the app and does not activate anything.
4. In the returning Pyrito tab, choose **Finish authorization**. The authenticated backend redeems the URI with the server-derived owner identity and verifies the returned account before activating local access. A return under another Pyrito identity cannot attach the mailbox. If sign-in or reload loses the one-use return, start a fresh authorization flow.
5. Check the connected email address, create a paused routine with a narrow Gmail query, and run **Check now** before enabling a schedule. Review which model receives email text and whether the resulting notes identify useful next steps.

**The verifier is required.** If Composio activates an account without verification, Pyrito deliberately keeps the connection unusable. A successful Google consent screen alone is not proof of an active Pyrito connection. The single-use verification exchange is not automatically retried after uncertain outcomes.

The Gmail model receives only subject, sender, date, and text, and returns strict JSON with exactly `{ relevant, markdown }` under a 1,000-token output budget. It uses the owner's instruction to decide relevance and treats email and quoted content as untrusted evidence. Generated notes must not claim actions occurred or invent facts, commitments, or attachments. The model cannot call tools or send email.

The provider path uses Composio's authenticated Gmail proxy. Proxy calls and model tokens may have usage charges; check the selected plans before activating a live routine. A check processes at most five threads, retains a pagination cursor, and deduplicates unchanged threads, including notes in the trash. Minimum interval is 15 minutes; the server polls for due work every 30 seconds and must remain running. There is a limit of five pending/active mailboxes and twenty routines per owner.

## Local synthetic preview

The preview uses fake mail and a deterministic note model. Its Ops requests use the actual HTTP routes, authorization checks, encryption, and persistence. Other app pages use the existing frontend fixture. External API traffic is blocked. It does not exercise real Gmail, Composio, or model services.

The synthetic backend also runs the actual Coordinator routes. With a note attached, normal directions produce discussion without changing the note. `Add to the note: <text>` proposes appending that text, and `Update the note: <Markdown>` proposes replacing it. Follow-up messages can reuse the historical reference without reattaching: the model requests `ops/list` through the normal authenticated dispatch and selects the same active note from that caller's results. `Make it shorter` or `Shorten the note` proposes a shorter version. All proposals use the note's current ID and revision and save only through the normal approval endpoint. These deterministic commands are preview behavior, not a restriction on the live Coordinator model.

Requires Node 22 with `node:sqlite` and installed Panel/frontend dependencies. From this worktree, run in two terminals:

```sh
cd MemoryPanel
node --import tsx scripts/ops-preview-server.ts
```

```sh
cd MemoryPanel/web
node node_modules/vite/bin/vite.js --config tests/ops-preview/vite.config.ts
```

- Populated: <http://127.0.0.1:5193/#/ops>
- Another user with no connections: <http://127.0.0.1:5193/?scenario=empty#/ops>
- Service error: <http://127.0.0.1:5193/?scenario=error#/ops>
- Loading: <http://127.0.0.1:5193/?scenario=loading#/ops>

The API binds only to `127.0.0.1:8193`. Each backend launch creates a fresh fixture database under ignored `MemoryPanel/.ops-preview/`; the synthetic encryption key exists only for that process. The frontend binds only to port 5193 and uses document-local fixture sign-in. Neither preview uses production databases or runtime settings.

## Verification status

On 2026-10-03, the Markdown refactor passed the Panel TypeScript check and 35 focused backend tests (29 private Ops, 6 global Coordinator). These cover a board without Gmail, exact public note projection, strict Markdown limits and revision pairs, stale edits, dismiss/restore, isolation by user/workspace/instance, legacy titles and send states without writes, guarded legacy sending, unchanged-thread deduplication, model validation/input projection/token budget, server-resolved note discussion, and approval-gated Coordinator writes. Attachment tests reject malformed, stale, dismissed, or foreign notes without changing the conversation or calling the model; discussion, fresh-content follow-up, and apply tests exercise the actual routes alongside the existing ownership, authentication, lease, and send safeguards.

The frontend TypeScript check, production Vite build, targeted ESLint/Prettier checks, and three Markdown renderer tests passed. The renderer tests cover general Markdown, inert HTML and unsafe URLs, non-loading image links, local links, and contained tables. Run them from `MemoryPanel/web` with `node --import ../node_modules/tsx/dist/loader.mjs --test tests/ops-note-markdown.test.tsx` using Node 22. Existing build chunk-size and mixed-import warnings remain.

The authenticated synthetic browser pass verified the mixed-content populated board, keyboard dismiss/restore, empty/error/loading states, and the 390px layout. At 390px the document remains 390px wide and all cards fit within it. Cards have no reply forms or email input fields. The narrow view was checked with the Coordinator open and closed; its existing stacked layout remains intact. The original viewport and open Coordinator were restored afterward. Current evidence: [Markdown board](./screenshots/ops-markdown-desktop.png) and [mobile notes](./screenshots/ops-markdown-mobile.png). Older screenshots show the superseded email-draft design.

The note discussion browser pass on 2026-10-03 also verified keyboard activation from a closed Coordinator, composer focus, switching attachments without replacing draft text, draft/context retention across page navigation, removing context, and clearing a successfully dismissed note's attachment. An authenticated synthetic conversation discussed “A decision to keep”, then continued without reattaching it, proposed an appended next step, and updated the actual card only after Apply. Both the saved edit and conversation survived reload. At 390px the note action opened the existing stacked Coordinator with its attachment and composer visible; document width stayed 390px, and board and Coordinator bounds did not overlap. The original viewport was restored. Evidence: [desktop discussion](./screenshots/ops-note-discussion-desktop.png) and [mobile discussion](./screenshots/ops-note-discussion-mobile.png). These use the deterministic fixture model, not a live language model. UI identity-switch and in-flight response races were reviewed in source; owner isolation and stale revisions have automated backend coverage.

Real Gmail OAuth, real Composio calls, live model behavior, real send/revocation, and deployment remain **unverified**. Live verification requires the intended Composio project/auth configuration, a public HTTPS verifier, and user consent. Nothing in the local fixture demonstrates a working live connection or authorizes a real email send.

To stop the preview, stop only its two terminals on ports 5193 and 8193. Preserve any wanted changes before archiving the experiment's worktree. Do not stop other previews or remove the primary checkout.

## Provider references

- [Authentication model](https://docs.composio.dev/docs/authentication)
- [Connected accounts and token handling](https://docs.composio.dev/docs/auth-configuration/connected-accounts)
- [OAuth callback identity verification](https://docs.composio.dev/reference/v3/api-reference/connected-accounts)
- [Complete authorization API](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth)
- [Authenticated proxy API](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteProxy)
- [Gmail MIME sending (legacy compatibility)](https://developers.google.com/workspace/gmail/api/guides/sending)
