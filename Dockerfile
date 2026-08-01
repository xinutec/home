# --- backend build -------------------------------------------------------
FROM node:24-alpine AS backend-build
WORKDIR /app
# pnpm-workspace.yaml carries the install-script allowlist; without it esbuild
# never unpacks its binary. pnpm is taken unpinned — the host gets its copy from
# the flake, and a second version here would be two numbers held level by hand.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc

# --- frontend build ------------------------------------------------------
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
# git: the shared layout harness is a git dependency (github:xinutec/ui-harness),
# so the install clones it — node:alpine ships no git.
RUN apk add --no-cache git ca-certificates \
    && npm install -g pnpm \
    && pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm run build

# --- runtime -------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --prod is pnpm's --omit=dev. The allowlist file comes along because the
# install still runs esbuild's postinstall for any prod dependency that needs it.
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist/frontend/browser ./public
# The node base image ships a nonroot "node" user (uid 1000), matched by
# k8s/03-app.yaml. Files above are world-readable, so it can run them.
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
