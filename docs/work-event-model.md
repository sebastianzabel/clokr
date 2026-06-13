# WorkEvent Model — Architecture

This document is the single source of truth for the WorkEvent system introduced across Phases 77-83 of the v1.9 milestone. It covers the conceptual design, schema contract, adapter API, Saldo conventions, Phase 83 Config Schema (slot resolver + 4-layer override hierarchy), migration strategy (including the BC proxy endpoint removal decision), extensibility pattern, and CI lint guards. Read this document before writing any code that touches Berufsschultag (BS-Tag) data, overtime saldo, or the `/api/v1/work-events/*` endpoint family.

## Concept

Before Phase 77, a Berufsschultag was stored as an `Absence` row with type VOCATIONAL_SCHOOL. This caused two structural bug classes:

1. **Filter-tax proliferation (Phase 76.12):** Because BS-Tage were modeled as absences, saldo computation paths needed scattered `type !== VOCATIONAL_SCHOOL` filters across 5+ files to exclude them from the absence deduction total. Every new consumer had to remember to add this filter — and several didn't, producing silent Saldo drift.

2. **Cross-employee data leak (v1.8.12):** The legacy `/vocational-school/upcoming` endpoint used a single handler with `req.user.role`-based branching to return either the current employee's own BS rows or all employees' BS rows. A logic error in the branch meant any authenticated user could retrieve other employees' BS dates. This is the "role-branched scoping" leak class.

The WorkEvent model solves both problems by separating concerns at the data layer. A BS-Tag is paid working time per BBiG §15 Abs. 1 — it is not an absence from work, it is a form of work. Modeling it as an `Absence` was a category error that leaked into every consumer.

The WorkEvent model uses **Class Table Inheritance**: a single `WorkEvent` row with a typed payload discriminated by the `type` enum field. VOCATIONAL_SCHOOL is the first concrete type. FIELD_SERVICE, BUSINESS_TRIP, TRAINING, and OTHER are reserved enum values established in Phase 77 — adding them later requires only a Zod payload variant (no Prisma migration churn, no new endpoint family).

Decision rationale: `.planning/phases/77-workevent-schema-adapter-foundation/77-01-PLAN.md`.

## Schema

The authoritative schema is `packages/db/prisma/schema.prisma` (model `WorkEvent`). The table below summarizes the conceptual contract.

| Field | Type | Purpose |
|-------|------|---------|
| `id` | `String @id` | UUID primary key |
| `employeeId` | `String` | Tenant isolation via `Employee.tenantId` relation; foreign key with `onDelete: Restrict` |
| `type` | `WorkEventType` (enum) | VOCATIONAL_SCHOOL (initial); FIELD_SERVICE / BUSINESS_TRIP / TRAINING / OTHER reserved |
| `source` | `WorkEventSource` (enum) | MANUAL (admin/manager created), PATTERN (cron-driven from VocationalSchoolPattern), AUTO (system-generated) |
| `date` | `DateTime @db.Date` | Calendar day this event applies to (UTC date, no time component) |
| `workedMinutes` | `Int` | Always set; resolved at write time — bakes the Phase 63 D-01..D-04 invariant as a row property |
| `expectedMinutes` | `Int?` | NULL for MONTHLY_HOURS schedules (no daily Soll); equal to `workedMinutes` for FIXED_SCHEDULE / SHIFT_BASED / FLEXTIME |
| `payload` | `Json @db.JsonB` | Type-discriminated payload; Zod-validated at the API boundary (`apps/api/src/schemas/work-event-payload.ts`, Phase 77 Plan 03) |
| `note` | `String?` | Free-text annotation (audit-visible, anonymized on DSGVO employee deletion) |
| `legacyAbsenceId` | `String? @unique` | Migration provenance — links back to the original Absence row migrated by Phase 80. Unique so re-running the migration is a no-op for already-migrated rows. |
| `deletedAt` | `DateTime?` | Soft delete (Revisionssicherheit); all queries MUST include `deletedAt: null` |
| `createdBy` | `String?` | User ID of the creator (audit attribution) |
| `createdAt` / `updatedAt` | `DateTime` | Audit timestamps |

Unique constraint: `@@unique([employeeId, date, type])` — one event per type per day per employee. Duplicate inserts produce Prisma P2002, surfaced as HTTP 409.

## Adapter Contract

The canonical read path for all BS-Tag saldo computation is:

```typescript
import { loadWorkEventsForRange } from "../utils/work-event";
const result = await loadWorkEventsForRange(prisma, employeeId, rangeStart, rangeEnd);
```

Implementation: `apps/api/src/utils/work-event.ts` (line 98).

**Rule:** No consumer code may read the `WorkEvent` or `Absence` (when VOCATIONAL_SCHOOL type) tables directly. All BS-related saldo math goes through the adapter. This includes `prisma.workEvent.findMany` and `prisma.absence.findMany` with VOCATIONAL_SCHOOL type filtering — both are prohibited outside `apps/api/src/utils/work-event*.ts`.

The adapter handles per-tenant routing internally via `TenantConfig.workEventModelLive`:

- `false` (default) → reads `Absence WHERE type = VOCATIONAL_SCHOOL AND deletedAt IS NULL`
- `true` (post-migration) → reads `WorkEvent WHERE type = VOCATIONAL_SCHOOL AND deletedAt IS NULL`

The flag is flipped atomically per tenant by the Phase 80 migration script (see § Migrations). Callers see a single interface regardless of which branch is active.

**Known consumers (Phase 78 refactor):**

| File | Usage |
|------|-------|
| `apps/api/src/routes/time-entries.ts` | Live Saldo computation per time-entry GET |
| `apps/api/src/plugins/auto-close-month.ts` | Monatsabschluss snapshot creation |
| `apps/api/src/utils/recalculate-snapshots.ts` | Ops recompute script |
| `apps/api/src/utils/arbzg.ts` | ArbZG §3 24-week rolling average check |
| `apps/api/src/routes/overtime.ts` | Overtime balance display |

The property-based parity test that pins the adapter contract (legacy vs new path must produce numerically identical results) is at `apps/api/src/__tests__/saldo-drift-check.test.ts` (Phase 78 Plan 03).

## Saldo-Konventionen

Per schedule type, the semantic of the WorkEvent `workedMinutes` / `expectedMinutes` fields:

| Schedule Type | `workedMinutes` | `expectedMinutes` | BBiG rationale |
|--------------|-----------------|-------------------|----------------|
| FIXED_SCHEDULE / FIXED_WEEKLY | Set (slot-resolved) | Equal to `workedMinutes` | BS-Tag counts as a full work day per BBiG §15 Abs. 1; contributes equally to IST and Soll |
| SHIFT_BASED | Set (slot-resolved) | Equal to `workedMinutes` | BS overrides the shift slot; same balanced contribution |
| FLEXTIME | Set (slot-resolved) | Equal to `workedMinutes` | Mirrors FIXED_SCHEDULE for BS-Tag purposes |
| MONTHLY_HOURS | Set (slot-resolved) | `NULL` | No daily Soll in MONTHLY_HOURS contracts; BS contributes to IST only (Phase 63 D-04) |

The Phase 63 D-01..D-04 invariant ("BS-Tag is balanced — adds equally to worked and expected") is now a row property resolved at write time, not a runtime recomputation per call site. The drift check property test (Phase 78 Plan 03) enforces parity numerically between the live `updateOvertimeAccount` path and the snapshot-via-close-month path.

For the specific minutes value credited to a BS-Tag (which slot wins, which override layer applies), see § Config Schema (Phase 83).

## Config Schema (Phase 83)

BS-Tag duration is not a single global constant. It depends on the calendar week (BBiG §15 Abs. 2: a BS day with more than 5 Unterrichtsstunden gilt als voller Arbeitstag; a second such day in the same week darf nicht angerechnet werden), the school schedule (short days, block weeks), and per-employee overrides. Phase 83 introduces a 4-layer override hierarchy resolved by a single pure function — all consumers MUST use the resolver.

### 4-Layer Override Hierarchy (highest to lowest precedence)

| Layer | Source | When it applies | Field names |
|-------|--------|-----------------|-------------|
| 1 | Employee-level override | Specific employee has a non-standard BS slot config (BBIG-V19-03) | `Employee.bsSlotFirstLongDayMinutes`, `bsSlotSecondLongDayMinutes`, `bsSlotShortDayMinutes`, `bsSlotBlockWeekMinutes` |
| 2 | VocationalSchoolPattern | Per-employee cron-driven pattern with school-specific slot durations (BBIG-V19-02) | `VocationalSchoolPattern.bsSlot*Minutes` (same shape as Layer 1) |
| 3 | TenantConfig (tenant default) | All employees of a tenant share the same BS slot durations (BBIG-V19-01) | `TenantConfig.bsSlotFirstLongDayMinutes`, `bsSlotSecondLongDayMinutes`, `bsSlotShortDayMinutes`, `bsSlotBlockWeekMinutes` |
| 4 | Hard-coded fallback | Nothing configured at any higher layer | `480` minutes (8h) — the BBiG §15 Abs. 2 default for a full BS work day |

