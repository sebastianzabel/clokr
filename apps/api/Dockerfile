# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/

# Install deps. pnpm 10 blocks ALL dependency build scripts by default; the
# onlyBuiltDependencies allowlist in pnpm-workspace.yaml permits exactly the Prisma
# packages (@prisma/engines, prisma), which is what materializes the schema-engine
# binary at install time. sharp deliberately stays OFF that allowlist — its postinstall
# crashes under QEMU on this cross-platform (linux/amd64,linux/arm64) build.
RUN pnpm install --frozen-lockfile

# Build gate: Prisma's schema-engine binary MUST be materialized at install time.
# pnpm 10 blocks dependency build scripts by default; without the onlyBuiltDependencies
# allowlist in pnpm-workspace.yaml, @prisma/engines' postinstall never runs, the binary is
# missing, and `prisma migrate deploy` tries to download it from binaries.prisma.sh at
# container start. That is what crash-looped release 1.9.15 on int (no cluster egress,
# ECONNRESET). Do not remove this check — it is the only thing that catches the regression
# before the image ships.
RUN test -n "$(find /app/node_modules -name 'schema-engine*' -type f -print -quit)" \
    || (echo "FATAL: no Prisma schema-engine binary in /app/node_modules — check onlyBuiltDependencies in pnpm-workspace.yaml" >&2; exit 1)

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY packages/types/ ./packages/types/
COPY packages/db/ ./packages/db/
COPY apps/api/ ./apps/api/

# Generate Prisma client — ensure @prisma/client is resolvable from schema location
#
# `pnpm --filter @clokr/db exec prisma generate`, never a bare `npx` invocation: npx's
# resolution can't see pnpm's isolated node_modules, so it silently fetches an arbitrary
# version from the npm registry instead of the lockfile-pinned CLI. That is exactly what
# broke this build (npm resolved prisma@8.0.0-rc.10, a Prisma 8 RC, against this project's
# pinned Prisma 7.8.0 schema, and exited 2). `pnpm --filter @clokr/db exec` runs the
# lockfile-pinned CLI already installed by `pnpm install --frozen-lockfile` above and never
# touches the registry — the same invocation `.github/workflows/ci.yml` and CLAUDE.md use.
# Do not "simplify" this back to npx; it silently reopens a supply-chain hole in the
# production image.
RUN mkdir -p /app/packages/db/node_modules/@prisma && \
    ln -sf /app/node_modules/.pnpm/node_modules/@prisma/client /app/packages/db/node_modules/@prisma/client && \
    pnpm --filter @clokr/db exec prisma generate

# Build API
RUN pnpm --filter @clokr/api build

# Compile seed script for runtime (tsx not available in prod)
RUN pnpm --filter @clokr/db run seed:build

# Copy generated Prisma client into dist/ so compiled seed.js can resolve
# '../generated/client' relative to dist/src/seed.js → dist/generated/client
RUN cp -r /app/packages/db/generated /app/packages/db/dist/generated

# ── Stage 3: Production-only dependency tree for @clokr/api + @clokr/db ─────
# `pnpm deploy --prod --legacy` walks ONLY @clokr/api's own `dependencies` (fastify family,
# sharp, minio, pdfkit, ...) plus the PRODUCTION `dependencies` of its workspace dependency
# @clokr/db (transitively: @prisma/client, @prisma/adapter-pg, pg, bcryptjs) — never either
# project's `devDependencies`. Same mechanism apps/web/Dockerfile uses (102-01-SUMMARY.md);
# --legacy is required for the identical reason recorded there: this repo's isolated
# node-linker rejects a non-legacy deploy of a project with workspace dependencies
# (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE). Build log shows "downloaded 0" — packages are
# cloned from the deps stage's already frozen-lockfile-resolved store, no re-resolution.
FROM deps AS prod-deps
WORKDIR /app
RUN pnpm --filter @clokr/api deploy --prod --legacy /app/api-deploy

