# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Build the TypeScript source into dist/
# Note: Uses npm (not pnpm) because no monorepo workspace is available at
# container build time. FRITZBOX_PASS is passed via env at runtime — never
# embedded in the image. (See T-25-09-06: production deployments should use
# Docker secrets or a secrets manager instead of compose env vars.)
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: runner ───────────────────────────────────────────────────────────
# Lean runtime image — only dist/ + prod node_modules
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./

CMD ["node", "dist/index.js"]
