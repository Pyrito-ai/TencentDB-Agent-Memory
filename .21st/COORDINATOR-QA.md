# Coordinator browser verification

Date: 2026-09-26. Tested the actual App and coordinator on the isolated synthetic preview at `http://127.0.0.1:5191/`. No live model, backend mutation or runtime session was used. The available browser was Chrome; the requested in-app browser was unavailable when this follow-up pass started.

## Results

| Viewport            | Check                    | Observed result                                                                                                                                                    |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 390 × 844           | Open and close           | Header button opens a labelled modal Coordinator; close control receives focus. The drawer is 390px wide and fits the viewport.                                    |
| 390 × 844           | Keyboard focus           | Shift+Tab from Close wraps to enabled Send; Tab from Send wraps to Close. Escape returns focus to Open coordinator.                                                |
| 390 × 844           | Background isolation     | Background is inert while open. Closing restores background interaction and sets the mounted drawer shell inert and aria-hidden.                                   |
| 390 × 844           | Draft persistence        | Typed draft survives Escape, closing and reopening.                                                                                                                |
| 390 × 844           | Proposal dismissal       | Create request produces a reviewed task proposal. Dismiss removes it and appends the synthetic confirmation that no task was created.                              |
| 390 × 844           | Proposal application     | A second proposal applies successfully and appends the synthetic task-created confirmation. No live data changes.                                                  |
| 390 × 844           | Long conversation layout | Conversation scrolls within the drawer; footer bottom and panel bottom both equal 844px. Document scroll width remains 390px.                                      |
| 1024 × 768          | Responsive drawer        | Coordinator uses a 390px drawer; focus starts on Close; aria-modal is true. The typed draft is preserved across viewport changes.                                  |
| 1024 × 768          | Focus and closing        | Both focus wrap directions pass. Escape returns focus to Open coordinator; draft survives close/reopen.                                                            |
| 1024 × 768          | Revision conflict        | `?coordinator=conflict` returns one simulated 409 on Apply. Visible error retains proposal and draft. Refresh retrieves the new revision; a second Apply succeeds. |
| 1024 × 768          | Not configured           | `?coordinator=offline` displays Not configured and the model-connection notice. Send stays disabled even with a draft.                                             |
| 1024 × 768          | Failed state refresh     | `?coordinator=error` displays Unavailable with an alert and Refresh action. Refresh, close and reopen preserve the draft; Send stays disabled.                     |
| Desktop, prior pass | Navigation persistence   | Conversation, pending proposal and typed draft survive navigation from Today to Projects. Applying the preserved proposal succeeds in the fixture.                 |

Temporary viewport override was reset after testing. No coordinator focus/aria-hidden errors were observed during the final mobile pass. Existing Tea dependency console warnings about forwardRef and findDOMNode remain visible.

## Final palette capture

The final mobile screenshot uses the user-selected Meridian Blue tokens from `MemoryPanel/web/src/meridian-colors.css`: background `#eef0f3`, card `#ffffff`, foreground `#181b21`, primary `#3b608f`, muted `#e8eaee`, border `#c9cfd8`, and destructive `#b8332e`. Layout and proposal behavior are unchanged. Captured after the token update at 390 × 844, with the reviewed proposal and pinned composer visible.

![Coordinator with a reviewed task proposal](screenshots/coordinator-mobile.png)

## Fixture improvements found during QA

- Fixture session storage is now document-local and in memory. An `auth=login` test tab previously cleared the origin's shared test session and logged out parallel QA tabs; the fixture now neither reads nor writes native localStorage and ignores cross-tab storage events.
- Added explicit coordinator offline, error and one-shot conflict controls. Their query parameters are documented in `MemoryPanel/web/tests/baren-preview/README.md`.
- Task context fixtures include inherited references, and the analytics/default-agent-template read handlers cover the existing UI requests.

## Scope

This pass verifies rendered UI, focus behavior and synthetic request wiring. The fixture deliberately refuses unknown mutations, disables runtime launches and cannot establish production model readiness, backend authorization or native runtime preservation. Full reload resets the fixture; conversation persistence is across mounted SPA navigation and drawer visibility changes, not reload.

## Automated checks

- Fixture node tests: 6 passed, 0 failed, covering network isolation, synthetic authentication, task details, task transitions, coordinator approval/replay/conflict, and scenario availability.
- Fixture TypeScript project (including real app sources): passed.
- Focused `GlobalCoordinator.tsx` ESLint: passed.
- Coordinator source/styles and all fixture files: Prettier check passed.
