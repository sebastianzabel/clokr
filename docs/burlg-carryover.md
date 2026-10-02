# BUrlG Vacation Carry-Over & Cross-Year Booking Rules

Implementation rules for vacation/leave carry-over logic. See GitHub issue #58 and, for the
regular-entitlement/cross-year/FIFO/protected-deadline rules below, GitHub issue #445. Linked from
`CLAUDE.md`.

These rules MUST be followed when implementing or modifying vacation/leave carry-over logic.

## BUrlG (Bundesurlaubsgesetz) Rules

- **§ 3 Gesetzlicher Mindesturlaub**: `Arbeitstage/Woche × 4` (5-day week = 20 days, 6-day week = 24 days)
- **§ 7 Abs. 3 Übertragung**: Vacation MUST be taken in the current calendar year. Carry-over to the next year ONLY with valid reason (illness, maternity, parental leave, operational necessity, other documented reason). Carried-over days expire by **March 31** of the following year (configurable per tenant) unless an extended, documented deadline protects them.
- **Langzeitkrankheit**: Carry-over up to 15 months (EuGH C-214/10 "KHS")
- **Hinweispflicht** (EuGH C-684/16): Employer must proactively warn employees about expiring vacation. Without warning, vacation does NOT expire automatically.

## Regular Yearly Entitlement (Issue #445)

