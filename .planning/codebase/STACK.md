# Technology Stack

**Analysis Date:** 2026-03-30

## Languages

**Primary:**

- TypeScript 6.0.2 - All backend and frontend source code
- Svelte 5.55.0 - UI components with runes syntax (`$state`, `$derived`, `$effect`, `$props`)

**Secondary:**

- JavaScript/Node.js - Runtime, build scripts
- SQL - Executed via Prisma

## Runtime

**Environment:**

- Node.js 24-alpine - Container runtime for both API and web
- pnpm 10.33.0 - Workspaces package manager

**Package Manager:**

- pnpm 10.33.0
- Lockfile: `pnpm-lock.yaml` (present)
- Workspace structure: `pnpm-workspace.yaml`

## Frameworks

**Core:**

- Fastify 5.8.4 - HTTP server for API (`apps/api`)
- SvelteKit 2.55.0 - Web framework with SSR/SSG for `apps/web`
- @sveltejs/adapter-node 5.5.4 - Node.js adapter for SvelteKit

**Database & ORM:**

- Prisma 7.6.0 - ORM layer
- @prisma/client 7.6.0 - Runtime client
- @prisma/adapter-pg 7.6.0 - PostgreSQL adapter
- PostgreSQL 18-alpine - Primary database

**Testing:**

- Vitest 4.1.2 - Unit/integration test runner
- @vitest/coverage-v8 4.1.1 - Code coverage
- @playwright/test 1.58.2 - End-to-end testing (apps/e2e)
- @axe-core/playwright 4.11.1 - Accessibility testing

**Build/Dev:**

- Turbo 2.8.20 - Monorepo task runner
- Vite 8.0.2 - Frontend build tool
- @sveltejs/vite-plugin-svelte 7.0.0 - Svelte compilation
- TypeScript compiler (tsc) - Type checking
- tsx 4.21.0 - TypeScript Node runner for dev

**Code Quality:**

- ESLint 10.1.0 - Linting (ES and TypeScript)
- @typescript-eslint/eslint-plugin 8.57.2 - TS linting rules
- eslint-plugin-svelte 3.16.0 - Svelte linting
- svelte-eslint-parser 1.6.0 - Svelte parsing
- Prettier 3.8.1 - Code formatting
- prettier-plugin-svelte 3.5.1 - Svelte formatting
- husky 9.1.7 - Git hooks
- lint-staged 16.4.0 - Pre-commit linting

## Key Dependencies

**Authentication & Security:**

- @fastify/jwt 10.0.0 - JWT handling for API
- bcryptjs 3.0.3 - Password hashing
- @fastify/helmet 13.0.2 - Security headers

**API Infrastructure:**

- @fastify/cors 11.2.0 - CORS middleware
- @fastify/rate-limit 10.3.0 - Rate limiting (500 req/min default)
- @fastify/swagger 9.7.0 - OpenAPI/Swagger documentation
- @fastify/swagger-ui 5.2.5 - Swagger UI at `/docs`
- @fastify/multipart 9.4.0 - File upload handling

**Storage & File Handling:**

- minio 8.0.7 - S3-compatible object storage client
- sharp 0.34.5 - Image processing (avatars)
- pdfkit 0.18.0 - PDF generation

**Email:**

- nodemailer 8.0.4 - SMTP email sending

**Data & Utilities:**

- zod 4.3.6 - Schema validation
- date-fns 4.1.0 - Date utilities (web)
- date-fns-tz 3.2.0 - Timezone support (API)
- node-cron 4.2.1 - Scheduled tasks (monthly close, data retention, sync)

**UI & Styling:**

- chart.js 4.5.1 - Chart rendering
- @tanstack/svelte-query 6.1.10 - Server state management
- tailwindcss 4.2.2 - CSS framework
- postcss 8.5.8 - CSS processing
- autoprefixer 10.4.27 - CSS vendor prefixes

**Logging & Observability:**

- pino - JSON logging (included via fastify)
- pino-pretty 13.1.3 - Pretty console output (dev)
- pino-roll 4.0.0 - Log file rotation
- @elastic/ecs-pino-format 1.5.0 - Elastic Common Schema formatting

**Database:**

- pg 8.20.0 - PostgreSQL driver

## Configuration

**Environment Variables:**

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection (configured but not actively used in core)
- `JWT_SECRET`, `JWT_REFRESH_SECRET` - Auth tokens (min 32 chars)
- `ENCRYPTION_KEY` - Field-level encryption (min 32 chars)
- `CORS_ORIGIN` - Web app URL for CORS
- `APP_URL` - Frontend URL for email links
- `API_PORT`, `API_HOST` - API server binding (default 4000)
- `NODE_ENV` - development|production|test
- `SMTP_*` - Email server config (optional, can be set per-tenant in DB)
- `MINIO_*` - Object storage credentials
- `LOG_LEVEL` - Logging verbosity
- `LOG_FORMAT` - json|ecs|pretty
- `LOG_FILE` - Optional log file path with daily rotation
- `POOL_MIN`, `POOL_MAX` - Database connection pool
- `SEED_DEMO_DATA` - Bootstrap demo data on startup

**Build Configuration:**

- `tsconfig.json` - Present in all packages
- `vite.config.ts` - SvelteKit Vite config
- `.prettierrc` - 2-space indent, trailing commas, 100 char width
- `eslint.config.js` - Flat config with TypeScript, Svelte, Prettier

## Platform Requirements

**Development:**

- Node.js 24+ (uses ES modules)
- pnpm 10.33.0
- Docker & Docker Compose (for services: PostgreSQL, Redis, MinIO)
- Git with Husky hooks

**Production:**

- Docker/Kubernetes with Node.js 24-alpine base
- PostgreSQL 18
- Redis 7 (optional, configured but unused)
- MinIO (S3-compatible object storage)
- SMTP server (optional, configurable per tenant)

**Services (docker-compose):**

- PostgreSQL 18-alpine:5432
- Redis 7-alpine:6379
- MinIO:9000,9001 (S3 API + console)
- Optional backup service (pg_dump daily, 7-day retention)

---

_Stack analysis: 2026-03-30_
