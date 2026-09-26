# Combined Task board review — 2026-09-26

Preview: http://127.0.0.1:5191/#/

All implementation remains in the isolated `baren-gui-dock` worktree. No backend schema/API changes, production mutations, merge or deployment.

## Changes

- One Task board dock destination. Projects management lives in a drawer from its heading.
- Project selector, search, assignee and priority share one compact toolbar; selected project context appears above the board.
- Project drawer retains search, archived projects, counts, create/edit/archive/restore permissions and Wiki context. View tasks applies that project filter and clears other board filters.
- New tasks inherit the selected active project and open their existing detail view. Assignment failure reports that creation succeeded and allows recovery in task details without creating a duplicate.
- Removed card status dropdowns. Existing drag/drop handlers and detail workflow editor remain.
- Project filters and drawer selection use hash query parameters. Legacy `/projects?id=...` links redirect while preserving task and unrelated query values. Actual team changes clear team-scoped project/task selection.
- Project edits retain their original target across history navigation. Escape closes the editor before its parent drawer; focus returns to a stable control.

## Verification

- Frontend production build and Panel typecheck passed. All 126 tests across 18 Panel files passed, including six navigation compatibility cases.
- Targeted ESLint, changed-source Prettier checks and `git diff --check` passed. Existing Vite chunk-size and mixed-import warnings remain.
- Synthetic browser pass: create project; project-scoped task creation and assignment; task status change through detail; edit project; archive/restore; project search; View tasks; legacy redirect with retained task/unrelated query; project filter reload/back/forward.
- Synthetic member role: edit/archive controls absent while project details and View tasks remain accessible. Empty, loading and error manager states rendered; Retry available for errors.
- Edit regression checked: opened Customer understanding editor, navigated back to the collection, then saved; original project was updated and reopened.
- Escape and focus restoration checked for both editor and drawer.
- Populated layouts reviewed at 1440, 1024 and 390 CSS pixels. No document horizontal overflow at 1024/390; board columns scroll within their container. Mobile search field is full width. Corrected drawer header wrapping.
- Zero native selects remain in task cards. Native select task-detail status transition passed. Pointer drag was not repeated in this follow-up; its handlers remain unchanged.
- This follow-up used authenticated synthetic fixtures. The earlier real authenticated read-only pass and 200% zoom pass are documented in REVIEW.md / ZOOM-QA.md; those passes preceded this consolidation. Native runtime execution and live mutations were not performed.

## Screenshots

- [Desktop board](screenshots/combined-board-desktop.png)
- [Tablet board](screenshots/combined-board-tablet.png)
- [Mobile board](screenshots/combined-board-mobile.png)
- [Mobile project detail](screenshots/combined-project-mobile.png)
- [Desktop project search](screenshots/combined-project-desktop.png)

Discard instructions remain in REVIEW.md.
