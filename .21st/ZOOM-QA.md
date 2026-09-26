# Actual 200% zoom follow-up

Completed on 2026-09-26 after the user approved continuing the browser review. All testing used the isolated synthetic preview on port 5191. Nothing was merged, deployed, or sent to a live backend.

## Method and evidence

Chrome started at 1728 × 940 CSS pixels with device pixel ratio 2. Native browser zoom changed this to **864 × 470, device pixel ratio 4**, confirming actual 200% zoom. Page observations and screenshots were scoped to the synthetic preview. Chrome was restored to **1728 × 940, device pixel ratio 2** afterward, and the temporary QA tab was closed.

[Recorded dimensions and page states](screenshots/zoom-200-metrics.json). Screenshots use the `zoom-200-` prefix in `screenshots/`.

## Fixes made during this pass

- At viewport heights of 650px or less, resource and runtime page frames grow with their contents. This keeps their bottom padding after the panels, so the dock cannot permanently cover their final controls. Normal desktop split panels and resizers retain their existing behavior.
- Skills uses page scrolling on short viewports, allowing the full reader, attached files, and editing controls to remain reachable. Memory details also release their fixed height.
- Tea's notification stack has a bounded vertical scroll area. At 200%, its bottom is 335px and the dock starts at 368px. Repeated failures no longer extend below the window or cover the dock. Dismiss controls remain reachable by scrolling or keyboard focus.

The original Skills failure is captured in [before](screenshots/zoom-200-skills-before.png); the corrected [reader and attachment](screenshots/zoom-200-skills-bottom-fixed.png) and [editing controls](screenshots/zoom-200-skills-edit-bottom.png) clear the dock.

## Coverage and results

| Surface                                                    | Actual 200% review                                                                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today, Tasks, Projects, Upcoming, Areas, Loops, Timesheets | Headings, collections/board/calendar, contained horizontal scrolling, and lower content reviewed. Error panels and Retry controls clear the dock at the verified scroll end. |
| Knowledge and Code                                         | Collection scopes and populated detail surfaces reviewed; lower content and actions remain reachable.                                                                        |
| Skills and Memory                                          | Populated details reviewed after the fix. Skills final Markdown lines, attached SKILL.md, and Save/Cancel are reachable. Memory outer detail content clears the dock.        |
| Members, Agents, API Keys, Analytics                       | Lists, cards, tables, and lower page content reviewed without document-level horizontal overflow.                                                                            |
| Workbench                                                  | Disconnected Orca and cdesktop hosts reviewed. Expanded New board task form and its action remain reachable. No workers or native sessions launched.                         |
| Guide, profile, settings, login                            | Default surfaces and dialog/page scrolling reviewed. Settings' final toggle and login's lower controls are reachable.                                                        |
| More menu                                                  | End moves keyboard focus to Analytics and scrolls it into view; Escape closes the menu.                                                                                      |
| Coordinator                                                | Drawer, pinned composer, conversation, and synthetic proposal reviewed. Apply/Dismiss are reachable by keyboard and remain above the composer.                               |

Seventeen routes were also inspected under each empty, loading, and error fixture configuration: **51 route/scenario visits**. All recorded document widths equal the 864px viewport; the main scroller's scroll width equals its 858px client width. Error captures were retaken with notifications dismissed and the actual outer scroll end verified, avoiding an earlier capture where the notification overlay received the scroll event.

Screenshots and metrics were checked independently by the work-page and resource/admin reviewers. The loading Tasks message was recaptured at its visible position (bottom 306px, dock top 368px).

## Boundaries

The 51 visits are layout checks, not 51 distinct backend state simulations. Members retains authenticated team members, Guide stays static, and Workbench remains disconnected. The Memory loading fixture can show a missing-agent empty state. Existing resource error behavior still varies: Agents can retain its loading presentation after a failed request, while API Keys displays empty data with a failure notification. This pass did not change those data hooks.

Live runtime execution, pointer drag, and operating-system reduced-motion verification remain outside this follow-up. Earlier functional tests and authenticated read-only rendering results remain in [the main review](REVIEW.md).

## Validation

Production frontend build, formatting for the four changed CSS files, and `git diff --check` pass. At restored 100% zoom, Skills again has a fixed desktop split (459px) and its internal reader uses `overflow-y: auto`, confirming that the short-height overrides are inactive.
