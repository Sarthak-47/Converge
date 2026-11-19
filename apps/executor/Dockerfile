# Build context: repository root (npm workspaces share one lockfile).
FROM node:24-alpine AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/executor/package.json apps/executor/
RUN npm ci --workspace @converge/executor
COPY apps/executor apps/executor
RUN npm run build --workspace @converge/executor

FROM node:24-alpine
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/executor/package.json apps/executor/
RUN npm ci --omit=dev --workspace @converge/executor && npm cache clean --force
COPY --from=build /repo/apps/executor/dist apps/executor/dist
WORKDIR /repo/apps/executor
# Runs as root only to reach the mounted Docker socket, which is root-equivalent whoever holds it. This is the
# one service that holds it (design §11.3); jobs themselves run unprivileged, without network, in their own
# containers. Before execution is reachable by others: rootless Docker or gVisor (SANDBOX_RUNTIME=runsc).
CMD ["node", "dist/main.js"]
