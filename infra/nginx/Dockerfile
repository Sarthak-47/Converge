# Build context: repository root. Builds the web app and serves it with the routing config.
FROM node:24-alpine AS web
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/collab/package.json apps/collab/
RUN npm ci --workspace @converge/web
COPY apps/web apps/web
RUN npm run build --workspace @converge/web

FROM nginx:stable-alpine
COPY infra/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /repo/apps/web/dist /usr/share/nginx/html
