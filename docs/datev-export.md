# DATEV LODAS Export — Lohnart Mapping & Design Decisions

This document is the source-of-truth for how Clokr produces DATEV LODAS payroll
exports. It complements:

- `apps/api/src/routes/reports.ts` (the `buildDatevLodas()` implementation)
- `apps/api/src/__tests__/datev-snapshot.test.ts` (the byte-equivalence contract)
- `docs/work-event-migration-runbook.md` (operator playbook for the Phase 80
  `WorkEvent` migration)

## Lohnartennummern

Four Lohnarten are configurable per tenant via `TenantConfig`. Six more are
hardcoded in `buildDatevLodas()` and shared across all tenants.

| Lohnart | Default Name | Source | Field / Path |
|---------|-------------|--------|--------------|
| 100 | Normalstunden | configurable | `TenantConfig.datevNormalstundenNr` |
| 200 | Krankheit (AU) | configurable | `TenantConfig.datevKrankNr` |
| 300 | Urlaub | configurable | `TenantConfig.datevUrlaubNr` |
| 302 | Sonderurlaub | configurable | `TenantConfig.datevSonderurlaubNr` |
| 201 | Krankheit Kind | hardcoded | `buildDatevLodas` literal |
| 301 | Überstundenausgleich | hardcoded | `buildDatevLodas` literal |
| 303 | Bildungsurlaub | hardcoded | `buildDatevLodas` literal |
| 304 | Unbezahlter Urlaub | hardcoded | `buildDatevLodas` literal |
| 310 | Mutterschutz | hardcoded | `buildDatevLodas` literal |
| 320 | Elternzeit | hardcoded | `buildDatevLodas` literal |

To change a configurable Lohnart, update `TenantConfig.datev*Nr` directly in
the DB or via the admin settings UI. Changes take effect on the next export for
that tenant — no code deployment required.

## Data Sources

`buildDatevLodas()` consumes the following per-employee data for the export
month (UTC, tenant-timezone-anchored date range):

| Source | Filter | Drives Lohnart |
|--------|--------|----------------|
| `Employee.timeEntries` | `type=WORK`, `deletedAt: null`, `endTime != null`, `isInvalid: false` | 100 (Normalstunden) — summed minutes |
| `Employee.absences` | `deletedAt: null`, overlapping month | 200 (AU) for `type=SICK`; 201 for `SICK_CHILD` |
| `Employee.leaveRequests` | `status=APPROVED`, overlapping month | 300/302/303/304/310/320 by `LeaveType.name` |

`WorkEvent` is **NOT** joined into the DATEV employee include shape. This is the
deliberate design documented in the section below.

## Berufsschulzeit (BBiG §15) — Design Decision

**Behavior**: Berufsschulzeit (BS-Tag) hours stored in
`WorkEvent(type=VOCATIONAL_SCHOOL).workedMinutes` are **NOT** currently
exported in the DATEV LODAS file. They appear neither as a separate Lohnart
nor folded into Normalstunden (Lohnart 100).

**Why this is the default**:

1. BBiG §15 Abs. 1 states "Die Berufsschulzeit ist auf die Arbeitszeit
   anzurechnen" — BS-Zeit counts as paid working time for the apprentice.
   Internally (Saldo, Überstunden, ArbZG checks) Clokr already treats it as
   such via the WorkEvent adapter (`apps/api/src/utils/work-event.ts`).

2. **DATEV-side**: The payroll question "should BS hours appear as their own
   Lohnart, fold into Normalstunden, or not appear at all?" is a Lohnbuchhalter
   decision per tenant. The legally safe default is **not to export them as a
   separate line item**, because:
   - The apprentice's monthly Lohn is contractually fixed; hourly accounting
     is informational, not a payroll driver.
   - Pre-Phase-77 (Absence-based BS-Tag), the export also did not emit a BS
     Lohnart line — the filter at `reports.ts` only matched `SICK` and
     `SICK_CHILD` from the `absences` relation. The current behavior preserves
     that production-verified baseline.

**Why no fold-into-100**: Folding BS hours into Lohnart 100 would change the
"Normalstunden" total in every Azubi's monthly payroll feed. That is a
payroll-relevant byte change. Production tenants signed off on the current
feed; silently adding BS hours into Normalstunden would corrupt their
Lohnabrechnung. The byte-equivalence snapshot
(`apps/api/src/__tests__/datev-snapshot.test.ts`) enforces this contract and
will fail if any such change is introduced.