# ── Stage 4: Retained tooling closure (prisma CLI + schema-engine, tsx) ─────
# The empirically-derived KEEP list (102-API-RUNTIME-SET.md) requires the prisma CLI +
# schema-engine binary (docker-entrypoint.sh:19-23,30 — `migrate deploy`) and tsx
# (charts/clokr-app/templates/cronjob-anonymizer.yaml:51 `pnpm tsx scripts/anonymize-dump.ts`,
# and every apps/api/scripts/*.ts operator script invoked the same way) at container runtime,
# even though apps/api/package.json and packages/db/package.json deliberately keep both as
# devDependencies (102-02-SUMMARY.md: neither is ever require()'d from compiled dist/ output,
# so a package.json section move doesn't apply here — their retention is a Dockerfile-level
# decision). Stage 3's --prod deploy excludes them by design; this stage re-adds them.
#
# Deliberately NOT the same `--legacy --prod` mechanism as Stage 3 — measured empirically that
# `pnpm --filter @clokr/db deploy --legacy` WITHOUT --prod (needed to pull in devDependencies)
# also pulls in the entire workspace ROOT's own devDependencies (turbo, vitest, husky, eslint —
# 761 packages resolved, a `prepare: husky` script even ran): legacy deploy's non-prod mode does
# not scope to the target project. Modern deploy mode (workspace injection overridden per
# invocation via --config, since the persistent pnpm-workspace.yaml config stays untouched —
# same non-injected-workspace constraint as Stage 3, worked around differently here because
# --legacy is what caused the leak) scopes correctly: 131 packages, exactly @clokr/db's own
# dependencies + devDependencies (prisma incl. schema-engine via the onlyBuiltDependencies
# allowlist, tsx, typescript, @prisma/*, pg, bcryptjs) — nothing from the workspace root or
# apps/web. @clokr/db is the deploy target (not @clokr/api) because prisma/tsx are
# packages/db's own devDependencies, not apps/api's — deploying @clokr/api in this same mode
# was confirmed NOT to pull them in transitively (a workspace dependency's devDependencies are
# never part of another project's deploy closure, in either legacy or modern mode). Full
# before/after package listings: 102-03-SUMMARY.md.
FROM deps AS tooling-deps
WORKDIR /app
RUN pnpm --filter @clokr/db deploy --config.inject-workspace-packages=true /app/db-tooling-deploy

# ── Stage 5: Production runtime ────────────────────────────────────────────
FROM node:24-alpine AS runtime
# apk upgrade pulls the latest Alpine packages; the explicit min-version pins assert the
# openssl/musl CVE fixes and bust any cached layer (CVE-2026-31789 CRIT heap overflow +
# CVE-2026-28387/28388/28389/28390 + CVE-2026-45447 openssl; CVE-2026-40200 musl).
RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache su-exec "libcrypto3>=3.5.7-r0" "libssl3>=3.5.7-r0" "musl>=1.2.6-r2"
# Update npm to latest (fixes bundled tar/minimatch CVEs) and clean old cache
RUN npm install -g npm@latest 2>/dev/null || true \
    && npm cache clean --force 2>/dev/null || true \
    && rm -rf /tmp/* /root/.npm/_cacache
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

# node_modules assembly: the production-scoped dependency closure (Stage 3) plus the
# explicitly retained tooling (Stage 4) — NOT the full workspace node_modules the comment
# here used to describe. KEEP list, each entry with its consumer:
#   - fastify family, sharp, minio, pdfkit, nodemailer, ... (Stage 3) -> apps/api/src/app.ts
#     and the plugin/route modules that require() them
#   - @prisma/client, @prisma/adapter-pg, pg, bcryptjs (Stage 3)      -> apps/api/dist/plugins/
#     prisma.js, packages/db/dist/src/seed.js
#   - prisma CLI + schema-engine binary (Stage 4)                    -> docker-entrypoint.sh:
#     19-23,30 (`migrate deploy`)
#   - tsx (Stage 4)                                                  -> cronjob-anonymizer.yaml:
#     51 (`pnpm tsx scripts/anonymize-dump.ts`), apps/api/scripts/*.ts operator scripts
# DROP (no longer present): vite, the workspace ROOT's own devDependencies (turbo, vitest,
# husky, eslint, playwright), apps/web and its own dependency tree.
COPY --from=prod-deps /app/api-deploy/node_modules/ ./node_modules/
COPY --from=tooling-deps /app/db-tooling-deploy/node_modules/ ./node_modules/

# typescript is packages/db's third devDependency (alongside prisma/tsx above) and comes
# along for the ride in Stage 4's closure, but it has no runtime consumer
# (102-API-RUNTIME-SET.md Part C.4: zero require("typescript") anywhere in compiled dist/
# output — tsx transpiles via its own bundled esbuild, it never shells out to the typescript
# package). Removed post-merge rather than left sitting in a production image.
RUN rm -rf /app/node_modules/typescript /app/node_modules/.bin/tsc /app/node_modules/.bin/tsserver \
    /app/node_modules/.pnpm/typescript@*

# Build gate (see the identical check in the deps stage): assert the schema-engine binary
# actually survived the COPY into the runtime stage. The container has no egress to
# binaries.prisma.sh, so a missing binary here = crash loop at `prisma migrate deploy`.
RUN test -n "$(find /app/node_modules -name 'schema-engine*' -type f -print -quit)" \
    || (echo "FATAL: Prisma schema-engine binary missing in runtime node_modules" >&2; exit 1)

COPY --from=build /app/apps/api/ ./apps/api/
COPY --from=build /app/packages/ ./packages/
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/pnpm-lock.yaml ./

# apps/api/node_modules/typescript and packages/db/node_modules/typescript are each
# workspace package's own local symlink into the root .pnpm/typescript@* entry just removed
# above (inherited unchanged from the build stage's full install) — would dangle otherwise.
# Same DROP decision as above, not a second one.
RUN rm -f /app/apps/api/node_modules/typescript /app/apps/api/node_modules/.bin/tsc \
    /app/apps/api/node_modules/.bin/tsserver /app/packages/db/node_modules/typescript \
    /app/packages/db/node_modules/.bin/tsc /app/packages/db/node_modules/.bin/tsserver

# Rebuild native modules + ensure pnpm@10 hoisted prisma is resolvable from workspace packages.
# packages/db/node_modules/{prisma,@prisma/client} (copied above, created by the deps stage's
# original pnpm install) already resolve correctly on their own — the lines below are
# defensive reinforcement, not the primary mechanism.
#
# Retargeted from the pre-prune Dockerfile's `.pnpm/node_modules/{prisma,@prisma/client}`
# (pnpm's own internal single-version dedup shortcut, populated by a full workspace install)
# to the top-level `node_modules/{prisma,@prisma/client}` symlinks Stage 4 produces directly:
# measured empirically that Stage 4's scoped deploy does NOT populate that particular dedup
# shortcut for prisma (unlike a full workspace install does), so the old target would
# silently dangle under the new tree shape.
#
# `-fn`, not the pre-prune Dockerfile's `-f` alone: `ln -sf TARGET LINK` has a well-known
# gotcha when LINK is an existing symlink that itself resolves to a directory (true here —
# packages/db/node_modules/prisma resolves to the prisma package folder) — `-f` alone does
# NOT replace LINK in that case, it creates TARGET's basename *inside* the directory LINK
# resolves to instead, silently. Confirmed empirically while demonstrating the test -e gate
# below: the pre-prune Dockerfile's `ln -sf` line was ALREADY a no-op for this exact reason
# (the inherited symlink is what actually did the work, undisturbed) — see 102-03-SUMMARY.md.
# `-n` (BusyBox ln: "don't dereference symlinks — treat like normal file") makes `-f` replace
# LINK itself, matching what the line always intended to do.
RUN pnpm rebuild sharp 2>/dev/null || npm rebuild sharp 2>/dev/null || true
RUN mkdir -p /app/packages/db/node_modules/@prisma && \
    ln -sfn /app/node_modules/prisma /app/packages/db/node_modules/prisma && \
    ln -sfn /app/node_modules/@prisma/client /app/packages/db/node_modules/@prisma/client

# ── Assertion gates: fail the BUILD, not the container, if a retained tool didn't survive
# the prune. Same idiom as the schema-engine gates above (test ... || FATAL); each gate names
# its consumer so a build-log reader knows what would have broken in production.

# pnpm itself on PATH — the tsx gate below and every CronJob/operator-script invocation
# ("pnpm tsx <script>.ts") depend on it.
RUN command -v pnpm >/dev/null \
    || (echo "FATAL: pnpm not on PATH -- required by cronjob-anonymizer.yaml's command shape ('pnpm tsx ...') and by every 'pnpm tsx scripts/<x>.ts' operator-script invocation" >&2; exit 1)

# Prisma CLI, resolved EXACTLY the way docker-entrypoint.sh:19 resolves it — same `find`
# expression, verbatim, so this gate cannot pass while the entrypoint's own resolution fails.
RUN test -n "$(find /app/node_modules -name "prisma" -path "*/node_modules/.bin/prisma" | head -1)" \
    || (echo "FATAL: no prisma CLI (.bin/prisma) under /app/node_modules -- docker-entrypoint.sh:19-23,30 resolves it exactly this way for 'migrate deploy'" >&2; exit 1)

