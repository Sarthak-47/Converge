# Build context: repository root (npm workspaces share one lockfile).
FROM node:24-alpine AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/collab/package.json apps/collab/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @converge/collab
COPY apps/collab apps/collab
RUN npm run build --workspace @converge/collab

FROM node:24-alpine
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/collab/package.json apps/collab/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @converge/collab && npm cache clean --force
COPY --from=build /repo/apps/collab/dist apps/collab/dist
WORKDIR /repo/apps/collab
USER node
EXPOSE 1234
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://localhost:1234/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