**Worked example** (from the snapshot baseline):

Scenario: Azubi `AZ-001`, FIXED_SCHEDULE 40h Mo-Fr, May 2026, 2 BS-Tage
(2026-05-04 + 2026-05-11), 8 TimeEntries on Tue-Fri of weeks 2+3 (8h each).

Resulting DATEV row:

```
AZ-001;Z. A.;31052026;;100;64,00;;;;;;
```

64 hours = 8 TimeEntries × 8h. The 2 BS-Tage contribute zero hours to this
line. (Verified — see `apps/api/src/__tests__/__snapshots__/datev-snapshot.test.ts.snap`.)

## Open: Per-Tenant Override (Lohnbuchhalter Consultation)

Some Lohnbuchhalter (per CONTEXT.md, e.g., Anjas Lohnbuchhalter) may require
that BS hours appear in DATEV LODAS as either:

- **Option A**: a dedicated Lohnart (e.g., 110 "Berufsschulzeit") — requires a
  new `TenantConfig.datevVocationalSchoolNr` field and an additional emission
  row in `buildDatevLodas()`.
- **Option B**: folded into Normalstunden 100 — requires summing
  `WorkEvent.workedMinutes` into the existing `workedMinutes` reduction in
  `buildDatevLodas()`.

**Decision (v1.9)**: Stay with the current behavior (BS hours NOT exported).
No code change. The decision is logged here and in `CLAUDE.md`. If a customer
requires Option A or B, the work is a per-tenant feature flag tracked for
v1.10+. Do NOT silently change the export — every change must pass through a
plan, the snapshot test, and a customer-approved migration.

**Action items**:

- [ ] Ask Anjas Lohnbuchhalter which option (A / B / none) is required for the
      current tenant. Owner: the operator.
- [ ] If Option A or B chosen: open a new phase (v1.10+) with
      `TenantConfig.datevVocationalSchoolNr` (Option A) or a documented
      per-tenant fold flag (Option B). Both require updating the snapshot
      baseline with a deliberate diff reviewed in PR.

## Snapshot Test Contract

The byte-equivalence contract for DATEV exports is enforced by
`apps/api/src/__tests__/datev-snapshot.test.ts` (Phase 78 Plan 04 / TEST-V19-01).

- **Scenario**: 1 Azubi + 2 BS-Tage + 8 TimeEntries in May 2026
- **Asserts**: `contentType`, `contentDisposition`, `byteLength`, `sha256`, and the
  full decoded CP1252 text (with ISO timestamp scrubber for forward-compat)
- **Snapshot baseline**: `apps/api/src/__tests__/__snapshots__/datev-snapshot.test.ts.snap`

Any change to `buildDatevLodas()`, the include shape, the Lohnart defaults, or
the field-decimal formatting will diff this snapshot — the diff must be reviewed
and explicitly confirmed as intentional before the PR is approved.

## Encoding & Format

- **Encoding**: CP1252 (Windows-1252) via `iconv-lite`
- **Line endings**: CRLF (`\r\n`)
- **Decimal separator**: comma (German convention — e.g., `64,00`)
- **File extension**: `.txt`
- **Three INI sections**: `[Allgemein]`, `[Satzbeschreibung]`, `[Bewegungsdaten]`
- **12 fields per `[Bewegungsdaten]` row**, semicolon-separated:
  `pnr#bwd;name#bwd;datum#bwd;ausfallkennzeichen#bwd;u_lod_lna_nr#bwd;stunden#bwd;tage#bwd;betrag#bwd;faktor#bwd;kuerzung#bwd;kostenstelle#bwd;kostentraeger#bwd`
- **Ausfallschlüssel**: `K` = Krank, `U` = Urlaub, `S` = Sonderurlaub, empty = Arbeit

See `buildDatevLodas()` in `apps/api/src/routes/reports.ts` for the
field-by-field layout.

## Related Documents

- `docs/work-event-migration-runbook.md` — Phase 80 per-tenant migration playbook
- `CLAUDE.md` — Work-Event Modell invariants and Saldo adapter contract (added in Phase 84)
- `apps/api/src/__tests__/datev-snapshot.test.ts` — the byte-equivalence contract test
- `.planning/REQUIREMENTS.md` § v1.9 → DATEV-V19-02 — requirement origin
