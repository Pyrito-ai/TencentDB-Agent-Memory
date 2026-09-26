# Coordinator layout follow-up — 2026-09-26

User request: use the coordinator without obscuring the rest of the app.

## Implementation

- Replaced the narrow-screen overlay with a grid pane. At 800px+ the app and coordinator share horizontal space; below 800px they occupy separate 55%/45% rows.
- Show/hide control at every width; default open at desktop/tablet widths. Closing preserves the mounted identity-scoped conversation, draft, proposal, and request state.
- Removed backdrop, modal role, background inert, document scroll lock, and Tab trap. Escape inside the coordinator closes it and returns focus to its header toggle.
- Dock compact layout and magnification now depend on available work-area width. More menu height respects the work-area height, including the phone split.
- Short coordinator panes scroll so the composer remains reachable.

## Verification

- Build passed. Targeted ESLint, changed-file Prettier, and diff checks passed. Eleven existing coordinator/navigation tests passed.
- Browser at 1055x998: main right=717.4, coordinator left=717.4; no overlap, no backdrop, no modal attribute, app not inert; document width=1055.
- At 800px: work area=480px, dock compact, no document horizontal overflow.
- At 390x844: app ends y493 and coordinator starts y493. More menu is bounded within the app (y88–407). Document width=390.
- At 390x450: panes remain separate; composer reachable by focus/scroll within its pane. Document width=390.
- Board search worked while coordinator open. Draft survived hide/reopen and navigation to Today. Tab left coordinator; Escape restored header-toggle focus.
- Synthetic message generated a proposal; it remained available through hide/reopen. Apply was not executed: automatic approval review rejected this optional synthetic mutation test and required approval of that specific proposal, even after source verification of the isolated in-memory fixture. Existing server tests passed; no live mutations occurred.
- Browser viewport restored. User's existing preview remains on their selected Loops page with coordinator visible.

## Evidence

- [Current-width split](screenshots/coordinator-split-1055.png)
- [Phone split](screenshots/coordinator-split-mobile.png)

No merge or deployment. Existing preview/discard instructions remain in REVIEW.md.
