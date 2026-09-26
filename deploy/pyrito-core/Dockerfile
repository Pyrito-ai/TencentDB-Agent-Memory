# The Panel board API requires our matching Core metadata routes and CAS writes.
# Keep the proven upstream runtime, native dependencies, entrypoint and healthcheck.
FROM agentmemory/memory-core@sha256:55fec3a6067af7cc4dbb48017f590392cf0085f378b6bcac340a91690a9707ed
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/Pyrito-ai/TencentDB-Agent-Memory" \
      org.opencontainers.image.revision=$SOURCE_REVISION
COPY MemoryCore/src/ /app/src/
