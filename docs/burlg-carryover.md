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
  tenant default") scaled by the contractual workdays of each contract segment (see below), then
  pro-rated for a mid-year hire. It is NEVER created with a hard-coded `totalDays: 0` — a missing
  row used to silently skip the availability check on `POST /leave/requests` entirely.
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

## Contract Change During the Year (Issue #450)

A change of the employee's contractual workdays per week during the year (a new `WorkSchedule`
row) changes the REGULAR yearly entitlement of that year — the entitlement is built per contract
segment, not from whichever contract happened to be current when the row was last computed (EuGH
10.09.2014, C-415/12, _Brandes_; EuGH 11.11.2015, C-219/14, _Greenfield_; BAG 10.02.2015, 9 AZR
53/14).

- **Formula:** for each calendar month the year owes (per the existing § 5 BUrlG hire/exit
  decision), the full-year value of the contract segment active in that month is taken; the twelve
  (or fewer, for a partial year) monthly values are summed FIRST, and § 5 Abs. 2 BUrlG rounding is
  applied ONCE to the total — never per segment. Worked examples (base 30, adult, 5-day reference
  week): a 3-day → 5-day change from 1 July answers 9 (Jan-Jun at 3 days) + 15 (Jul-Dec at 5 days)
  = **24**; a 5-day → 3-day change from 1 July answers 15 + 9 = **24** as well — the same total
  either direction, because the formula sums months owed, not a before/after difference. A 1-day →
  2-day change from 1 February (base 20) answers 20×1/5×1/12 (Jan) + 20×2/5×11/12 (Feb-Dec) = 1.67 +
  6.33 = **8**.
- **A year whose owed months all carry the same value is unaffected**, byte-identical to the
  pre-#450 single-contract formula — for example an hours-only change (same workdays per week,
  different daily hours) never changes the entitlement, because every month still resolves to the
  same full-year value.
- **§ 5 BUrlG hire/exit rules are unchanged.** A month outside the employment range (before hire,
  after exit) is clamped to the boundary month before its active segment is looked up, so it is
  never attributed to a contract row dated after an exit or before a hire.
- **Segment boundaries** come from `WorkSchedule.validFrom`. The employee's FIRST (hire-time) row
  is exempt from the 1st-of-month rule (it may start mid-month, on the hire date itself). Every
  LATER row's `validFrom` is normalized to the 1st of the month per the existing write-side rule;
  a pre-Phase-60 legacy row whose `validFrom` is not the 1st of a month is treated, for this
  apportionment only, as effective from the 1st of the FOLLOWING month — never as a fractional
  month. The read-only dry-run script (below) lists every such legacy normalization once,
  informationally, so the owner can see exactly where a historical row's effective date differs
  from its stored `validFrom`.
- **The statutory minimum follows the same apportionment.** The § 3 BUrlG / § 19 JArbSchG floor a
  `PUT /settings/vacation/:employeeId` write (and its `GET` suggestion) must not undercut is
  computed per contract segment too, through the same per-segment kernel the regular entitlement
  uses — not from the newest `WorkSchedule` row alone. Rationale: the threshold is the floor half
  of the same computation the regular entitlement is the ceiling half of (mirrors how
  `hireYearVacationDays`/`employmentYearVacationDays` already share one hire/exit decision); a
  newest-row-only floor would otherwise reject a CORRECT segment-apportioned value (e.g. base 20,
  3→5 days from 1 July: the correct regular value is 16, but a newest-row-only floor of 20 would
  wrongly reject it) or silently accept an under-floor one in the opposite direction.
- **Already-taken and carried-over days are never changed by this recalculation.** `usedDays` and
  `carriedOverDays` on the recomputed row are left exactly as they were. If the new total falls
  below `usedDays`, the remaining balance may become negative — this is never clamped or hidden; it
  is surfaced by the read-only dry-run script below, the same way an existing deviation already is.
- **Triggers:** every contract-change write path recomputes the affected years' auto-calculated
  VACATION entitlement after the write commits — `PUT /api/v1/settings/work/:employeeId` (both the
  regular branch and the `cancelOrphanShifts` branch) and the tenant-wide `applyToExisting` bulk
  apply, each employee independently. The recompute is REACTIVE: it runs after the triggering
  write's own transaction commits, with its own `.catch`, so one employee's recompute failure never
  rolls back the write or blocks a sibling employee's recompute (ADR 0002 Entscheidung 10) — a
  failure is logged, never thrown back at the caller. The affected years are every year from
  `max(changed WorkSchedule row's validFrom year, current year)` through the current year plus
  one, for which a `LeaveEntitlement` row ALREADY exists (no new year is ever created by this
  recompute) and whose row is auto-calculated — a `validFrom` dated into a past year never
  rewrites that past year's already-reported entitlement, the same rule
  `syncExitYearVacationEntitlement` already applies (code review finding WR-01); such a past year
  surfaces, read-only, via the dry-run script below instead.
