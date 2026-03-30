# External Integrations

**Analysis Date:** 2026-03-30

## APIs & External Services

**Phorest Integration (Beauty Salon Software):**

- Service: Phorest API for staff & work schedules
  - SDK/Client: Native `fetch()` with Basic Auth
  - Auth: `global/{email}:{password}` (Base64 in Authorization header)
  - Implementation: `apps/api/src/routes/integrations.ts`
  - Endpoints:
    - `GET /api/business/{bid}/branch/{brid}/staff` - Staff list
    - `GET /api/business/{bid}/branch/{brid}/staffworktimetables` - Work schedules
    - `GET /api/business/{bid}/branch/{brid}/appointment` - Appointments
  - Configuration in DB: `TenantConfig.phorestBusinessId`, `phorestBranchId`, `phorestUsername`, `phorestPassword`, `phorestBaseUrl`
  - Auto-sync: Configurable cron job (`phorestSyncCron`, default "0 3 \* \* \*")
  - Sync endpoint: `POST /phorest/sync` (admin-only)

## Data Storage

**Databases:**

- PostgreSQL 18
  - Connection: `DATABASE_URL` environment variable
  - Client: Prisma ORM
  - Schema: `packages/db/prisma/schema.prisma`
  - Features:
    - Multi-tenant support (Tenant model)
    - Soft deletes (deletedAt fields on TimeEntry, LeaveRequest, Absence)
    - Audit logging (AuditLog table)
    - JSONB support for oldValue/newValue in AuditLog
  - Adapter: @prisma/adapter-pg for connection pooling

**File Storage:**

- MinIO (S3-compatible object storage)
  - Endpoint: `minio` service (default localhost:9000)
  - Bucket: `clokr` (auto-created on startup)
  - Auth: `minioadmin`/`minioadmin` (docker-compose defaults)
  - SDK/Client: minio 8.0.7
  - Paths (stored in DB):
    - Avatars: `avatars/{tenantId}/{employeeId}.webp`
    - Absence documents (AU): `absences/{tenantId}/{absenceId}/{filename}`
  - Implementation: `apps/api/src/plugins/storage.ts`
  - Operations: upload, download (getBuffer), delete

**Caching:**

- Redis 7-alpine (configured via `REDIS_URL` but currently unused)
  - Default: `redis://localhost:6379`
  - Prepared for future session/rate-limit caching

## Authentication & Identity

**Auth Provider:**

- Custom JWT-based system
  - Implementation: `apps/api/src/routes/auth.ts` and `@fastify/jwt`
  - Access token: 15 minutes (configurable)
  - Refresh token: 7 days (configurable)
  - Secrets: `JWT_SECRET`, `JWT_REFRESH_SECRET` (min 32 chars required)
  - Payload: `sub` (userId), `tenantId`, `role`

**Password Security:**

- bcryptjs 3.0.3 for hashing
- Configurable per-tenant policy (`TenantConfig`):
  - `passwordMinLength` (default 12)
  - `passwordRequireUpper`, `passwordRequireLower`, `passwordRequireDigit`, `passwordRequireSpecial`

**Two-Factor Auth:**

- OTP via email
  - Implementation: `apps/api/src/routes/auth.ts`
  - OTP model: `OtpToken` (6-digit code, bcrypt-hashed)
  - Validity: 10 minutes
  - Can be enabled globally per-tenant: `TenantConfig.twoFaEnabled`

**Account Lockout:**

- Failed login tracking in `User` table
- `failedLoginAttempts`, `lockedUntil`, `lastFailedLoginAt`
- Configurable: `TenantConfig.loginMaxAttempts` (default 5), `TenantConfig.loginLockoutMinutes` (default 15)

**Session Management:**

- RefreshToken model for token revocation tracking
- Session timeout: `TenantConfig.sessionTimeoutMinutes` (default 60, 0 = disabled)
- Max simultaneous sessions: `TenantConfig.maxSessionsPerUser` (default 0 = unlimited)
- Remember me: `TenantConfig.rememberMeEnabled`, `rememberMeDays` (default 30)

**API Keys:**

