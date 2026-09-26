# Work pages QA

Checked on 2026-09-26 using the isolated synthetic preview at `http://127.0.0.1:5191/`. This mounts the real app and page components; no production writes, model requests, or worker launches were made.

After the user's palette change, all five work-page stylesheets were converted to semantic colors and representative screenshots were retaken with **Meridian Blue**. Computed desktop colors matched the selected palette: field `#eef0f3`, card `#ffffff`, primary action `#3b608f`. Manrope, layout, and behavior remain intact.

Saved screenshots under `.21st/screenshots/`: `meridian-tasks-desktop.png` (1440×1024), `meridian-today-tablet.png` (1024×900), `meridian-today-phone.png`, `meridian-loops-phone.png`, `meridian-timesheets-phone.png`, and `meridian-timesheets-phone-detail.png` (all phone images 390×844). These were visually inspected after the final palette conversion. Temporary browser viewport overrides were reset.

## State and layout matrix

Every page below was opened with `scenario=empty`, `scenario=loading`, and `scenario=error` at viewport widths **1440, 1024, and 390**. Desktop height was 1024 (tablet initially 900); phone height 844. The shell remained usable, each page rendered its state, and the content scroll container did not overflow horizontally.

| Page       | Empty                              | Loading                                  | Error                 | Narrow layout                            |
| ---------- | ---------------------------------- | ---------------------------------------- | --------------------- | ---------------------------------------- |
| Today      | Real zero totals and clear panels  | Unavailable totals and task loading      | Task error with Retry | Stacked panels; readable summary         |
| Tasks      | Five empty status columns          | Loading without misleading empty columns | Task error with Retry | Contained horizontal board               |
| Upcoming   | Clear six-week calendar            | Task loading                             | Task error with Retry | Contained horizontal calendar            |
| Projects   | Create-project empty state         | Project loading                          | Project error         | Stacked heading and filters              |
| Areas      | Create-Area empty state            | Area loading                             | Area error            | Readable single column                   |
| Loops      | Zero totals and filter empty state | Loop loading                             | Loop error            | Summary now 2×2 on small containers      |
| Timesheets | Zero totals and empty table        | Timesheet loading                        | Timesheet error       | Wrapped filters/actions; contained table |

Phone screenshots were visually inspected for all seven pages, including scrolling Timesheets to its last explanatory text above the dock. Today, Tasks, and Upcoming error states were rechecked at all three widths after the fix. Repeating Retry against the failing fixture returned to a usable error state without indefinite loading.

## Corrections made during QA

- Added per-team/page task error state and explicit retry to the frontend cache. Failed requests now settle; invalidation and retries clear errors, and stale results cannot overwrite replacement requests. APIs are unchanged.
- Today, Upcoming, and Tasks show an error with Retry. Unavailable Today metrics display a dash. Project task detail also reports a task-load failure with Retry.
- Changed the narrow Loop summary to two columns so metric labels remain inside their cells.
- Extracted shared `SummaryStrip`, `TaskRow`, and `Badge` components. Today, Loops, Timesheets, and board priority badges reuse them without changing their calculations or class hooks.
- Removed hardcoded work-page colors. Surfaces, text, borders, accents, priority/error/success states, and hover colors now follow the shared palette and Tea semantic tokens.

## Interaction and verification evidence

- Native task status control changed a synthetic task from Backlog to Ready; counts changed from 1→0 and 2→3, and the live region announced the move. The final Done column became reachable when its control received focus.
- Drag permission checks, drag/drop handlers, status transitions, and accessible native select controls are retained from the existing board. Coordinate dragging and raw arrow-key selection through the browser bridge were **inconclusive**; they are not claimed as passed manual pointer/OS-keyboard tests.
- `npx tsc --noEmit` in `MemoryPanel/web`: passed.
- Scoped ESLint, Prettier, and `git diff --check`: passed.
- `npx vitest run tests/backend-tasks.test.ts tests/today-focus.test.ts tests/task-board.test.ts tests/task-schedule.test.ts` in `MemoryPanel`: **17 tests passed**. Coverage includes failure/retry/success, cache isolation and stale requests, independent Today metrics, board transitions, and calendar spans.

This report covers synthetic rendering and frontend wiring. Production authorization, payments, real model execution, and native runtime sessions are outside this QA pass.
