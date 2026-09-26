# Loops performance and active work

Implemented September 26, 2026 in `codex/baren-gui-dock`. Preview: <http://127.0.0.1:5191/#/loops>. No backend, database, runtime configuration, or deployment changes.

## Updated flow

- Loops opens with a performance panel, a last 7 / 30 / 90 days selector, actual date range, completion chart, and accessible activity table. The chosen period survives opening a loop and returning to the list.
- The report covers all loops, including archived completion history, and includes today. Completion dates use the team timezone. Scheduled punctuality uses each loop's due-day timezone.
- Scheduled on-time percentage is the share of scheduled completions in the selected window, not target attainment. Overdue counts only currently active loops with unresolved deadlines in that window, excluding today. Skips are counted by deadline date. Archived loops have no archive timestamp, so their generated outstanding deadlines are intentionally excluded.
- Active loops appear as compact rows below the report with owner, Area, schedule/current flexible progress, Details, and Start / Continue / View work. List filters do not alter the all-loop performance report.
- Direct Start explicitly creates human work for the next unresolved scheduled deadline or an untimed flexible occurrence. It does not inherit a previous agent/deadline selection or launch workers. Existing scheduled work or the current user's open/preparing flexible work is opened instead of duplicated.
- Selected occurrences appear before the detail charts, receive keyboard focus, and retain existing acceptance, task, timer, history, deadline, and manual handoff controls.

## Verification

- Frontend production build passed; existing mixed-import and bundle-size warnings remain.
- Targeted ESLint, Prettier, and `git diff --check` passed.
- Panel typecheck and all 138 tests across 19 files passed. Twelve new performance tests cover inclusive windows, DST/timezones, late completion dates, archived records, missing due dates, and chart totals.
- All 10 isolated preview API tests and fixture typecheck passed, including Start idempotency and scheduled duplicate handling.
- Synthetic authenticated browser pass: 7/30/90 day totals, exact activity table, scheduled Start to linked occurrence, subsequent Continue, flexible Continue and linked task, period retention, filtered empty list, empty/loading/error states, and keyboard focus.
- Layout visually checked at 1440, 1055, 1024, and 390px. No page horizontal overflow at 1024 or 390px. Coordinator stays in its non-modal split layout. Mobile action rows and dock clearance checked.
- Preview mutations were entirely document-local synthetic records. Browser checks are UI validation, not real backend or worker execution verification. Existing backend loop tests cover those contracts separately.

## Synthetic history

On September 26: 7 days = 2 completed, no scheduled completions; 30 days = 12 completed, 2/3 scheduled on time, 1 overdue, 0 skipped; 90 days = 26 completed, 7/9 scheduled on time, 1 overdue, 2 skipped. The scheduled Start fixture targets September 5. The normal task board retains seven initial tasks; historical loop tasks live in a separate fixture pool. Historical task navigation remains limited by the existing list-based task drawer lookup; current Start and Continue tasks open normally.

Screenshots: `screenshots/loops-performance-desktop.png`, `screenshots/loops-performance-1024.png`, `screenshots/loops-performance-mobile.png`, and `screenshots/loops-active-mobile.png`.
