# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY packages/types/ ./packages/types/
COPY apps/web/ ./apps/web/

RUN pnpm --filter @clokr/web build

# ── Stage 3: Production-only dependency tree for @clokr/web ─────────────────
# `pnpm deploy` walks ONLY @clokr/web's own `dependencies` (chart.js, date-fns,
# svelte-dnd-action, @tanstack/svelte-query, @clokr/types) — unlike Stage 1's
# `pnpm install`, which resolves the whole workspace: every app's devDependencies
# plus the Prisma CLI. --prod excludes devDependencies.
#
# --legacy is required on this repo's default (isolated) node-linker: the modern
# (non-legacy) deploy path refuses with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE unless
# "inject-workspace-packages=true" is set (confirmed empirically — see 102-01-SUMMARY.md).
# Legacy deploy COPIES packages from Stage 1's already frozen-lockfile-resolved
# content-addressable store into the target dir (build log shows "downloaded 0" — no
# network fetch, no lockfile re-resolution, byte-identical versions to pnpm-lock.yaml).
FROM deps AS prod-deps
WORKDIR /app
RUN pnpm --filter @clokr/web deploy --prod --legacy /app/web-deploy

# ── Stage 4: Production runtime ────────────────────────────────────────────
FROM node:24-alpine AS runtime
# apk upgrade pulls the latest Alpine packages; the explicit min-version pins assert the
# openssl/musl CVE fixes and bust any cached layer (CVE-2026-31789 CRIT heap overflow +
# CVE-2026-28387/28388/28389/28390 + CVE-2026-45447 openssl; CVE-2026-40200 musl).
RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache "libcrypto3>=3.5.7-r0" "libssl3>=3.5.7-r0" "musl>=1.2.6-r2"
# Update npm's bundled dependencies to fix CVEs in minimatch/tar
RUN npm install -g npm@latest 2>/dev/null || true
WORKDIR /app

# Copy ONLY the production-only dependency closure for @clokr/web (Stage 3) plus the
# adapter-node build output (Stage 2) — not the full workspace `node_modules`.
#
# Genuine runtime externals of the adapter-node build output — verified by scanning every
# non-client .js file under apps/web/build/ (125 files) for real `import ... from`
# statements, not comments — are `date-fns`, `date-fns/locale` and `chart.js`, all three
# declared in @clokr/web's `dependencies`. A raw grep of the build output ALSO matches
# `svelte`, `@sveltejs/kit`, `@standard-schema/spec` and `types`, but every one of those
# hits lives inside a `/** @import {...} from '...' */` JSDoc comment (SvelteKit's own
# bundled source carries these for editor/type tooling) — they are never evaluated by
# Node and do not need to resolve at runtime. Do not restore the full workspace tree on
# the strength of a bare grep hit against this file; confirm real-vs-JSDoc first (see the
# scan method in 102-01-SUMMARY.md).
COPY --from=prod-deps /app/web-deploy/node_modules/ ./node_modules/
COPY --from=prod-deps /app/web-deploy/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/build/ ./apps/web/build/

# ABSENCE gate — fail the BUILD, not the container, if the pruned tree leaked Prisma,
# packages/db, or a devDependency of @clokr/web. Modelled on apps/api/Dockerfile's
# schema-engine presence gate (same `test -n`/`-z` + `find ... -print -quit` idiom).
# Depth budget verified empirically: an installed package's own directory sits at
# node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg> — 4 segments under node_modules.
RUN test -z "$(find /app -maxdepth 6 \( -iname 'prisma' -o -iname '@prisma' \) -print -quit)" \
    && test ! -e /app/packages/db \
    && test -z "$(find /app/node_modules -maxdepth 5 -type d \( -iname 'vite' -o -iname 'typescript' -o -iname 'svelte-check' -o -iname 'vitest' -o -iname 'jsdom' \) -print -quit)" \
    || (echo "FATAL: apps/web runtime image leaked build tooling (prisma, @prisma, packages/db, or a devDependency: vite/typescript/svelte-check/vitest/jsdom) -- check the 'pnpm deploy --prod --legacy' step (prod-deps stage) in apps/web/Dockerfile" >&2; exit 1)

# PRESENCE gate — fail the BUILD if a genuine runtime external failed to resolve. This is
# the IMG-03 risk this Dockerfile exists to guard against: a pruned image that boots but
# 500s on a real route because a real (non-JSDoc) import silently didn't make the cut.
RUN node --input-type=module -e "await import('date-fns'); await import('date-fns/locale'); await import('chart.js'); console.log('deps resolved')" \
    || (echo "FATAL: apps/web runtime image is missing a genuine external (date-fns, date-fns/locale, or chart.js) -- the prune removed something the adapter-node build output actually imports" >&2; exit 1)

# Create non-root user
RUN addgroup -g 1001 -S clokr && adduser -S clokr -u 1001

ENV NODE_ENV=production
ENV PORT=3000
ENV API_URL=http://api:4000

USER clokr
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "apps/web/build/index.js"]
