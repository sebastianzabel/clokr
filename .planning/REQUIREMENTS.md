# Requirements: Clokr — Production Readiness

**Defined:** 2026-03-30
**Core Value:** Reliable, secure, and legally compliant enough to go live with real customers

## v1 Requirements

Requirements for production launch. Each maps to roadmap phases.

### Test Infrastructure

- [ ] **TEST-01**: Isolated test database via `TEST_DATABASE_URL` (no shared dev DB)
- [x] **TEST-02**: Playwright `storageState` setup project (auth once, reuse across E2E specs)
- [ ] **TEST-03**: Vitest coverage thresholds enforced (baseline measurement first)
- [ ] **TEST-04**: ESLint `no-floating-promises` rule enabled and blocking

### API Test Coverage

- [ ] **API-01**: Time entry CRUD tests (create, edit, soft-delete, locked-month rejection, duplicate-day 409)
- [ ] **API-02**: Leave request lifecycle tests (request, approve, reject, cancel, cancellation-approve, cross-year booking)
- [ ] **API-03**: Overtime saldo and Monatsabschluss tests (saldo read, month-close trigger, locked-month immutability)
- [ ] **API-04**: Auth flow tests (login, refresh, JWT expiry, role gates ADMIN/MANAGER/EMPLOYEE)
- [ ] **API-05**: DSGVO anonymization tests (no hard delete, all fields anonymized, audit event written)
- [ ] **API-06**: NFC terminal punch tests (punch endpoint, lastUsedAt update, API key scoping)

### Compliance & Security

- [ ] **SEC-01**: ArbZG compliance unit tests (§3 daily max 10h, §3 24-week average, §4 breaks, §5 rest period, cross-midnight shifts)
- [ ] **SEC-02**: Tenant isolation tests (cross-tenant reads/writes blocked on all resources)
- [ ] **SEC-03**: Audit trail completeness tests (every mutating endpoint writes AuditLog with required fields)
- [ ] **SEC-04**: Soft delete enforcement tests (DELETE sets deletedAt, queries filter deletedAt:null, locked-month entries undeletable)
- [ ] **SEC-05**: Timezone/date boundary tests (DST transitions, Dec 31→Jan 1, leap year, month-close at midnight CET vs UTC)

### Code Audit

- [ ] **AUDIT-01**: Eliminate all silent `.catch(() => {})` patterns (replace with `app.log.error`)
- [ ] **AUDIT-02**: Google Fonts lokal hosten (DSGVO Art. 44 — kein externer Request an Google) (GitHub #100)
- [ ] **AUDIT-03**: Docker seed script fix (pnpm@10 + Prisma 7 compatibility) (GitHub #119)

### E2E Tests

- [ ] **E2E-01**: Login → Dashboard → Clock in/out flow
- [ ] **E2E-02**: Time entry create/edit/delete flow
- [ ] **E2E-03**: Leave request → approval → calendar display flow
- [ ] **E2E-04**: Admin employee management flow
- [ ] **E2E-05**: Monatsabschluss lock/unlock flow (manager)

### UI Quality

- [ ] **UI-01**: Mobile-responsive across all views (no horizontal scroll on 390px, 44px touch targets)
- [ ] **UI-02**: Consistent error feedback (German-language error messages, retry prompts, locked-month messages)
- [ ] **UI-03**: Design consistency audit (spacing, colors, loading skeletons, form components)
- [ ] **UI-04**: UX flow improvements (navigation, fewer clicks, clearer feedback patterns)
- [ ] **UI-05**: Password policy admin UI (TenantConfig fields exist but no UI)

## v2 Requirements

Deferred to future milestones. Tracked but not in current roadmap.

### Performance

- **PERF-01**: Saldo snapshot architecture (Issue #6) — replace hire-date recalculation
- **PERF-02**: Parallel test execution (requires isolated test DB + fileParallelism: true)

### Infrastructure

- **INFRA-01**: CI/CD pipeline with test/lint/build gates
- **INFRA-02**: Error tracking integration (Sentry)
- **INFRA-03**: Node.js base image update for corepack compatibility (GitHub #75)

### Features

- **FEAT-01**: Dashboard widget drag & drop (GitHub #118)
- **FEAT-02**: Onboarding wizard for new tenants (GitHub #96)
- **FEAT-03**: Excel export (GitHub #94)
- **FEAT-04**: Multi-tenant registration UI (GitHub #88)
- **FEAT-05**: i18n / Mehrsprachigkeit (GitHub #27)
- **FEAT-06**: Dark mode auto-detect (GitHub #98)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature                         | Reason                                                     |
| ------------------------------- | ---------------------------------------------------------- |
| New features                    | Feature-complete for v1 — quality milestone only           |
| Saldo snapshot migration (#6)   | Separate perf milestone, risky during hardening            |
| i18n                            | German-only for v1, no customer demand for other languages |
| CI/CD pipeline                  | Infrastructure concern, not app quality                    |
| DATEV integration               | Separate integration project requiring API access          |
| GPS/location tracking           | DSGVO complications, not target segment                    |
| Admin Vacation page tabs (#107) | UI enhancement deferred to post-launch                     |
| Profile avatar UX (#105)        | UI enhancement deferred to post-launch                     |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| TEST-01     | Phase 1 | Pending |
| TEST-02     | Phase 1 | Complete |
| TEST-03     | Phase 1 | Pending |
| TEST-04     | Phase 1 | Pending |
| AUDIT-01    | Phase 1 | Pending |
| AUDIT-03    | Phase 1 | Pending |
| API-01      | Phase 2 | Pending |
| API-02      | Phase 2 | Pending |
| API-03      | Phase 2 | Pending |
| API-04      | Phase 2 | Pending |
| API-05      | Phase 2 | Pending |
| API-06      | Phase 2 | Pending |
| SEC-01      | Phase 2 | Pending |
| SEC-02      | Phase 2 | Pending |
| SEC-03      | Phase 2 | Pending |
| SEC-04      | Phase 2 | Pending |
| SEC-05      | Phase 2 | Pending |
| AUDIT-02    | Phase 2 | Pending |
| E2E-01      | Phase 3 | Pending |
| E2E-02      | Phase 3 | Pending |
| E2E-03      | Phase 3 | Pending |
| E2E-04      | Phase 3 | Pending |
| E2E-05      | Phase 3 | Pending |
| UI-01       | Phase 3 | Pending |
| UI-02       | Phase 3 | Pending |
| UI-03       | Phase 3 | Pending |
| UI-04       | Phase 3 | Pending |
| UI-05       | Phase 3 | Pending |

**Coverage:**

- v1 requirements: 28 total
- Mapped to phases: 28
- Unmapped: 0

---

_Requirements defined: 2026-03-30_
_Last updated: 2026-03-30 after roadmap creation_
