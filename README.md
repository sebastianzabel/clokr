# Clokr

**Open-source time tracking & workforce management for small businesses.**

Clokr is a self-hosted web application for tracking working hours, managing leave requests, and handling overtime — built for teams that need a simple but complete solution without a SaaS subscription.

---

## Features

- **Time Tracking** — Clock in/out, manual entries, monthly calendar view, ArbZG compliance checks
- **Leave Management** — Vacation, sick leave, maternity/parental leave, overtime compensation; approval workflow for managers
- **Overtime Account** — Automatic balance tracking with configurable thresholds and payout support
- **Shift Planning** — Weekly grid view, templates, quick-assign mode for admins/managers
- **Employee Management** — Invite-based or direct creation with password, role management, bulk CSV import
- **Reports** — Monthly summaries, leave overview, PDF export, DATEV CSV export
- **Notifications** — In-app notification bell with real-time updates on leave approvals/requests
- **iCal Export** — Personal and team absence calendars for integration with external tools
- **2FA** — Optional email OTP for all users
- **Password Reset** — Self-service via email link
- **Themes** — 4 built-in color themes (Pflaume, Nacht, Wald, Schiefer), switchable per user
- **Timezone Support** — Configurable per tenant, handles DST correctly
- **Self-hosted** — Full Docker Compose deployment, bring your own SMTP

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | SvelteKit + Svelte 5, TypeScript |
| Backend | Fastify 5, TypeScript |
| Database | PostgreSQL 16 + Prisma 7 |
| Cache | Redis 7 |
| Storage | MinIO (S3-compatible) |
| Auth | JWT (Access + Refresh) + optional Email OTP |
| Monorepo | pnpm workspaces |

---

## Deployment (Docker Compose)

This is the recommended way to run Clokr in production.

### 1. Clone

```bash
git clone https://github.com/SebastianZ84/clokr.git
cd clokr
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` — the key variables:

```env
# Database (auto-created by docker compose)
POSTGRES_USER=clokr
POSTGRES_PASSWORD=changeme
POSTGRES_DB=clokr
DATABASE_URL=postgresql://clokr:changeme@postgres:5432/clokr

# Auth
JWT_SECRET=generate-a-random-64-char-string
JWT_REFRESH_SECRET=generate-another-random-64-char-string

# App URL (where users access the frontend)
APP_URL=https://clokr.example.com

# Optional: SMTP for invitations, password reset, 2FA
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=noreply@example.com
```

### 3. Start

```bash
docker compose up -d
```

This starts all services:

| Service | Port | Description |
|---|---|---|
| **web** | 3000 | SvelteKit frontend (proxies API) |
| **api** | 4000 | Fastify backend |
| **postgres** | 5432 | PostgreSQL 16 |
| **redis** | 6379 | Redis 7 |
| **minio** | 9000/9001 | MinIO object storage |

The API container automatically runs `prisma db push` and seeds demo data on first startup.

**Access the app at `http://localhost:3000`.**

### 4. Reverse Proxy (Production)

For production, put a reverse proxy (nginx, Caddy, Traefik) in front of the web container on port 3000:

```nginx
server {
    listen 443 ssl;
    server_name clokr.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 5. Updates

```bash
git pull
docker compose up --build -d
```

The API entrypoint auto-migrates the database on startup.

---

## Local Development

### Prerequisites

- Node.js 22+
- pnpm 9+

### Setup

```bash
pnpm install

# Start infrastructure only
docker compose up postgres redis minio -d

# Copy env and adjust if needed
cp .env.example .env

# Generate Prisma client + push schema
pnpm --filter @clokr/db generate
pnpm --filter @clokr/db db:push

# Seed demo data
pnpm --filter @clokr/db seed

# Start dev servers (hot reload)
pnpm dev
```

- Frontend: http://localhost:5173
- API: http://localhost:4000
- Swagger: http://localhost:4000/docs

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
│   ├── mcp/          # MCP server (Claude Code integration)
│   └── types/        # Shared TypeScript types
├── docker-compose.yml
├── .mcp.json         # MCP server config for Claude Code
└── .env.example
```

---

## Roles

| Role | Permissions |
|---|---|
| `ADMIN` | Full access: employees, system settings, audit log, shifts, imports |
| `MANAGER` | Approve leave, view reports, manage shifts |
| `EMPLOYEE` | Own time entries, leave requests, overtime view |

---

## API

Swagger UI available at `/docs` when the API is running. Key endpoints:

- `POST /api/v1/auth/login` — Login
- `GET /api/v1/dashboard` — Dashboard stats
- `GET/POST /api/v1/time-entries` — Time tracking
- `GET/POST /api/v1/leave/requests` — Leave management
- `GET /api/v1/reports/monthly` — Monthly report
- `GET /api/v1/shifts/week` — Shift planning
- `POST /api/v1/imports/employees` — Bulk CSV import

---

## MCP Server (Claude Code)

Clokr includes an MCP server for Claude Code integration. After `pnpm install`, it auto-registers via `.mcp.json`. Available tools:

`login`, `dashboard`, `list_employees`, `list_time_entries`, `clock_in`, `clock_out`, `list_shifts`, `list_leave_requests`, `monthly_report`, `overtime_account`, `notifications`, `api_request`

---

## Contributing

PRs welcome. Please open an issue first for larger changes.

---

## License

MIT
