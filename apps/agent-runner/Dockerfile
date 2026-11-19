# Build context: repository root (npm workspaces share one lockfile).
FROM node:24-alpine AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/agent-runner/package.json apps/agent-runner/
RUN npm ci --workspace @converge/agent-runner
COPY apps/agent-runner apps/agent-runner
RUN npm run build --workspace @converge/agent-runner

FROM node:24-alpine
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/agent-runner/package.json apps/agent-runner/
RUN npm ci --omit=dev --workspace @converge/agent-runner && npm cache clean --force
COPY --from=build /repo/apps/agent-runner/dist apps/agent-runner/dist
WORKDIR /repo/apps/agent-runner
USER node
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://localhost:' + (process.env.RUNNER_PORT || 4100) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
