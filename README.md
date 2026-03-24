# Clokr

**Open-source time tracking & workforce management for small businesses.**

Clokr is a self-hosted web application for tracking working hours, managing leave requests, and handling overtime — built specifically for teams like hair salons, boutiques, and service businesses that need a simple but complete solution without a SaaS subscription.

---

## Features

- **Time Tracking** — Clock in/out, manual entries, monthly calendar view, ArbZG compliance checks
- **Leave Management** — Vacation, sick leave, overtime compensation and more; approval workflow for managers
- **Overtime Account** — Automatic balance tracking with configurable thresholds and payout support
- **Employee Management** — Invite-based onboarding (no password set by admin), role management, GDPR-compliant deletion
- **Reports** — Monthly summaries, leave overview, DATEV export
- **2FA** — Optional email OTP for all users
- **Themes** — 4 built-in color themes (Pflaume, Nacht, Wald, Schiefer), switchable per user
- **Self-hosted** — Docker Compose setup, bring your own SMTP

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | SvelteKit + Svelte 5, TypeScript |
| Backend | Fastify 5, TypeScript |
| Database | PostgreSQL + Prisma 7 |
| Auth | JWT (Access + Refresh) + optional Email OTP |
| Monorepo | pnpm workspaces + Turborepo |

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL 15+ (or Docker)

### 1. Clone & Install

```bash
git clone https://github.com/the operatorZ84/clokr.git
cd clokr
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your database URL and JWT secrets
```

Key variables:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/clokr
JWT_SECRET=your-secret-here
JWT_REFRESH_SECRET=your-refresh-secret-here
APP_URL=http://localhost:5173

# Optional SMTP (for invitations + 2FA)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
```

### 3. Database Setup

```bash
pnpm db:migrate    # Run migrations
pnpm --filter @clokr/db seed  # Seed demo data (optional)
```

### 4. Run

```bash
pnpm dev
```

- Frontend: http://localhost:5174
- API: http://localhost:4000
- Swagger UI: http://localhost:4000/docs

### Docker Compose

```bash
docker compose up -d
```

---

## Demo Credentials

After seeding:

| Role | Email | Password |
|---|---|---|
| Admin | admin@clokr.de | admin1234 |
| Employee | max@clokr.de | admin1234 |

---

## Project Structure

```
clokr/
├── apps/
│   ├── api/          # Fastify backend
│   └── web/          # SvelteKit frontend
├── packages/
│   ├── db/           # Prisma schema + client
│   └── types/        # Shared TypeScript types
└── docker-compose.yml
```

---

## Roles

| Role | Permissions |
|---|---|
| `ADMIN` | Full access incl. employee management, system settings |
| `MANAGER` | Approve leave requests, view all reports |
| `EMPLOYEE` | Own time entries, leave requests, overtime view |

---

## Roadmap

- [ ] NFC card support (API ready, frontend pending)
- [ ] Password reset flow
- [ ] PWA / mobile app
- [ ] Multi-tenant support (data model ready)
- [ ] Shift planning

---

## Contributing

PRs welcome. Please open an issue first for larger changes.

---

## License

MIT