NULL at any layer means "delegate to the next layer down." The hierarchy also falls back to the legacy `TenantConfig.vocationalSchoolMinutesPerDay` field (backward-compat with Phase 63 Pauschal configs) before reaching the hard-coded 480-minute floor.

### Slot Taxonomy

| Slot Type | Default Minutes | Meaning |
|-----------|-----------------|---------|
| `FIRST_LONG_DAY` | 480 | First BS day of the week with > 5 Unterrichtsstunden — full work day per BBiG §15 Abs. 2 Satz 1 |
| `SECOND_LONG_DAY` | 0 | Second long BS day in the same ISO week — explicitly NOT countable per BBiG §15 Abs. 2 (BVaDiG 2024 conformance); defaults to 0 unless explicitly configured |
| `SHORT_DAY` | 0 | BS day with ≤ 5 Unterrichtsstunden — actual hours credited; defaults to 0 unless tenant/employee configures a value |
| `BLOCK_WEEK` | 2400 | Block week (entire week at Berufsschule) — distributed across all BS days in the ISO week (5 × 480 = 2400 min default) |

### Resolver Entry Point

```typescript
import { resolveBsTagSlot, buildSlotOverrideHierarchy } from "../utils/bs-slot-resolver";

const hierarchy = buildSlotOverrideHierarchy({ employee, pattern, tenantConfig });
const slot = resolveBsTagSlot(date, ordinalInWeek, weekContext, hierarchy, scheduleType);
// → { slotType: "FIRST_LONG_DAY" | "SECOND_LONG_DAY" | "SHORT_DAY" | "BLOCK_WEEK",
//     creditedMinutes: number,
//     contributesToExpected: boolean }
```

Implementation: `apps/api/src/utils/bs-slot-resolver.ts` (Phase 83).

### Rule: Direct bsSlot* Field Reads Are Prohibited

Direct reads of `tenantConfig.bsSlot*`, `employee.bsSlot*`, or `vocationalSchoolPattern.bsSlot*` fields OUTSIDE the resolver are PROHIBITED. The 4-layer precedence is encoded inside `buildSlotOverrideHierarchy()`; bypassing it produces silently wrong Saldo values for employees with overrides.

### CI Lint Guard

`pnpm --filter @clokr/api lint:bs-slot-callers` runs `apps/api/scripts/lint-bs-slot-resolver-callers.mjs`, which fails the build if any file outside the resolver allowlist (currently: `bs-slot-resolver.ts` itself, its test, and the WorkEvent payload Zod schema) reads `bsSlot*` fields directly. See `.planning/phases/83-jarbschg-resolver/83-05-SUMMARY.md` for the Phase 83 allowlist rationale.

## Migrations

The operator playbook for per-tenant migration is at **`docs/work-event-migration-runbook.md`** — do not duplicate its content here.

High-level summary:

- Per-tenant atomic migration via `apps/api/scripts/migrate-bs-to-work-event.ts`. Forward script + inverse rollback ship together.
- The forward script reads all active (non-soft-deleted) `Absence` rows with type VOCATIONAL_SCHOOL for a given tenant, creates corresponding `WorkEvent` rows (copying `workedMinutes` / `expectedMinutes` from the Absence-era saldo logic), and writes `legacyAbsenceId` for provenance.
- `TenantConfig.workEventModelLive` flips atomically to `true` at the end of the forward transaction. From that point on, all adapter calls read from `WorkEvent` instead of `Absence`.
- Audit trail: one summary `AuditLog` row per tenant per migration run (relaxed from per-row for the bulk operation; runtime CRUD on `WorkEvent` remains per-row audited per CLAUDE.md § Audit-Proof).
- Schema migration tooling: `prisma db push` (NOT `prisma migrate dev`) — milestone-stable decision recorded in `.planning/STATE.md` § Decisions.

For rollback procedure, smoke-test queries, and per-tenant operator checklist, see `docs/work-event-migration-runbook.md`.

### BC Proxy Endpoints