# tsx, resolvable the way the anonymizer CronJob and every apps/api/scripts/*.ts operator
# script invoke it: `pnpm tsx <script>` with cwd=/app/apps/api.
RUN cd /app/apps/api && pnpm tsx --version >/dev/null \
    || (echo "FATAL: 'pnpm tsx --version' failed from /app/apps/api -- charts/clokr-app/templates/cronjob-anonymizer.yaml:51 runs 'pnpm tsx scripts/anonymize-dump.ts' from this exact working directory" >&2; exit 1)

# Both pnpm@10 hoisting symlinks present AND resolvable — test -e follows the link and checks
# the TARGET exists; test -L would pass on a dangling link (T-102-17).
RUN test -e /app/packages/db/node_modules/prisma && test -e /app/packages/db/node_modules/@prisma/client \
    || (echo "FATAL: packages/db/node_modules/{prisma,@prisma/client} missing or dangling -- pnpm@10 hoisting broken (D-05)" >&2; exit 1)

# ABSENCE gate for the DROP set: no vite, no typescript, no apps/web tree. Modelled on
# apps/web/Dockerfile's identical-purpose gate.
RUN test -z "$(ls /app/node_modules/.pnpm 2>/dev/null | command grep -E "^(vite|typescript)@")" && test ! -e /app/apps/web \
    || (echo "FATAL: apps/api runtime image leaked build tooling (vite, typescript, or an apps/web tree) -- check the prod-deps/tooling-deps stages in apps/api/Dockerfile" >&2; exit 1)

# Create non-root user
RUN addgroup -g 1001 -S clokr && adduser -S clokr -u 1001

# Entrypoint: db push → seed → start server
COPY --from=build /app/apps/api/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://0.0.0.0:4000/health || exit 1

CMD ["/docker-entrypoint.sh"]
