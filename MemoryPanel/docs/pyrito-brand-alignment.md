# Pyrito app brand alignment

Implemented on `codex/pyrito-app-brand`, from `e29edf6c58536a5f8fa6dbf9acca21705689a1fb`.

The workspace now uses the approved website crystal, lowercase wordmark, Manrope and IBM Plex Mono, neutral graphite surfaces and lines, near-white text and amber actions. (October 2026: the app moved off the website's warm brown-black and brass tones so amber reads as the only accent; the website keeps its Starship palette.) `web/src/pyrito-colors.css` is the palette source for existing semantic and Tea component tokens. Error, success and chart colors remain distinguishable. Internal identifiers and backend contracts retain their existing names.

The header, dock, login, forms, Coordinator and shared page surfaces inherit the identity. Decorative Today/Coordinator slogans were removed. Navigation motion is restrained and the mobile dock fits all seven controls at 320px.

## Verification

- Production web build passes, including TypeScript. Vite reports existing mixed-import and bundle-size advisories.
- ESLint: zero errors; 31 warnings in unchanged components/hooks.
- Isolated preview API tests: 10 passed.
- Browser review: Today, task board, task creation dialog, Knowledge, Agents, Loops, Coordinator and login.
- Mobile preview: no document overflow at 320px; all dock controls fit inside the viewport.
- Browser console contains Tea/React forwardRef and findDOMNode deprecation warnings.

Preview uses invented data at `http://127.0.0.1:5191/#/today`. It cannot call production APIs or launch workers. This verifies presentation and existing UI wiring, not production writes or runtime integrations.

No production deployment performed. The live URL was inspected and still used Baren branding; its browser session returned no available team. Production data and service configuration were not changed.
