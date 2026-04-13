# Phase 14: Weekday Configuration & Per-Day Soll - Context

**Gathered:** 2026-04-13 (smart discuss — autonomous mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Allow admins to configure which weekdays a MONTHLY_HOURS employee regularly works, and display a per-day Soll in the time-entries calendar (budget ÷ working days in month). No schema migration required — reuses existing `mondayHours`...`sundayHours` fields in WorkSchedule. No change to saldo calculation logic (monthly budget remains the expected total). Phase 15 will consume this weekday config to determine which holidays reduce the monthly Soll.

</domain>

<decisions>
## Implementation Decisions

### Schema & Storage
- **D-01:** Reuse existing `WorkSchedule.mondayHours`...`WorkSchedule.sundayHours` fields for MONTHLY_HOURS employees. Interpretation: 0.0 = "does not work that day", non-zero = "works that day". No schema migration needed.
- **D-02:** "No weekday config" is inferred: all 7 day fields = 0 → no per-day Soll shown (pure flexible Minijobber mode). No new boolean flag or column.
- **D-03:** When admin first sets a new MONTHLY_HOURS schedule, the day fields default to Mon–Fri = 1.0, Sat/Sun = 0.0 (overrideable via the UI picker).
- **D-04:** The existing `employeeScheduleSchema` in `settings.ts` already includes all 7 day fields — no API schema change needed, just documentation of the MONTHLY_HOURS interpretation.

### Calendar Per-Day Soll
- **D-05:** Formula: `dailySoll = monthlyBudget ÷ count of configured working days occurring in that calendar month`. Example: if Mon–Fri configured and the month has 23 working days → dailySoll = monthlyBudget / 23.
- **D-06:** On days where the employee's configured weekday falls (e.g., Monday for a Mon–Fri employee): show `dailySoll` as target hours in the calendar day cell.
- **D-07:** Non-configured weekdays (e.g., Saturday): no Soll shown — same as current MONTHLY_HOURS behavior.
- **D-08:** When all day fields = 0 (no weekday config): no per-day Soll shown for any day — preserves current MONTHLY_HOURS behavior.
- **D-09:** Show +/- delta per configured day (worked − dailySoll) with same green/red color coding as FIXED_WEEKLY.
- **D-10:** Leave days on configured weekdays: still show the dailySoll target (leave's effect is captured in saldo, not by zeroing the Soll — consistent with FIXED_WEEKLY behavior).

### Admin UI
- **D-11:** Weekday picker added to the **existing schedule edit modal** in `apps/web/src/routes/(app)/admin/vacation/+page.svelte` — same modal extended in Phase 13 for `overtimeMode`.
- **D-12:** Picker renders only when `type === "MONTHLY_HOURS"`.
- **D-13:** Control: toggle chips — abbreviated German day names (Mo / Di / Mi / Do / Fr / Sa / So) as clickable pill buttons. Selected state = filled with brand color; deselected = outlined. Pure CSS, no new library.
- **D-14:** No separate "enable" toggle — the picker is always visible when type === MONTHLY_HOURS. All-deselected (all zero) = no per-day Soll (user communicates pure flexible mode by deselecting all).
- **D-15:** German labels: section header "Feste Arbeitstage", helper text below: "Wenn konfiguriert, wird ein tägliches Soll im Kalender angezeigt (Budget ÷ Arbeitstage im Monat)."

### Claude's Discretion
- Exact pixel sizing / spacing for toggle chips (follow existing modal patterns in vacation/+page.svelte)
- Whether to expose the configured weekdays in the GET /employees response payload or only in GET /settings/work/:id
- Audit log action name for weekday config change (e.g., "SCHEDULE_WORKDAYS_UPDATED")

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema
- `packages/db/prisma/schema.prisma` — WorkSchedule model (mondayHours...sundayHours fields, lines ~250–274)

### API
- `apps/api/src/routes/settings.ts` — `employeeScheduleSchema` (lines 76–95), PUT /settings/work/:employeeId handler (~line 270–310)

### Calendar Frontend
- `apps/web/src/routes/(app)/time-entries/+page.svelte` — MONTHLY_HOURS Soll comment at line 381, `isMonthlyHours` derived at line 719, `monthlyBudgetMinutes` at line 721

### Admin UI
- `apps/web/src/routes/(app)/admin/vacation/+page.svelte` — schedule edit modal (Phase 13 added overtimeMode selector)

### Prior Phase Context
- `.planning/phases/13-overtime-handling-mode-carry-forward-track-only/13-CONTEXT.md` — D-07 through D-09: how overtimeMode was added to the same modal

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorkSchedule.mondayHours`...`sundayHours` — already in schema and API schema; reused as weekday config flags
- Schedule edit modal (vacation/+page.svelte) — existing form with conditional fields by schedule type; overtimeMode added in Phase 13
- `isMonthlyHours` derived state in time-entries/+page.svelte — already gates MONTHLY_HOURS display logic

### Established Patterns
- `{#if isMonthlyHours}` gate already used for monthlyBudgetMinutes; extend for per-day Soll
- `{#if slot.isLocked}` conditional rendering pattern — reuse for `{#if configuredWorkday}` per-day Soll display
- Phase 13 toggle chip pattern (if implemented as toggle chips for overtimeMode) — or follow existing select style
- `var(--color-brand)` for active/selected state, `var(--color-border)` for deselected — per UI guidelines

### Integration Points
- `apps/web/src/routes/(app)/time-entries/+page.svelte` → per-day Soll display (calendar cells)
- `apps/web/src/routes/(app)/admin/vacation/+page.svelte` → weekday picker UI
- `apps/api/src/routes/settings.ts` → already accepts day fields; document MONTHLY_HOURS interpretation
- Phase 15 will read `WorkSchedule.{weekday}Hours > 0` to determine holiday deduction eligibility

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches within the decisions above.

</specifics>

<deferred>
## Deferred Ideas

- Saldo calculation adjustment for MONTHLY_HOURS weekday config (expected hours per working day vs. total monthly budget) — out of scope; saldo stays: worked − monthlyBudget total.
- Partial-month proration for new hires mid-month — deferred to v1.4+ (SCHED-V14-01).
- Holiday deduction based on weekday config — Phase 15 (TENANT-01).

</deferred>

---

*Phase: 14-weekday-configuration-per-day-soll*
*Context gathered: 2026-04-13*