The Phase 79 Plan 04 BC proxies at `/api/v1/vocational-school/*` (implemented in `apps/api/src/routes/vocational-school.ts`) translate legacy requests to the new `/api/v1/work-events*` endpoints with a `type=VOCATIONAL_SCHOOL` filter. Every proxy response includes RFC 8594 deprecation signaling:

- `Deprecation: true` header
- `Sunset: Wed, 31 Dec 2026 23:59:59 GMT` header

The BC proxy surface covers the following endpoints:

| Legacy endpoint | Proxy target |
|-----------------|-------------|
| `GET /api/v1/vocational-school/upcoming` | `GET /api/v1/work-events` (tenant-scoped) or `GET /api/v1/work-events/mine` (EMPLOYEE role) |
| `POST /api/v1/vocational-school/manual-insert` | `POST /api/v1/work-events` (WorkEvent path when `workEventModelLive=true`) |
| `DELETE /api/v1/vocational-school/:absenceId` | `WorkEvent` soft-delete (with Absence fall-through for stale IDs during migration grace window) |
| `POST /api/v1/vocational-school/generate` | Pattern generation (stays on Absence path; rewritten by Phase 80 PATTERN engine) |
| `GET /api/v1/vocational-school/preview` | Dry-run generation (same) |

#### Removal Decision — Deferred to v1.10

The BC proxy endpoints are **NOT removed in v1.9**. Removal is deferred to the v1.10 milestone. Rationale:

1. Phase 82 swapped all internal consumer pages (`/shifts`, `/time-entries`, `/team/time-entries`, `/dashboard`) to the `/work-events*` endpoints — no internal Clokr UI depends on the proxy anymore.
2. Phase 84 is a documentation-only milestone close; no endpoint deletion is in scope for this phase.
3. External integrations (third-party tools, customer scripts written against v1.8) may still consume `/vocational-school/*`. Removal requires a proper deprecation cycle: at least one minor version (v1.9 → v1.10) with the `Sunset` header announcing the removal date, plus customer-facing release notes.
4. No internal blocker — the proxies add zero ongoing maintenance cost; they are thin forwarders with internal routing via `TenantConfig.workEventModelLive`.

#### v1.10 Removal Plan (forward-looking, not in scope for Phase 84)

- Delete `apps/api/src/routes/vocational-school.ts` and its integration tests.
- Remove the route registration from `apps/api/src/app.ts`.
- Remove from the OpenAPI/Swagger spec.
- Document removal in v1.10 CHANGELOG with the `Sunset` date that was announced in v1.9 response headers.

This decision is also recorded as a one-liner in `CLAUDE.md` § Work-Event Modell for any future engineer reading the project rules first.

## Extensibility Pattern

How to add a new WorkEvent type (e.g., FIELD_SERVICE, BUSINESS_TRIP, TRAINING, OTHER):

1. **No Prisma migration needed.** The enum value is already reserved in `WorkEventType` — Phase 77 decision to pre-populate all known types up front (see `.planning/phases/77-workevent-schema-adapter-foundation/77-01-PLAN.md`).

2. **Add a payload variant.** Extend the Zod discriminated union in `apps/api/src/schemas/work-event-payload.ts` (Phase 77 Plan 03) with the new `type` discriminant and its specific payload fields.

3. **Decide saldo contribution.** If the new type contributes to saldo (like VOCATIONAL_SCHOOL), extend `loadWorkEventsForRange` in `apps/api/src/utils/work-event.ts` to aggregate it. If the type is logging-only (e.g., OTHER), the adapter ignores it — no change needed.

4. **UI extension.** The type appears wherever existing WorkEvent consumers render BS-Tage. Extend consumer components with type-specific UI (e.g., chip color, icon) as needed.

5. **Pre-existing data migration.** If legacy Absence or other rows represent the new type, write a per-tenant operator script mirroring `apps/api/scripts/migrate-bs-to-work-event.ts`. Follow the same forward + rollback + per-tenant flag pattern.

6. **No new endpoint family needed.** The existing `/api/v1/work-events*` endpoints handle all types. The `?type=` query filter is optional — callers can filter by type or retrieve all event types for an employee.

## CI Lint

Two enforcement scripts ship with v1.9:

### 1. Zero-Hits Vocational School Gate (Phase 78)

**File:** `apps/api/src/__tests__/zero-hits-vocational-school-gate.test.ts`

**Run:** `pnpm --filter @clokr/api test` (runs as part of the standard test suite)