- **Human-set rows are never overwritten.** A row is skipped by the recompute when either
  `isAutoCalculated` is `false` or the row's `AuditLog` history shows a human write
  (`hasHumanVacationWrite()`, Issue #447 D-14 — the `isAutoCalculated` column alone is not a
  reliable signal). A skipped human row is listed by the dry-run script below with its new
  (per-segment) value next to the old, stored one — reviewed, never corrected automatically.
- **Every real change is audited.** A write updates only `totalDays` (never `usedDays`/
  `carriedOverDays`) and creates exactly one `AuditLog` UPDATE entry on `LeaveEntitlement` with the
  old/new `totalDays`, reason `"Vertragswechsel"`, the triggering `validFrom`, and the acting user.
- **Bestand (existing data) is never corrected automatically (D-11).** A read-only dry-run,
  `scripts/audit-vacation-entitlements.ts`, lists every stored row's old (`stored`) value next to
  the newly-computed (`target`) per-segment value, for the owner to review case by case; a
  correction for an existing row still runs only through the existing audited correction path
  (`PUT /settings/vacation/:employeeId`, "Antrag korrigieren"), never automatically and never
  through an operator script.
- **The § 5 BUrlG helpers feeding this formula compute in UTC** (hire-year pro-rata, Wartezeit end
  date, the hire/exit month-span counter, the full-entitlement-year decision) — they no longer
  depend on the server process's local timezone.

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

## 6-Tage-Vertrag (Issue #468, D-06/D-07)

- The base vacation value scales proportionally above the 5-day reference week, not just below
  it: `calculatePartTimeVacation()` (`contexts/absence/vacation-calc.ts`) removed the implicit
  cap at the tenant base, so a 6-day contract computes `base × 6/5` (e.g. base 30 → **36**), the
  same `raw × workDays / fullTimeWorkDays` formula every other workday count already used. The
  statutory minimum (§ 3 BUrlG, `calculateStatutoryMinimum()`) was already unaffected by this
  phase's fix — `workDaysPerWeek × 4` already scaled linearly with contractual days (5 days → 20,
  6 days → 24 Werktage), so the statutory floor was never capped in the first place.
- **Equality case unchanged (byte-identical):** `employeeWorkDays === fullTimeWorkDays` still
  returns `baseVacationDays` verbatim — a 5-day employee against a 5-day reference week gets
  exactly the stored base, with no floating-point rounding through the proportional formula. Every
  existing ≤5-day result stays byte-identical to its pre-#468 value (equivalence test,
  `468-02-SUMMARY.md`).
- **The #450 segment kernel (contract-change-during-the-year, see above) inherits the same removed
  cap** — a contract-change segment that is itself a 6-day (or more) week prices through the same
  `calculatePartTimeVacation()` call, so the "5 → 6 days from 1 July" segment case the kernel
  already handles produces the uncapped (36-equivalent) value for the 6-day months, not the
  previously-capped 30.
