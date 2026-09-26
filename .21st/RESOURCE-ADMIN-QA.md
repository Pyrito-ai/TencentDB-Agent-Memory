# Resource and admin QA

Checked on 2026-09-26 against the isolated synthetic preview at `http://127.0.0.1:5191/`. This mounts the real app, router, auth shell, and page components with invented data. Resource and admin QA used Chrome through CUA. The final screenshots use the user's selected **Meridian Blue** palette. Browser zoom and temporary viewport overrides were restored after testing.

## Width and state coverage

Populated resource layouts were visually inspected at widths **1440, 1024, and 390**. Desktop/tablet screenshots used a height of 1000; phone screenshots used 844. The resource state matrix used height 1000 at all three widths. State checks combined rendered DOM inspection with horizontal-overflow measurements; they do not imply a saved screenshot for every combination.

| Surface                         | Populated/default widths | Empty/loading/error widths | Observed result                                                                                                                                                                                        |
| ------------------------------- | ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Knowledge / Wiki                | 1440, 1024, 390          | 1440, 1024, 390            | Team and agent scopes render; loading skeletons and empty messages render; failed requests report notifications. Page reader stacks on narrow containers.                                              |
| Code                            | 1440, 1024, 390          | 1440, 1024, 390            | Repository cards, detail facts, and search/explore controls fit; long repository URL wraps. Loading skeletons, empty messages, and failure notifications remain usable.                                |
| Skills                          | 1440, 1024, 390          | 1440, 1024, 390            | Local list/detail layout and Markdown render; actions wrap on mobile. Empty/team/agent and loading states render; failure notifications preserve the shell.                                            |
| Memory                          | 1440, 1024, 390          | 1440, 1024, 390            | Local list/detail layout renders; title, actions, and date filter reflow. Layers use two columns when the detail pane is narrow. Loading/empty states and failure notifications render.                |
| Workbench host                  | 1440, 1024, 390          | 1440, 1024, 390            | Orca disconnected state and cdesktop task selection render. The fixture supplies no runtime URL, so loading/error scenarios retain the disconnected host; they do not simulate native runtime loading. |
| Agents                          | 1440, 1024, 390          | 1440, 1024, 390            | Cards, owner filters, and create form fit. Empty/loading render; error notification observed, with the immediate error sample still showing loading.                                                   |
| API Keys                        | 1440, 1024, 390          | 1440, 1024, 390            | Table/endpoints and new-key dialog fit. Shell/endpoints remain during table loading; error notification observed.                                                                                      |
| Analytics                       | 1440, 1024, 390          | 1440, 1024, 390            | Metrics, filters, model/member/trace data, and model drawer fit. Loading/skeleton state and explicit error alert with placeholder metrics observed.                                                    |
| Members, Guide, Login, Settings | 1440, 1024, 390          | Not exercised              | Populated/default surfaces and representative dialogs inspected; these pages are not claimed as part of the state matrix.                                                                              |

The completed checks found no document-level horizontal overflow. One transient Wiki measurement occurred while another QA tab changed shared-origin browser zoom; after restoring 100%, the 390px viewport, document width, and main content bounds were rechecked and fit. Data-request errors on resource pages are reported through their existing notifications and empty/zero-data presentation; this pass did not introduce or verify an inline resource retry workflow.

## Interaction checks

- Wiki: switched team/agent scopes; opened a populated knowledge base; opened Pages and selected Design principles; verified its Markdown content at desktop, tablet, and phone widths.
- Code: selected a repository independently of opening its detail; selection enabled Allocate to Agent; opened detail with repository facts and search/explore controls. No search/explore request or allocation was submitted.
- Skills: selected a skill; inspected frontmatter, Markdown, attached-file listing, edit mode, and version-history dialog. Edit mode was cancelled without saving. Mobile action wrapping was rechecked after correction.
- Memory: selected a memory block; inspected its layer selectors and synthetic L1 content; switched Browse/Search modes; inspected date and search controls. No memory import, sharing change, allocation, unbind, or deletion was submitted.
- Shared resource split: keyboard ArrowRight changed the desktop sidebar width and displayed its focus outline. The original mouse resize handling is retained; a complete pointer-drag pass is not claimed.
- Workbench: switched Orca to cdesktop and back. DOM inspection confirmed both previously visited host panes remained mounted, with the inactive pane hidden. The task selector and New board task control remain present; no worker/session was launched.
- Admin: opened New Agent, Add Member, new-key expiry, Settings, and Analytics model-detail interfaces without submitting writes. Verified the mobile agent form can scroll to its footer and the Analytics drawer fits the viewport. Guide command controls and Login were visually inspected.

## Role checks actually observed

