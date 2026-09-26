# Baren application direction

Use the active Coordinator Workspace board, not the archived Zen Canvas boards. The user subsequently selected Meridian Blue for all color tokens: cool gray field, white panels, blue controls and copper secondary accents. The Penpot layout, supplied logo, Manrope interface and IBM Plex Mono utility text remain.

Implementation uses React, existing Tea controls, shared Baren presentation components, and Lucide + Framer Motion for an accessible dock. The supplied 21st reference was inspected directly; no registry CLI install or 21st automated review was used. The CLI was unavailable. The dock is a route-driven implementation of the reference interaction with Meridian Blue colors, focus semantics and reduced-motion handling.

Keep existing permission, data, routing, scheduling, payment and worker-session semantics. Do not invent metrics, meeting times, connection readiness or global planning support. All tests that mutate data run against the isolated browser fixture. Native Orca/cdesktop interiors remain native.

Meridian Blue was retrieved directly through 21st.dev’s free theme tool (ID `12b00883-ea08-4925-9f08-bc5daae42eb6`). The original bundle is saved in `meridian-blue-source.css`; runtime `src/meridian-colors.css` preserves its exact light and dark color tokens without changing typography or adding a theme switch. Tea semantic tokens map onto these shared colors.
