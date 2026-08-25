# Contributing to Clokr

Thanks for your interest in contributing. This document covers how to get started, what we're looking for, and how the review process works.

## Before you start

For **bug fixes and small improvements** — open a PR directly.

For **larger features or breaking changes** — open an issue first so we can discuss approach before you invest time coding.

Issues use forms with required fields; blank issues are off. A feature or chore needs
**acceptance criteria** — without them it cannot be scheduled. How issues move from there is
described in [docs/PROCESS.md](docs/PROCESS.md).

## Setup

```bash
git clone https://github.com/sebastianzabel/clokr.git
cd clokr
pnpm install

# Start infrastructure
docker compose up postgres redis minio -d

# Configure
cp .env.example .env

# Apply migrations + seed demo data
# (never `prisma db push` and never `prisma migrate dev` — see CLAUDE.md)
pnpm --filter @clokr/db exec prisma migrate deploy
pnpm --filter @clokr/db exec prisma generate
pnpm --filter @clokr/db seed

# Start dev servers
pnpm dev
```

- Frontend: http://localhost:5173
- API: http://localhost:4000
- Swagger: http://localhost:4000/docs

## Code style

- Run `pnpm lint` before submitting — the pre-commit hook enforces this
- UI labels and user-facing text must be in **German**
- Code, comments, and commit messages in **English**
- No hard deletes of time/leave/employee data — audit trail is required
- No hardcoded hex colors in component styles — use CSS custom properties

## Commit messages

Follow the existing pattern: `type(scope): description`

```
feat(leave): add iCal export for team absences
fix(api): correct overtime calculation for MONTHLY_HOURS schedule
refactor(ui): move shared calendar rules to app.css
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, `ci`, `build`

## Pull requests

- Keep PRs focused — one concern per PR
- Update relevant docs if behavior changes
- Add tests for new API endpoints (see `apps/api/src/__tests__/`)

## What we're looking for

Areas where contributions are especially welcome:

- **i18n** — the app is German-only right now; English support would broaden adoption
- **Tests** — coverage is improving but more is always better
- **Mobile** — the UI is responsive but not yet a PWA
- **Bug fixes** — check open issues

## Legal

By submitting a PR you agree that your contribution is licensed under the [MIT License](LICENSE).
