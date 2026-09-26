# Baren Core runtime

Deploy this Core image together with the custom Panel image in `deploy/pyrito-hub`.
The upstream Core image alone does not provide `task/board-state`,
`task/board-transition`, or `task/execution-grant`. The Panel uses those routes
for task edits and moves; mixing the custom Panel with upstream Core produces
an upstream 404 presented by the Panel as `KERNEL_UNAVAILABLE`.

Build from the repository root using an immutable revision:

```sh
docker build --build-arg SOURCE_REVISION="$RELEASE_REVISION" \
  -t "pyrito/tencent-memory-core:$RELEASE_REVISION" \
  -f deploy/pyrito-core/Dockerfile .
docker run --rm --network none --entrypoint node \
  -v "$PWD/MemoryCore/tests:/app/tests:ro" \
  "pyrito/tencent-memory-core:$RELEASE_REVISION" \
  --import tsx --test tests/task-board-transitions.test.ts tests/task-board-http.test.ts
```

The pinned base supplies Node, native modules, `tsx`, the gateway command, and
the healthcheck. The gateway runs `/app/src/gateway/server.ts` directly. Our Core
changes use the base's existing dependencies. If Core runtime dependency
declarations change, update the base or install the matching dependencies before
deployment; do not assume that replacing source is sufficient.

Before activation, run the tests inside the candidate image and verify startup
with isolated data/config. Preserve the existing runtime configuration, volume,
and image for recovery. Stop Core briefly to take a consistent complete volume
backup, then replace only its image in stored and rendered Compose. These board
changes use existing metadata JSON fields and require no database schema change.

After activation, verify authenticated `task/board-state` through the public Panel,
move a task through the browser, refresh to verify persistence, and restore the
verification task's original status. An HTTP health response or a task-list read
alone does not prove compatibility. Verify stale revisions are rejected with 409.

Rollback must preserve a compatible Panel/Core pair. Reverting only Core to the
upstream image reintroduces the missing routes. Preserve current data before any
rollback and do not restore a data backup automatically over later user changes.