- **Rounding** follows the existing § 5 Abs. 2 BUrlG convention (#421) — unchanged by this phase.
- **Existing data is never bulk-corrected.** A 6-day employee's auto-calculated entitlement changes
  only through the normal recompute paths already described above (#450's reactive recompute on a
  contract-change write, the zero-placeholder first-access heal) — never a bulk rewrite. The
  read-only dry-run, `scripts/audit-vacation-entitlements.ts`, lists every stored row next to its
  newly-computed target (unchanged script, now also surfacing the previously-capped 6-day rows as
  a `stored` ≠ `target` deviation for the owner to review).

## § 9-Gutschrift und Korrektur (Issue #468, D-04/D-05/A-3)

A `PATCH /requests/:id/correct` on a VACATION (or the corresponding SICK) request now classifies
every confirmed § 9 BUrlG credit touching the request against the corrected range via
`planSection9CreditsForCorrection()` (`contexts/absence/section9-detect.ts`, pure, DB-free):

- **Keep:** a `CONFIRMED` credit that stays fully INSIDE the corrected range is left untouched —
  no re-detection, no re-pricing.
- **Supersede (never delete, R7):** a credit that falls fully OUTSIDE the corrected range, or
  whose request changed type away from VACATION/SICK, is marked `SUPERSEDED` (additive enum
  value) — kept for the audit trail, visible via `GET /section9?status=SUPERSEDED`, never
  returned by `GET /requests`' bulk status map. A `CONFIRMED` credit's ledger entry is undone
  (`deductVacationDays()`, the exact mirror of confirm's `reverseVacationDays()`) in the same
  transaction as the status flip.
- **Clip + correction credit (A-3):** a `CONFIRMED` credit that only PARTIALLY survives the new
  range is superseded and replaced by exactly one new `CONFIRMED` correction credit at
  `revision + 1` (`supersedesId` pointing at the original, re-priced via `resolveLeaveDays()` over
  the clipped range, re-credited the same way). A second correction on the same pair chains to
  `revision + 2`, and so on — `Section9Credit`'s unique constraint widened to `(sickRequestId,
vacationRequestId, revision)` to allow the chain.
- **AU_PENDING/REJECTED credits are left alone by `/correct`** (nothing was ever booked for them);
  `confirm`/`reject` clip the attested overlap to the vacation's CURRENT range at decision time
  instead, and refuse a `SUPERSEDED` credit outright (409).
- **Worked examples (the Issue #468 finding 2 regression, both now closed):** 10 days vacation
  with 3 confirmed sick days corrected to a 7-day range —
  - sick days fully OUTSIDE the new 7-day range → consumed **7** (not 4, the old
    double-credit bug: the OLD logic net-reversed the 10-day booking by the credit's −3 a SECOND
    time against the new range).
  - sick days fully INSIDE the new 7-day range → consumed **4** (unaffected regression guard).
  - sick days PARTIALLY inside → consumed **5** via a `revision + 1` correction credit for the
    still-covered part.
  - the vacation side changes type away from VACATION → the credit fully supersedes (**0**
    consumed on the credit side), never a partial clip even if the ranges still overlap
    geometrically.
- Correcting the SICK request's own range (instead of the vacation side) clips/supersedes its
  credits the same way; a cross-year correction that moves a credit entirely out of its origin
  year leaves BOTH years' ledgers equal to their self-heal value (no stray residual in the origin
  year).

## Elternzeit-Kürzung (§ 17 Abs. 1 BEEG) (Issue #468, D-08–D-12, A-1/A-2)

A declared Elternzeit does NOT automatically reduce the vacation entitlement — § 17 Abs. 1 BEEG
gives the employer the RIGHT to reduce it, and this project implements that as a manual, audited
action, never an automatic recompute (owner decision, #451 comment 2026-10-03):

- **Anchored on the `LeaveRequest`, not an `Absence` (A-1).** In this codebase Elternzeit is
  requested and approved as a `LeaveRequest` of type `PARENTAL` (not an imposed `Absence`) —
  `ParentalLeaveReduction.leaveRequestId` is a required FK onto an APPROVED (`EFFECTIVE_LEAVE_
STATUSES`) `PARENTAL` request, `onDelete: Restrict`, unique `(leaveRequestId, year)`.
- **Preview/commit/revoke, one per calendar year touched** (`GET/POST
/api/v1/leave/parental-reductions/:leaveRequestId`, `POST .../revoke`) — the UI lives on the
  approved PARENTAL request's own detail view (A-2), behind `leave-entitlement:update:ZUGEWIESEN`
  (reusing the same permission `PUT /settings/vacation` already requires).
- **Reduction formula:** one twelfth of the regular yearly entitlement per FULL calendar month of
  the Elternzeit in that year (`fullCalendarMonthsByYear()`), § 5 Abs. 2 BUrlG rounding (#421)
  applied to the REMAINING entitlement after the reduction — never to the reduction itself — so
  the reduction is always the employee-favourable difference. A 12-month Elternzeit reduces the
  entitlement to exactly 0.
- **Human-owned, never silently overwritten.** The commit transaction's `LeaveEntitlement` UPDATE
  audit never sets `isAutoCalculated`, which is the entire mechanism that makes the existing
  `hasHumanVacationWrite()` detector (see "Human-set rows are never overwritten" above) skip the
  row during #450's reactive recompute.
- **One declaration per Elternzeit and year.** The unique `(leaveRequestId, year)` is kept
  literally — a REVOKED year cannot be re-declared via the same action (a re-commit answers 409
  naming the revoked declaration); a genuinely new declaration requires a new issue/manual
  correction path, not a silent second row.
- **Revocation is a correction entry, never a delete (D-10).** `ParentalLeaveReduction.status`
  flips `ACTIVE → REVOKED` (`revokedAt`/`revokedBy`), restoring the entitlement by the STORED
  `reducedDays` — never a recomputation, even after an intervening manual
  `PUT /settings/vacation/:employeeId` edit changed the entitlement in between.
- **Revoke-before-change guard (D-10, consistency):** a `/correct` or a cancellation-approval of
  the anchoring PARENTAL request is blocked (409) while an `ACTIVE` reduction exists and the
  change would either alter a reduced year's full-month count or move the request away from type
  PARENTAL entirely — a harmless date shift that leaves every reduced year's month count unchanged
  is allowed through. Cancellation-approval is blocked unconditionally on ANY active reduction
  (cancellation destroys the anchor outright).
- **Reduced statutory floor (D-07/D-09).** `PUT /settings/vacation/:employeeId`'s guard, its `GET`
  suggestion, and the read-only Prüfbericht (`audit-vacation-entitlements.ts`) all compare against
  the SAME reduced floor (`remainingAfterParentalMonths(unreducedThreshold,
activeParentalReductionMonths(...))`) for a reduced year — one rule for read, write and report.
  An unreduced year is unaffected.