**What it checks:** Fails if the double-quoted string form of the VOCATIONAL_SCHOOL literal appears in `apps/api/src/` outside the canonical allowlist. The allowed sites are:

- `apps/api/src/utils/work-event*.ts` (canonical adapter — comments referencing the literal are allowed)
- `apps/api/src/__tests__/zero-hits-vocational-school-gate.test.ts` (the gate itself — constructs the literal via string concatenation to self-avoid tripping)
- `apps/api/src/__tests__/work-event-type-boundary.test.ts` (Phase 79 Plan 05 — the literal type union is the canonical type contract being asserted via `expectTypeOf`)

**Why:** All call sites must use the enum form (`WorkEventType.VOCATIONAL_SCHOOL` or `AbsenceType.VOCATIONAL_SCHOOL`) so that a future rename or type refactor is caught at compile time. A string literal scattered across route files and utilities is invisible to TypeScript's type checker.

### 2. BS Slot Resolver Callers Lint (Phase 83 Plan 05)

**File:** `apps/api/scripts/lint-bs-slot-resolver-callers.mjs`

**Run:** `pnpm --filter @clokr/api lint:bs-slot-callers`

**What it checks:** Fails if any `.ts` file outside the resolver allowlist reads `bsSlot*` fields directly on `TenantConfig`, `Employee`, or `VocationalSchoolPattern`. The allowlist currently covers only `bs-slot-resolver.ts` itself, its test file, and the WorkEvent payload Zod schema.

**Why:** The 4-layer override hierarchy is encoded inside `buildSlotOverrideHierarchy()`. A consumer that reads `tenantConfig.bsSlotFirstLongDayMinutes` directly bypasses the Employee- and Pattern-level overrides, producing silently wrong Saldo values for employees with override configurations.

**To add a new lint guard for a new WorkEvent type:** mirror the patterns in the two files above. Define an allowlist of canonical sites; reject all others with an actionable error message.

## Schema — Enum Values (Reference)

```
WorkEventType: VOCATIONAL_SCHOOL | FIELD_SERVICE | BUSINESS_TRIP | TRAINING | OTHER
WorkEventSource: MANUAL | PATTERN | AUTO
```

VOCATIONAL_SCHOOL is the only type with full runtime support in v1.9. The remaining types are reserved enum values — adding runtime support for them is a data-only change (no Prisma migration, no new endpoint, no new CI gate). See § Extensibility Pattern.

## Related Documents

- `docs/work-event-migration-runbook.md` — per-tenant migration operator playbook (forward, rollback, smoke tests)
- `docs/datev-export.md` — DATEV LODAS Lohnart mapping + BS-Zeit design decision (Phase 84 Plan 02)
- `CLAUDE.md` § Work-Event Modell — BC proxy v1.10 deprecation note
- `CLAUDE.md` § Saldo Invariant (Work-Event Adapter) — `loadWorkEventsForRange` prohibition + zero-hits enforcer
- `CLAUDE.md` § Endpoint Design Rule — No Role-Branched Scoping — `/mine` vs management split pattern
- `apps/api/src/utils/work-event.ts` — adapter implementation (`loadWorkEventsForRange` entry point at line 98)
- `apps/api/src/utils/bs-slot-resolver.ts` — Phase 83 slot resolver (`resolveBsTagSlot` + `buildSlotOverrideHierarchy`)
- `apps/api/src/routes/work-events.ts` — endpoint family (`/mine` vs management split, canonical example)
- `apps/api/src/routes/vocational-school.ts` — BC proxy endpoints (deferred to v1.10 removal)
- `apps/api/src/__tests__/saldo-drift-check.test.ts` — adapter contract parity test (Phase 78 Plan 03)
- `apps/api/src/__tests__/zero-hits-vocational-school-gate.test.ts` — zero-hits CI gate (Phase 78 Plan 04)
- `.planning/phases/77-workevent-schema-adapter-foundation/77-01-PLAN.md` — original schema + CTI decision
- `.planning/phases/78-saldo-read-path-refactor-drift-check-property-test/78-04-SUMMARY.md` — Saldo refactor + parity test
- `.planning/phases/79-workevent-api-endpoints/79-04-PLAN.md` — BC proxy origin + RFC 8594 Sunset header design
- `.planning/phases/80-operator-migration-per-tenant-flag/80-01-SUMMARY.md` — migration high-level summary
- `.planning/phases/83-jarbschg-resolver/83-05-SUMMARY.md` — slot resolver + lint guard provenance