| Fixture role | Surface               | Observed controls/access                                                                                                            |
| ------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Admin        | Agents                | All Owners filter, New Agent, and Default Agent section visible.                                                                    |
| Admin        | Members               | Add Member visible; modal opened without submission.                                                                                |
| Admin        | API Keys              | New Key hidden, including in the empty state. The misleading empty-state create hint was removed.                                   |
| Admin        | Analytics             | Usage Behavior, Cost & Models, refresh/filter controls, populated model/member/trace data, and model View details drawer available. |
| Member       | Agents                | Owned Research companion and Alex Morgan (you) ownership shown; New Agent and Delete controls present; New Agent form opened.       |
| Member       | Members               | Member rows and roles visible; Add Member/remove controls absent.                                                                   |
| Member       | API Keys              | New Key and Revoke visible; expiry dialog opened without creating or revoking a key.                                                |
| Member       | Settings              | Four enabled switches displayed; no settings changed.                                                                               |
| Reviewer     | Analytics direct link | No Permission / system-admin-only guard displayed.                                                                                  |

Reviewer Agents/Members/API Keys and a role-by-role comparison of the dock's More menu were **not** exercised in this lane. These observations verify frontend fixture behavior, not production authorization.

## Corrections verified during QA

- Wiki Pages/Graph splits stack below 640px of available content width, preventing the fixed local sidebar from squeezing the reader into a narrow strip. Desktop local resizers remain.
- Memory header controls now wrap based on detail-container width; date controls remain contained, and layer labels/counts use a two-column layout when needed.
- Skills actions wrap within the detail card; resource agent selectors remain inside the available width.
- The mobile cdesktop task selector stays within its host panel.
- Guide command controls stack, agent-form controls wrap, and the Analytics drawer uses viewport-bounded width.
- Wiki/Code agent-scope empty states no longer direct users to create buttons hidden in that scope.
- Login, onboarding, Guide, and applicable display labels use Baren. Technical provider identifiers and endpoint behavior were preserved.

## Initial browser zoom pass

The later approved [all-route 200% follow-up](ZOOM-QA.md) supersedes the coverage limitations in this initial pass. It also verifies Memory outer scrolling and records the short-height layout and notification fixes.

Chrome's native menu visibly reported **200%**; this was browser zoom, not just a narrow viewport override. On a 1728px browser window, the effective viewport was 864px and device pixel ratio was 4. The native menu and metrics were checked again after restoring **100%**.

- Login reflowed without horizontal overflow; the final action and footer were reachable by scrolling.
- Settings fit; all four rows/toggles were reachable through the dialog's internal scrolling.
- Memory's Product working context detail had no document horizontal overflow and its inner detail scrolling worked. Recorded metrics were viewport/document width 864, main scroll width 818, and effective viewport height 470. The dock occupied a substantial part of that short viewport. **Memory outer-page scrolling was not separately tested at 200%.**

Other routes were not checked at actual 200% zoom. A later attempt to extend this pass was stopped when automatic approval review rejected a native Chrome accessibility read because it could expose unrelated private browser content. No bypass was attempted; the earlier Login/Settings/Memory checks remain the evidence for this pass.

[Recorded Memory zoom metrics](screenshots/memory-detail-actual-200pct-metrics.json)

## Screenshots

All links below are the final Meridian Blue captures. Resource detail captures may be scrolled to show the relevant reader or controls.

- [Memory desktop, 1440px](screenshots/memory-1440-final.png)
- [Memory tablet, 1024px](screenshots/memory-1024-final.png)
- [Memory phone, 390px](screenshots/memory-390-final.png)
- [Wiki reader phone, 390px](screenshots/wiki-reader-390-final.png)
- [Skills phone, 390px](screenshots/skills-390-final.png)
- [Workbench phone, 390px](screenshots/workbench-390-final.png)
- [Analytics desktop, 1440px](screenshots/analytics-1440-final.png)
- [Login phone, 390px](screenshots/login-390-final.png)
- [Settings phone, 390px](screenshots/settings-390-final.png)
- [Memory at actual 200% browser zoom](screenshots/memory-detail-actual-200pct-final.png)

## Checks and limitations

- `npx tsc --noEmit` in `MemoryPanel/web`: passed.
- Targeted ESLint: zero errors. The touched Wiki detail component retains seven existing warnings (`any` types and a hook dependency); these are not represented as a warning-free full-repository lint result.
- Scoped Prettier and `git diff --check`: passed. Final cosmetic-label files also passed targeted ESLint/Prettier.
- No production/backend mutations, resource ingestion, uploads, key creation/revocation, membership changes, credential changes, settings changes, real model requests, or worker launches were performed. Open forms were not submitted.
- Native iframe/session operation was **not tested**. The isolated fixture blocks frames and external/runtime connections. Preserved host mounting is evidence about React host behavior only; it does not prove a real native session survives runtime switching.
- Reduced-motion CSS branches were inspected in source, including shared asset cards/lists, Memory, and team surfaces. **This lane did not enforce `prefers-reduced-motion: reduce` in the browser or verify its live behavior.**
- This report covers synthetic rendering and frontend interaction wiring. It is not evidence of deployment, production authorization, backend correctness, or native-runtime integration.
