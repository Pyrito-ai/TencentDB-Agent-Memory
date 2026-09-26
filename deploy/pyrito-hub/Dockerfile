# Build our Panel while retaining the pinned upstream Knowledge runtime.
# Deploy with deploy/pyrito-core/Dockerfile; upstream Core lacks the board API.
FROM node:22-slim AS panel
WORKDIR /build/panel
COPY MemoryPanel/package.json MemoryPanel/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY MemoryPanel/src ./src
COPY MemoryPanel/tsconfig.json ./
RUN npm run build
FROM node:22-slim AS web
WORKDIR /build/web
COPY MemoryPanel/web/package.json MemoryPanel/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY MemoryPanel/web ./
RUN npm run build
FROM agentmemory/memory-hub@sha256:6f35ddcfa104e630fedb39d6fbf2f3bd21de228682ff6c4b48b1275b70bc9e92
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/Pyrito-ai/TencentDB-Agent-Memory" \
      org.opencontainers.image.revision=$SOURCE_REVISION
COPY --from=panel /build/panel/dist /app/panel/dist
COPY --from=panel /build/panel/node_modules /app/panel/node_modules
COPY --from=web /build/web/dist /app/panel/web/dist
ENV TASK_BOARD_DATA_DIR=/data/knowledge/task-board
