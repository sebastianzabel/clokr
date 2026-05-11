---
phase: 25-wifi-presence-stempel-fritzbox
plan: 01
subsystem: database
tags: [prisma, postgresql, schema, wifi-presence, gdpr]

# Dependency graph
requires: []
provides:
  - "TimeEntrySource.WIFI enum value for source attribution"
  - "PresenceSource model — adapter auth keys (clk_ prefix, SHA-256 hash, soft-delete)"
  - "PresenceDevice model — MAC→employee mapping per tenant (unique tenantId+mac)"
  - "Employee.wifiMacs, wifiPresenceEnabled, wifiOptInAt fields"
  - "Employee.presenceDevices relation"
  - "TenantConfig.wifiPresenceWindowMinutes (shift-window gate, default 15 min)"
  - "AuditLog.purgeable flag (DSGVO Art. 5(1)(e) presence-only purge)"
  - "Tenant.presenceSources + presenceDevices relations"
  - "Prisma client regenerated with all new types"
affects:
  - "25-02 (seed data)"
  - "25-03 (webhook handler — uses PresenceDevice, PresenceSource, wifiMacs)"
  - "25-04 (PresenceSource admin CRUD routes)"
  - "25-05 (PresenceDevice admin CRUD routes)"
  - "25-06 (admin WiFi-Presence UI)"
  - "25-07 (employee profile — wifiPresenceEnabled opt-in + Meine Geräte)"
  - "25-08 (data-retention cron — purgeable AuditLog cleanup)"
  - "25-09 (FritzBox adapter)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PresenceSource mirrors TerminalApiKey pattern: keyHash (SHA-256), keyPrefix (display), soft-delete, isActive flag"
    - "PresenceDevice uses @@unique([tenantId, mac]) for one-MAC-per-tenant-per-employee enforcement"
    - "purgeable Boolean on AuditLog enables DSGVO Art. 5(1)(e) short-retention events without touching retention-relevant records"

key-files:
  created: []
  modified:
    - "packages/db/prisma/schema.prisma"

key-decisions:
  - "PresenceSource uses deletedAt soft-delete (audit-proof) instead of hard deletes, consistent with CLAUDE.md"
  - "PresenceDevice uses onDelete: Cascade to Employee (device mapping has no independent meaning without the employee)"
  - "Employee.wifiMacs (String[]) coexists with PresenceDevice — wifiMacs for self-service profile entries, PresenceDevice for admin-managed mappings; webhook handler checks PresenceDevice first"
  - "AuditLog.purgeable = false default; only set true for presence-only audit events (no stamp created) in Plan 25-03 webhook handler"
  - "wifiPresenceEnabled = false default enforces GDPR opt-in — no WiFi tracking until employee explicitly consents"

patterns-established:
  - "WiFi-presence auth key pattern: clk_ prefix, SHA-256 stored, keyPrefix for UI display — same as TerminalApiKey"

requirements-completed: [WIFI-01, WIFI-02, WIFI-04]

# Metrics
duration: 3min
completed: 2026-05-11
---

# Phase 25 Plan 01: Schema Foundation Summary

**Prisma schema extended with PresenceSource (adapter auth keys), PresenceDevice (MAC→employee mapping), Employee WiFi opt-in fields, AuditLog.purgeable, and TimeEntrySource.WIFI — all pushed to DB and regenerated into client**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-11T18:56:15Z
- **Completed:** 2026-05-11T18:59:18Z
- **Tasks:** 3
- **Files modified:** 1 (schema.prisma)

## Accomplishments
- Added `WIFI` to `TimeEntrySource` enum (alongside NFC, MOBILE, MANUAL, CORRECTION)
- Added `PresenceSource` model (12 fields, soft-delete, isActive, adapterUrl, keyHash/keyPrefix, onDelete: Cascade to Tenant)
- Added `PresenceDevice` model (8 fields, unique(tenantId, mac), onDelete: Cascade to both Tenant and Employee)
- Added Employee wifi fields: `wifiMacs String[]`, `wifiPresenceEnabled Boolean`, `wifiOptInAt DateTime?`, `presenceDevices PresenceDevice[]`
- Added `TenantConfig.wifiPresenceWindowMinutes Int @default(15)` for shift-window gate
- Added `AuditLog.purgeable Boolean @default(false)` for DSGVO Art. 5(1)(e) short-retention presence events
- Added `Tenant.presenceSources` and `Tenant.presenceDevices` relations
- `prisma db push` applied all DDL changes to running PostgreSQL (116ms)
- `prisma generate` regenerated client with 1450+ references to new types

## Task Commits

Each task was committed atomically:

1. **Task 1: Enum + Employee wifi fields + TenantConfig + AuditLog** - `e856bfc` (feat)
2. **Task 2: PresenceSource + PresenceDevice models + Tenant relations** - `65d38bf` (feat)
3. **Task 3: Validate + db push + generate** - no commit needed (generated client is gitignored; DB changes are operational)

## Files Created/Modified
- `packages/db/prisma/schema.prisma` - All WiFi-presence schema additions

## Decisions Made
- PresenceSource uses soft-delete (`deletedAt`) consistent with CLAUDE.md audit-proof rules — never hard-delete
- PresenceDevice `onDelete: Cascade` to Employee (device mappings are meaningless without the employee; not audit-relevant data)
- `Employee.wifiMacs String[]` coexists with `PresenceDevice` — wifiMacs for self-service profile entries, PresenceDevice for admin-managed; webhook handler uses PresenceDevice-first lookup
- `AuditLog.purgeable` flag enables GDPR-compliant short-retention (90 days) for presence-only audit events without touching the longer-retention compliance records
- `wifiPresenceEnabled = false` default enforces explicit GDPR opt-in before any WiFi tracking occurs

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None — this is a schema-only plan. No UI or API code was written.

## Threat Flags

None — no new network endpoints, auth paths, or file access patterns introduced. Schema additions follow established patterns (keyHash never stored plaintext, soft-delete enforced, addedByUserId tracks auditability per T-25-01-04).

## Next Phase Readiness

- All Prisma types for WiFi-presence are now available in `@clokr/db`
- Plan 25-02 (seed data) can proceed — `PresenceSource`, `PresenceDevice` models exist
- Plan 25-03 (webhook handler) can proceed — `PresenceDevice.mac`, `Employee.wifiMacs`, `TimeEntrySource.WIFI` all generated
- Plan 25-04 (PresenceSource admin CRUD) can proceed — model exists with all required fields

## Self-Check: PASSED

- `packages/db/prisma/schema.prisma` — exists and contains all new models/fields
- Commit `e856bfc` — found in git log (Task 1)
- Commit `65d38bf` — found in git log (Task 2)
- `prisma validate` — exits 0
- `prisma db push` — exits 0 (116ms sync)
- `prisma generate` — exits 0
- `grep -c` on generated client — 1450 matches

---
*Phase: 25-wifi-presence-stempel-fritzbox*
*Completed: 2026-05-11*