- A `LeaveEntitlement` row for the next year is created with the **regular yearly entitlement** —
  computed by ONE function, `computeRegularVacationDays()` (`contexts/absence/vacation-calc.ts`):
  the tenant/person base value (today: `TenantConfig.defaultVacationDays`, resolved by
  `resolveVacationBaseDays()` — Issue #435 changes only this one resolver to "person value ??
  tenant default") scaled by the employee's contractual workdays, then pro-rated for a mid-year
  hire. It is NEVER created with a hard-coded `totalDays: 0` — a missing row used to silently skip
  the availability check on `POST /leave/requests` entirely.
- An employee who exited before 1 January of the target year gets `0` (no employment in that
  year). An exit DURING the year carries the § 5 BUrlG Teilurlaub on the PERSISTED row itself
  (`employmentYearVacationDays()`, Issue #447): the exit-year row is recomputed — with an audit
  entry — every time the exit date is set, moved, or cleared, and again before every availability
  check, UNLESS a human ever wrote the row's `totalDays` directly. Carry-over from the prior year
  is never pro-rated by this recompute; past years are never touched.
- A **zero placeholder** — `totalDays = 0`, not auto-calculated, and no human/API write ever set
  `totalDays` on the row (no `AuditLog` CREATE/UPDATE with a `newValue.totalDays` outside
  `isAutoCalculated: true`) — heals to the regular entitlement, audited, the first time any of the
  following reads or writes the row: a carry-over recompute, the leave-request availability check,
  the entitlement view (`GET /leave/entitlements`), the leave report
  (`GET /reports/leave-overview`), or `GET /settings/vacation/:employeeId`. The heal is skipped
  (and the row is flagged for review instead — `entitlementWarning` on the entitlement/report rows)
  when the computed target is AMBIGUOUS: the employee had a full prior year on record whose own
  row is reliable and whose `totalDays` differs from the target (e.g. an Azubi/individual 20-day
  contract that the tenant-default formula would otherwise silently raise to 30). Such a row is
  corrected only by a human (`PUT /settings/vacation/:employeeId`) or by the operator script below
  with `--include-flagged`.
- Existing zero rows created before this phase are corrected with
  `apps/api/scripts/repair-zero-vacation-entitlements.ts` — dry-run by default, prints ids/numbers
  only (no names), flags the same ambiguous case as `PRUEFEN`, and only writes with `--confirm`
  (`--include-flagged` additionally applies the flagged rows). Every write is audited.

## Cross-Year Booking

- A vacation request spanning two calendar years (e.g. 28 Dec – 9 Jan) is split between the two
  years **chronologically**: the days are attributed in date order, using the SAME day-counting
  dispatch the request itself was priced with (`resolveLeaveDays()` — SHIFT_BASED employees by
  their roster/contract, every other schedule type by `workDays`). The split always sums to
  exactly the request's own `days` — unlike re-deriving each year's count independently from the
  placeholder `workDays` array, which could over- or under-count a SHIFT_BASED boundary week.
  Example: a 4-day-contract employee's request over New Year's costs 7 days total and splits 4 / 3
  across the two years (not a naive per-segment count, which would charge a boundary week twice).
- Each year's entitlement is checked and booked separately; a missing row for either year is
  created with the regular entitlement (see above) before the check runs.
- Cancellation approval reverses BOTH years with the same chronological attribution and
  recomputes the NEXT year's carry-over — never a single-year decrement.
- Self-heal (`GET /leave/entitlements`, `GET /reports/leave-overview`) recomputes each year's
  `usedDays` from its own counted window: APPROVED and CANCELLATION_REQUESTED requests (leave
  stays active until a cancellation is approved) overlapping that year, attributed the same
  chronological way for a cross-year request; CONFIRMED § 9 credits are attributed by the same
  rule over their own credited range. Every correction is audited (reason "Self-Heal") and a
  self-heal NEVER creates a missing next-year row (a read must not create data).

## Dynamic Carry-Over

- Carry-over is recalculated on every booking/cancellation/self-heal correction.
- Advance booking into next year: uses projected carry-over first, then new year entitlement.
- New booking in current year after advance booking: carry-over to next year is reduced, next
  year's entitlement adjusted.
- **Carry-over priority — FIFO (Issue #445)**: days taken before the carry-over deadline are
  consumed from the carry-over FIRST (BUrlG § 7 Abs. 3; Tilgung der älteren Schuld analog § 366
  Abs. 2 BGB) — only the part NOT taken by the deadline can lapse, and only when the employer
  documented the Hinweispflicht warning (EuGH C-684/16, a `CARRYOVER_WARNED` AuditLog row). A
  carry-over that has lapsed this way is EXCLUDED from the remainder rolled into the following
  year — it never comes back. Example: `totalDays` 30 + carry 5, 5 days taken in February, warned
  → after 31 March the full 30 is still available (not 25, the old whole-carry-drops-to-zero
  behaviour); if those 5 days are never taken and the deadline passes with a warning, only the
  carry's untaken remainder lapses, and the following year's remainder is computed from the
  effective (post-lapse) carry, not the raw stored value.
- A carry-over recompute writes an audit UPDATE only when `carriedOverDays` actually changed.

## Carry-Over Validation / Protected Deadline (Issue #445)

- An extended carry-over deadline is set with a documented reason via
  `PUT /api/v1/settings/vacation/:employeeId` (`carryOverReason`, `carryOverNote`):
  - `ILLNESS` — EuGH KHS C-214/10, 15 months after the end of the accrual year; defaults the
    deadline to 31 March of `year + 1` when none is given explicitly.
  - `MATERNITY` — § 24 S. 2 MuSchG (Mutterschutz).
  - `PARENTAL_LEAVE` — § 17 Abs. 2 BEEG (Elternzeit).
  - `OTHER` — any other documented reason; requires a non-empty `carryOverNote`.
  - Every reason except `ILLNESS` requires an explicit `carryOverDeadline` in the same request.
  - The legacy stored value `OPERATIONAL` (pre-#445 rows) stays readable and is treated as
    protected too.
  - Omitting the field keeps the stored reason/note; an explicit `null` removes the protection.
    Every write (set or remove) is audited with the old and new reason/note.
- **One predicate, every documented reason protects the deadline**: `preserveCarryOverDeadline()`
  (`contexts/absence/illness-carryover-guard.ts`) replaces the old ILLNESS-only predicate and is
  consulted by every automatic recompute (`recalculateCarryOver()`, `autoCarryOver()`,
  `PUT /settings/vacation/:employeeId`) before writing `carryOverDeadline` — protecting the
  deadline NEVER protects `carriedOverDays`, which is still recomputed on every pass.
- Reminders starting in October (configurable) when vacation is at risk of expiring.
- Escalation to manager in November, final warning in December.
