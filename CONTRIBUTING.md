# Contributing to Clokr

Thanks for your interest in contributing. This document covers how to get started, what we're looking for, and how the review process works.

## Before you start

For **bug fixes and small improvements** — open a PR directly.

For **larger features or breaking changes** — open an issue first so we can discuss approach before you invest time coding.

## Setup

```bash
git clone https://github.com/the operatorZ84/clokr.git
cd clokr
pnpm install

# Start infrastructure
docker compose up postgres redis minio -d

# Configure
cp .env.example .env

# Push schema + seed demo data
pnpm --filter @clokr/db exec prisma db push
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

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

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
