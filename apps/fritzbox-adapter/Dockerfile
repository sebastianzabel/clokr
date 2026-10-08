# Three-stage build: builder (compile), prod-deps (runtime node_modules), runner.
#
# Dependencies are installed with `npm ci` from package-lock.json, so the image gets exactly
# the locked versions. `--ignore-scripts` is safe here: the only runtime dependency is dotenv,
# the build is plain `tsc`, and no dependency needs a lifecycle script for this image.
#
# NOTE: package-lock.json is NOT maintained by Dependabot (the root npm ecosystem updates
# pnpm-lock.yaml). After any package.json bump, regenerate it with:
#   npm install --package-lock-only --ignore-scripts
# otherwise `npm ci` fails loudly on the drift — that failure is intended (fail closed).
#
# Uses npm (not pnpm) because no monorepo workspace is available at container build time.
# FRITZBOX_PASS is passed via env at runtime — never embedded in the image.
# (See T-25-09-06: production deployments should use Docker secrets or a secrets manager
# instead of compose env vars.)

# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Build the TypeScript source into dist/ (needs devDependencies: typescript, @types/node)
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: prod-deps ───────────────────────────────────────────────────────
# Production node_modules only — no typescript, vitest or tsx in the runtime image
FROM node:24-alpine AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 3: runner ───────────────────────────────────────────────────────────
# Lean runtime image — only dist/ + prod node_modules, running as the built-in `node` user
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Files stay root-owned and world-readable: the process must read its code, never write it.
# The adapter writes no files and listens on an unprivileged port (DEVICES_PORT, default 8765).
COPY --from=builder /app/dist/ ./dist/
COPY --from=prod-deps /app/node_modules/ ./node_modules/
COPY package.json ./

USER node

CMD ["node", "dist/index.js"]
