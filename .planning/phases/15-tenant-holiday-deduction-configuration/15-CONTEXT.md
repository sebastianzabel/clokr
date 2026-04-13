# Phase 15: Tenant Holiday Deduction Configuration - Context

**Gathered:** 2026-04-13 (assumptions mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Allow tenant admins to configure whether public holidays that fall on a MONTHLY_HOURS employee's configured workdays reduce the monthly Soll. This is a tenant-wide boolean toggle — not per-employee. Phase 14 established which weekdays a MONTHLY_HOURS employee works; Phase 15 consumes that config to determine holiday deduction eligibility.

</domain>

<decisions>
## Implementation Decisions

### Storage
- **D-01:** New boolean field `monthlyHoursHolidayDeduction` (default: `false`) added to `TenantConfig` in `packages/db/prisma/schema.prisma`. Accessed via the existing `PUT /api/v1/settings/work` endpoint and `tenantConfigSchema` in `apps/api/src/routes/settings.ts`. Same upsert + audit pattern as `arbzgEnabled`, `halfDayAllowed`, `autoBreakEnabled`.
- **D-02:** Default `false` — existing behavior (no deduction for MONTHLY_HOURS) is preserved until the admin explicitly enables it. No migration impact on existing tenants.

### Deduction Mechanics
- **D-03:** When the toggle is enabled, holidays that fall on the employee's configured workdays (i.e., `WorkSchedule.{weekday}Hours > 0`) are subtracted from the working-days denominator before computing `dailySollMin`. Formula: `dailySollMin = monthlyBudget / (workingDays − qualifyingHolidays)`.
- **D-04:** In the calendar, holiday cells already render with `expectedMin = 0` (existing behavior at `time-entries/+page.svelte` line 399). No change needed to the per-cell rendering — only the divisor in `countWorkingDaysInMonth` must become holiday-aware when the toggle is on.
- **D-05:** The monthly Soll reduction is symmetric with FIXED_WEEKLY: both schedule types subtract `dailySoll × qualifyingHolidayCount` from the expected total. This prevents saldo divergence at Monatsabschluss.

### Affected Code Sites (all 5 must read the toggle)
- **D-06:** Backend — `apps/api/src/routes/time-entries.ts`, `apps/api/src/routes/overtime.ts`, `apps/api/src/plugins/auto-close-month.ts`, `apps/api/src/utils/recalculate-snapshots.ts`. Each currently calls `getDayHoursFromSchedule` per holiday date; for MONTHLY_HOURS with the toggle on, substitute `dailySoll` as the per-holiday deduction instead of the raw day-flag value.
- **D-07:** Frontend — `countWorkingDaysInMonth` in `apps/web/src/routes/(app)/time-entries/+page.svelte`. When toggle enabled, subtract the count of holidays on configured workdays from the working-days count before returning.

### Holiday Source
- **D-08:** Use the existing `getHolidays(year, stateCode)` from `apps/api/src/utils/holidays.ts` merged with `prisma.publicHoliday.findMany` (same pattern as all other deduction sites). No new holiday resolution logic. `Tenant.federalState` continues to drive state-specific holiday sets.

### Admin UI
- **D-09:** Toggle placed in `apps/web/src/routes/(app)/admin/system/+page.svelte` under the existing "Arbeitszeit" section. The `system/+page.svelte` already has a `TenantConfig` interface (lines 7–28) and fetches/saves tenant config via the same endpoint. A simple boolean toggle (checkbox or switch), labeled e.g. "Feiertage kürzen Monatsstunden-Soll".
- **D-10:** UI is only visible to ADMIN role (existing page-level authorization on system/+page.svelte).

### Claude's Discretion
- Exact German label wording for the toggle (follow existing label style in system/+page.svelte)
- Whether to show a helper text explaining the formula (Budget ÷ (Arbeitstage − Feiertage))
- Audit log action name for the config change

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema & API
- `packages/db/prisma/schema.prisma` — TenantConfig model (lines ~37–148); add `monthlyHoursHolidayDeduction Boolean @default(false)`
- `apps/api/src/routes/settings.ts` — `tenantConfigSchema` (lines 10–67), `PUT /work` handler (lines 157–249); extend with new field

### Holiday Logic
- `apps/api/src/utils/holidays.ts` — `getHolidays(year, stateCode)` — canonical holiday resolution
- `apps/api/src/utils/timezone.ts` — `calcExpectedMinutesTz` — how MONTHLY_HOURS expected hours are currently computed

### Computation Sites (all must be updated)
- `apps/api/src/routes/time-entries.ts` (lines 1337–1368) — holiday deduction in time entry expected calc
- `apps/api/src/routes/overtime.ts` (lines 782–804) — holiday deduction in overtime saldo
- `apps/api/src/plugins/auto-close-month.ts` (lines 236–259) — holiday deduction in monthly close
- `apps/api/src/utils/recalculate-snapshots.ts` (lines 103–113) — holiday deduction in retroactive recalc

### Frontend
- `apps/web/src/routes/(app)/time-entries/+page.svelte` — `countWorkingDaysInMonth` (line ~476), `buildCalendarDays` (lines 300–352)
- `apps/web/src/routes/(app)/admin/system/+page.svelte` — TenantConfig interface (lines 7–28), existing config toggle pattern

### Prior Phase
- `.planning/phases/14-weekday-configuration-per-day-soll/14-CONTEXT.md` — D-01 (weekday flag interpretation), D-05 (dailySoll formula)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TenantConfig` upsert pattern in `settings.ts` — add field to schema + Zod schema + handler, done
- `getHolidays` + `prisma.publicHoliday.findMany` merge pattern — copy from any of the 4 backend sites
- `countWorkingDaysInMonth` in `time-entries/+page.svelte` (Phase 14) — extend with optional holiday subtraction
- Boolean toggle pattern in `admin/system/+page.svelte` — several existing examples to follow

### Established Patterns
- Holiday deduction in backend always: resolve holidays → filter to configured workdays → subtract per-day expected from total
- MONTHLY_HOURS `dailySoll` = `monthlyBudget / workingDays` (Phase 14 D-05) — Phase 15 adjusts the denominator
- All 4 backend sites use identical `getDayHoursFromSchedule(schedule, dow)` pattern — MONTHLY_HOURS will use `dailySoll` instead when toggle is on

### Integration Points
- `TenantConfig.monthlyHoursHolidayDeduction` → read at all 4 backend computation sites + 1 frontend call
- Frontend needs the toggle value passed down to `countWorkingDaysInMonth` — likely via the existing `schedule` or a new prop on the employee/schedule API response
- The `GET /settings/work` response already returns `TenantConfig` fields to the frontend; extend with the new field

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond the decisions above — open to standard approaches within the patterns.

</specifics>

<deferred>
## Deferred Ideas

- Per-employee override for holiday deduction — REQUIREMENTS.md explicitly Out of Scope (German employment law applies uniformly per company)
- Partial-month proration for new hires — deferred to v1.4+ (SCHED-V14-01)
- Configuring which holiday categories count (national vs. regional vs. custom) — current source already merges all three; no filtering needed for Phase 15

</deferred>

---

*Phase: 15-tenant-holiday-deduction-configuration*
*Context gathered: 2026-04-13*