- ApiKey model for programmatic access
  - Scopes: read/write for employees, time-entries, reports, leave, etc.
  - Key format: `clk_` prefix + hashed secret
  - Expiry: Optional per-key
  - Implementation: `apps/api/src/routes/api-keys.ts`

**NFC Terminal Keys:**

- TerminalApiKey model for NFC clock punch
  - Hashed keys for security
  - Tied to tenant
  - Implementation: `apps/api/src/routes/terminals.ts`

## Monitoring & Observability

**Error Tracking:**

- Not detected - errors logged to stdout/files

**Logs:**

- Pino JSON logging framework
- Formats: json (default), ecs (Elastic Common Schema), pretty (dev)
- Rotation: pino-roll for daily log files (configurable path)
- Log levels: trace, debug, info (default), warn, error, fatal
- Context enrichment: userId, tenantId, role injected into all request logs
- Implementation: `apps/api/src/app.ts` (loggerConfig)

## CI/CD & Deployment

**Hosting:**

- Docker containers (multi-stage builds)
- Docker Compose for local development (5 services: PostgreSQL, Redis, MinIO, API, Web)

**CI Pipeline:**

- GitHub Actions:
  - `ci.yml` - Test/lint on PR
  - `build-push.yml` - Build & push images to registry
  - `release.yml` - Release automation
  - `dependabot-auto-approve.yml` - Security patch auto-approval
  - `cleanup-images.yml` - Cleanup old container images

**Security Scanning:**

- Trivy vulnerability scanning in build pipeline
- CVE exceptions documented in `.trivyignore`
- Transitive dependency fixes via `pnpm.overrides` in root `package.json`

## Environment Configuration

**Required env vars (critical):**

- `DATABASE_URL` - PostgreSQL connection
- `JWT_SECRET` - Access token secret (≥32 chars)
- `JWT_REFRESH_SECRET` - Refresh token secret (≥32 chars)
- `ENCRYPTION_KEY` - Field encryption (≥32 chars)

**Optional but recommended:**

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` - Email config
- `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` - S3 object storage
- `LOG_FILE` - Log file output path

**Per-Tenant Configuration (Database):**

- SMTP settings (overrides env vars if set)
- Phorest integration credentials
- Password policy
- Leave/overtime rules
- Email notification preferences
- Session timeouts
- Data retention period

**Secrets location:**

- Environment variables (Docker secrets or `.env` file in dev)
- Encrypted in DB: SMTP passwords, Phorest passwords, API key secrets
- Encryption: `ENCRYPTION_KEY` environment variable
- Implementation: `apps/api/src/utils/crypto.ts`

## Webhooks & Callbacks

**Incoming:**

- NFC terminal webhooks: Conceptual, keyed by TerminalApiKey
- No external webhook handlers currently documented

**Outgoing:**

- Email notifications (via Nodemailer/SMTP):
  - Leave request notifications
  - Leave decision notifications
  - OTP codes
  - Password reset links
  - Invitation links
  - Monthly close notifications
  - Implementation: `apps/api/src/plugins/mailer.ts`

## Scheduled Tasks

**Cron Jobs (node-cron):**

- Phorest sync: Default "0 3 \* \* \*" (3 AM daily), configurable per tenant
- Monthly close: Auto-closes months and generates saldo snapshots
- Data retention: Deletes/anonymizes data per DSGVO rules (10-year default)
- Attendance checker: Validates clock-in/out rules
- Implementation: `apps/api/src/plugins/scheduler.ts`

## Integration Points in Codebase

**API Routes:**

- `apps/api/src/routes/integrations.ts` - Phorest config & sync
- `apps/api/src/routes/avatars.ts` - Avatar upload/download (MinIO)
- `apps/api/src/routes/api-keys.ts` - Programmatic API access
- `apps/api/src/routes/terminals.ts` - NFC terminal setup

**Plugins:**

- `apps/api/src/plugins/prisma.ts` - Database connection
- `apps/api/src/plugins/storage.ts` - MinIO client
- `apps/api/src/plugins/mailer.ts` - Email sending
- `apps/api/src/plugins/scheduler.ts` - Cron jobs

---

_Integration audit: 2026-03-30_
