<p align="center">
  <img src="images/clokr-logo.png" alt="Clokr" width="200" />
</p>

<p align="center"><strong>Open-source time tracking & leave management for small businesses.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/stack-SvelteKit%20%2B%20Fastify%20%2B%20PostgreSQL-blueviolet" alt="Stack" />
  <img src="https://img.shields.io/badge/docker-compose%20ready-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/compliant-ArbZG%20%7C%20BUrlG%20%7C%20DSGVO-green" alt="Compliance" />
  <a href="https://github.com/SebastianZ84/clokr/releases"><img src="https://img.shields.io/github/v/release/SebastianZ84/clokr" alt="Latest Release" /></a>
</p>

---

Clokr is a self-hosted web application for tracking working hours, managing leave requests, and handling overtime. Built for German-speaking teams that need a complete, legally compliant solution without a SaaS subscription.

## Why Clokr?

- **Self-hosted** — your data stays on your server. No vendor lock-in, no monthly fees.
- **Legally compliant** — built specifically for German labor law: ArbZG daily limits, BUrlG vacation rules, DSGVO-compliant employee deletion, 10-year data retention (§ 147 AO)
- **Audit-proof** — soft deletes, full audit trail (who/when/what), locked months are immutable
- **Complete** — time tracking, leave management, overtime account, shift planning, reports, DATEV export — everything in one place

## Screenshots

| Dashboard | Time Entries |
|-----------|-------------|
| ![Dashboard](audit-01-dashboard.png) | ![Time Entries](audit-03-time-entries.png) |

| Leave Calendar | Reports |
|---------------|---------|
| ![Leave](audit-05-leave.png) | ![Reports](audit-07-reports.png) |

| Employee Management | Admin Settings |
|--------------------|-|
| ![Employees](audit-08-employees.png) | ![Settings](audit-09-settings.png) |

---

## Quick Start

```bash
# 1. Download compose file and env template
curl -fsSLO https://raw.githubusercontent.com/SebastianZ84/clokr/main/docker-compose.prod.yml
curl -fsSLO https://raw.githubusercontent.com/SebastianZ84/clokr/main/.env.example
cp .env.example .env

# 2. Generate secrets and edit .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste output into JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY in .env

# 3. Start
docker compose -f docker-compose.prod.yml up -d
```

Open **http://localhost:3000** — first start seeds a demo admin account.

**Demo credentials:**

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@clokr.de | admin1234 |
| Employee | max@clokr.de | mitarbeiter5678 |

### Updates

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### Pin a version

Set `CLOKR_VERSION=1.0.0` in `.env` to pin to a specific release.

---

## Features

- **Time Tracking** — Clock in/out, manual entries, monthly calendar view, one entry per day with multiple breaks, ArbZG compliance checks (§ 3, § 4, § 5)
- **Leave Management** — Vacation, sick leave, maternity/parental leave, overtime compensation; approval workflow with cancellation flow; BUrlG carry-over rules
- **Overtime Account** — Balance tracking with monthly closing (Monatsabschluss), yearly carry-over (FULL/CAPPED/RESET), payout support
- **Monatsabschluss** — Automatic monthly closing, completeness check, manager notifications for missing entries
- **Shift Planning** — Weekly grid view, templates, quick-assign mode
- **Employee Management** — Invite-based onboarding, role management, bulk CSV import, DSGVO-compliant anonymization on deletion
- **Reports** — Monthly summaries, leave overview, PDF export, DATEV CSV export
- **Audit-Proof** — Soft delete, full audit trail, isLocked enforcement, configurable data retention (default 10 years)
- **Notifications** — In-app bell with real-time updates on leave approvals and close reminders
- **iCal Export** — Personal and team absence calendars
- **2FA** — Optional email OTP
- **Themes** — 4 built-in color themes (Pflaume, Nacht, Wald, Schiefer)
- **NFC Terminal** — Desktop client for NFC card-based clock-in/out (Tauri, macOS/Windows)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | SvelteKit + Svelte 5, TypeScript |
| Backend | Fastify 5, TypeScript |
| Database | PostgreSQL 18 + Prisma 7 |
| Cache | Redis 7 |
| Storage | MinIO (S3-compatible) |
| Auth | JWT (Access + Refresh) + optional Email OTP |
| Monorepo | pnpm workspaces |

---

## Roles

| Role | Permissions |
|------|-------------|
| `ADMIN` | Full access: employees, system settings, audit log, shifts, imports |
| `MANAGER` | Approve leave, view reports, manage shifts |
| `EMPLOYEE` | Own time entries, leave requests, overtime view |

---

## Deployment from Source

### 1. Clone

```bash
git clone https://github.com/SebastianZ84/clokr.git
cd clokr
```

### 2. Configure

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY
```

### 3. Start

```bash
docker compose up --build -d
```

| Service | Port | Description |
|---------|------|-------------|
| **web** | 3000 | SvelteKit frontend |
| **api** | 4000 | Fastify backend |
| **postgres** | 5432 | PostgreSQL 18 |
| **redis** | 6379 | Redis 7 |
| **minio** | 9000/9001 | MinIO object storage |

The API auto-migrates the database on startup.

---

## Local Development

**Prerequisites:** Node.js 24+, pnpm 10+, Docker

```bash
pnpm install

# Start infrastructure
docker compose up postgres redis minio -d

cp .env.example .env

pnpm --filter @clokr/db exec prisma db push
pnpm --filter @clokr/db seed

pnpm dev
```

- Frontend: http://localhost:5173
- API: http://localhost:4000
- Swagger: http://localhost:4000/docs

---

## Project Structure

```
clokr/
├── apps/
│   ├── api/          # Fastify backend
│   ├── web/          # SvelteKit frontend
│   ├── e2e/          # Playwright tests
│   └── nfc-client/   # Tauri NFC terminal client
├── packages/
│   ├── db/           # Prisma schema + client
│   └── types/        # Shared TypeScript types
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env.example
```

---

## API

Swagger UI at `/docs` when the API is running. Key endpoints:

- `POST /api/v1/auth/login`
- `GET /api/v1/dashboard`
- `GET/POST /api/v1/time-entries`
- `GET/POST /api/v1/leave/requests`
- `GET /api/v1/reports/monthly`
- `GET /api/v1/reports/datev`

---

## NFC Desktop Client

For NFC-based time tracking with a USB smart card reader:

Download the latest client from the [Releases page](https://github.com/SebastianZ84/clokr/releases):

- **macOS**: `clokr-nfc-*.dmg`
- **Windows**: `clokr-nfc-*.msi`

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

---

## License

[MIT](LICENSE)
