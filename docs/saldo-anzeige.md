# Saldo-Anzeige: Bestätigt vs. Laufender Monat (Prognose)

Standing reference for the split-saldo vocabulary introduced in Phase 97
(`saldo-anzeige-bestaetigt-vs-laufender-monat-prognose-trennen`). Read this before answering a
support question about "why did my Überstunden number drop", before touching any saldo-display
surface, or before adding a new one. See also `CLAUDE.md` → "Saldo Calculation & Monatsabschluss"
and `CLAUDE.md` → "Overtime Saldo Calculation (current)" for the underlying calculation rules,
which this phase does **not** change — only the presentation and labelling of the existing figures.

## Vocabulary

Two German UI terms, used identically everywhere they appear:

- **„Bestätigt"** — the confirmed carry-over from CLOSED months. Concretely: the `carryOver` of the
  most recent non-superseded `SaldoSnapshot` with `periodType: "MONTHLY"` for the employee
  (`getConfirmedCarryOver` / `getConfirmedCarryOverBulk` in `apps/api/src/utils/confirmed-saldo.ts`
  — the same chain Phase 98's audit walks and verifies, so both features share one source of truth).
  Stable, legally defensible as the entitlement figure. It only moves at Monatsabschluss.
- **„Laufender Monat (Prognose)"** — everything accrued since that last close. It is **derived by
  subtraction** (`total − confirmed`) at exactly one place
  (`computeOvertimeBalanceBreakdown` in `apps/api/src/routes/time-entries.ts`), never computed
  independently. This guarantees the two figures always sum to exactly the total the app has always
  shown, and avoids creating a second computation path for the same value — the same shape whose
  violation is why Phase 98 (saldo chain integrity audit) exists in the first place.

**Caveat:** "the open month" is a simplification for the common case. The forecast technically
covers everything **since the last Monatsabschluss** — in normal operation (tenant closes every
month) that is the current calendar month, but for a tenant that has stopped closing months it can
span several months. The label still says "Laufender Monat (Prognose)"; the underlying period is
whatever remains unconfirmed.

**No closed month yet** (new hire): `confirmed = 0`, flagged explicitly as "noch kein
Monatsabschluss" rather than a genuine 0h entitlement, so it cannot be misread as "you have zero
overtime" the way a plain `0` would.

## Why the forecast moves — both directions

The forecast is not simply "uncertain", it moves for two distinct, opposite reasons, both rooted in
the SHIFT_BASED roster-proration formula (`calcShiftBasedSaldo()` in
`apps/api/src/utils/shift-based-saldo.ts` — unchanged by this phase):

1. **Under-rostering erodes it.** When the contract's full-period Soll (`C_net`) is prorated by
   roster progress (`R_toDate / R_periodFull`) and the roster covers fewer minutes than the
   contract expects, each additional rostered — and worked — day charges more Soll than it credits,
   so the accrued plus visibly shrinks day over day, then corrects back at month end once the full
   roster is known. This is the pattern measured on production: 8 of 13 active SHIFT_BASED
   employees showed real day-over-day drops in the open month, up to 555 minutes in a single day.
   See `.planning/debug/saldo-drops-3h-on-a-worked-day.md` for the full measured evidence.
2. **An unfinished roster suppresses it, then releases it as a jump.** `R_periodFull` counts the
   shifts that **exist** in the roster, not the calendar month. A month whose remainder has not
   been rostered yet makes `R_toDate / R_periodFull` reach `1.0` early, which charges the FULL
   month's contract Soll mid-month — worked-extra minutes then read as 0 overtime until the planner
   fills in the rest of the roster, at which point the true plus appears all at once. Worked
   example: `C_net` 9120 min, only 8 of 16 shifts rostered (4560 min), employee has worked 5000 min
   → effective Soll is the full 9120 → plus reads **0**. Once the remaining shifts exist
   (`R_periodFull` 9120) → effective Soll drops to 4560 → plus reads **+440**. The employee's figure
   moved although the employee did nothing differently — the planner completing the roster moved it.

These two effects point in opposite directions and can both apply within the same month at
different times. Neither is a defect in the formula; both are why the forecast needed a name that
says "this can still move" rather than presenting it with the same weight as the confirmed figure.

## §615 BGB / Annahmeverzug — why under-rostering is never charged to the employee

Under-rostering (effect 1 above) is **Betriebsrisiko** (operational risk), not employee
Minusstunden: § 615 BGB (Annahmeverzug) puts the risk of insufficient work allocation on the
employer, not the employee, when the employee remains ready to work. This is why the SHIFT_BASED
saldo formula is a two-clause clamp
(`max(0, W − C_net) − max(0, R_toDate − W)`, computed in
`close-employee-month.ts` and mirrored live) rather than a plain `Ist − Soll`: an under-rostered
day can suppress accrued PLUS, but the clamp keeps the employee from ever being pushed into MINUS
purely because the planner under-scheduled them. This legal reasoning intentionally does **not**
appear in the on-screen tooltip (`SaldoAnzeige.svelte`) — a tooltip must answer "why is my number
smaller today" in one sentence, and a reference to Annahmeverzug relocates the question rather than
answering it. It belongs here and on the Überstunden detail page instead.

## Guarantee: the confirmed figure cannot be eroded by the open month

For SHIFT_BASED, the displayed running balance is **not** `Ist − anteiliges Soll`.
`close-employee-month.ts` sets `balanceMinutes = sbSaldo.balanceDelta`, i.e. the clamped two-clause
form `max(0, W − C_eff) − max(0, R_toDate − W)`, in the live/display path as well as at close. As
long as the employee works their rostered shifts (`W >= R_toDate`), the second term is `0` and the
open month's contribution is `>= 0`. What visibly "drops" during a month is only the plus accrued
**within that open month**, eroding down to `0` and staying flat — never into the confirmed
carry-over. „Bestätigt" is genuinely safe from open-month fluctuation, which is a large part of why
it is the primary, leading figure in every split-saldo display and why the forecast is
intentionally the smaller, secondary one.

## PDF export and Berichte

The exported Stundennachweis (single-employee and company-wide monthly PDF, `apps/api/src/routes/reports.ts`

- `apps/api/src/utils/pdf.ts`) and the Kalender-Header/Berichte screens do **not** show the lifetime
  split described above — they show a single, MONTH-scoped Monats-Saldo
  (`GET /overtime/month-saldo/:employeeId`, `computeMonthSaldo()`), which has no lifetime counterpart
  to split against. Forcing a lifetime "Bestätigt" line into a month-scoped figure would fabricate a
  key figure that was never there. Instead, this month-scoped figure is **relabelled** using the same
  two words: a CLOSED month's value is labelled with `OVERTIME_LABEL_CONFIRMED`
  ("Überstunden (Bestätigt)"), an OPEN month's with `OVERTIME_LABEL_FORECAST`
  ("Überstunden (Prognose)") — both exported from `apps/api/src/utils/pdf.ts` so the wording cannot
  drift between the single-employee and the company generator. `resolveReportOvertimeHours` in
  `reports.ts` resolves which applies per employee per month; its `confirmed` flag is `true` only for
  the branch that found a non-superseded `SaldoSnapshot` for the exact period (the one branch whose
  figure is final).

One population is deliberately given **neither** label: a `MONTHLY_HOURS` schedule with no monthly
budget (`monthlyHours` null/0) has no Soll target at all — the screen already shows a dedicated
„Keine Soll-Vorgabe" state for it, and its exported figure never moves. Labelling it "Prognose"
would be a fabrication (there is nothing being forecast) and a screen-vs-export contradiction, so
`resolveReportOvertimeHours` resolves `labelled: false` for this population and the PDF renderer
omits the label — and, on the company table, the asterisk — entirely for it.

Because the company-wide PDF lists many employees at once and month-close happens **per employee**,
one export can legitimately mix confirmed and provisional rows. A document-level label would be
wrong, so each provisional row's Saldo cell carries a trailing ` *`, and a single legend line
(`COMPANY_PROVISIONAL_LEGEND`) is printed once at the end of the table, only when at least one row
is provisional.

## SALDO-DISP-08 Decision: no suppression code

**Requirement:** day-over-day saldo comparisons/notifications inside the open month should be
suppressed, because alerting on a drop that the rest of this release explains as a forecast
artefact would contradict the release's own message — **unless no such notification exists, in
which case the requirement is to record that decision rather than build a suppression mechanism.**

**Decision: no such notification exists, so no suppression code was written.** Evidence from
research conducted 2026-08-18 (Phase 97-02):

- All 34 notification `type` strings passed to `app.notify()` across the codebase were enumerated.
  None compares a saldo value between two points in time (day-over-day or otherwise) — the closest
  candidates are leave/break/missing-entry/retro-entry notifications, all unrelated to overtime
  balance.
- All ten `node-cron` registrations in `apps/api/src/plugins/attendance-checker.ts` were read; their
  eleven `notify()` call sites (missing entries, clock-out reminders, break compliance, etc.) are
  unrelated to saldo comparisons.
- `CARRYOVER_EXPIRING` (`apps/api/src/plugins/carryover-warning.ts`) is the BUrlG vacation-**day**
  expiry warning — a completely different domain (Urlaubsanspruch, not Überstunden).
- `TenantConfig.emailOnOvertimeWarning` is a config field with **no emitter anywhere** — no code
  path constructs a notification whose type this toggle would gate. This was already documented as
  a dead toggle in `apps/api/src/plugins/notify.ts` before this phase; Phase 97-02 added a
  `SALDO-DISP-08`-tagged note next to it recording this verification and pointing back to this
  document, without adding a map entry, a new notification type, or an emitter.

**Forward-looking rule:** if a day-over-day (or any point-in-time-comparison) saldo notification is
ever added in the future, it MUST compare the **confirmed** figure only and MUST exclude the
open-month (Prognose) delta — comparing the raw total, or the forecast, across two points in time
would reintroduce exactly the false-alarm risk this decision avoids today.

## Minusstunden-Toleranz (maxNegativeBalanceMinutes)

Phase 100 (`berstundenabbau-minusstunden-toleranz-wirksam-machen-korrekt`, OTC-01/OTC-02) turned
`maxNegativeBalanceMinutes` from stored-but-discarded configuration into a real, enforced booking
limit. This section is the one place to answer "what does an empty Max.-Minusstunden field mean"
without reading code — read it before changing anything that reads or writes this value.

### Where the value lives

Two places, resolved through a single shared precedence chain — never duplicated inline
(`resolveNegativeBalanceTolerance` / `loadNegativeBalanceTolerance`,
`apps/api/src/utils/negative-balance-tolerance.ts`):

1. **`WorkSchedule.maxNegativeBalanceMinutes`** — a per-employee override, set via
   `PUT /api/v1/settings/work/:employeeId` (Admin-Oberfläche → Mitarbeiter → Arbeitszeit → „Max.
   Minusstunden").
2. **`TenantConfig.maxNegativeBalanceMinutes`** — the tenant-wide default, set via
   `PUT /api/v1/settings/security` (Admin-Oberfläche → Einstellungen → Sicherheit).

The per-employee value wins whenever it is set — including an EXPLICIT `0` — because the chain uses
nullish coalescing (`??`), not `||`: an employee whose contract deliberately allows zero tolerance is
never silently overridden by a non-zero tenant default. Only the ABSENCE of a per-employee row (or a
row whose field is `null`) falls through to the tenant default.

### The two readings of `null`

The SAME stored `null` — "nothing configured, at either level" — answers two different questions
depending on which consumer reads it. Neither reading is "wrong"; both are correct for the question
they answer:

| Reading  | Question it answers                                 | Consumer                                                                               | What `null` means there                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ALERTING | "should we warn that this balance is too negative?" | `isNegativeLimitExceeded` (`GET /overtime/:employeeId`, `GET /leave/overtime-balance`) | „unbegrenzt" — no limit is configured, so the warning never fires, no matter how negative the balance gets. This is the schema comment's own wording (`packages/db/prisma/schema.prisma`, `TenantConfig.maxNegativeBalanceMinutes`) and is unchanged by Phase 100. |
| BOOKING  | "may this OVERTIME_COMP request go through?"        | `POST /api/v1/leave/requests`, OVERTIME_COMP branch (`leave.ts:429`)                   | tolerance **0** — an unconfigured tenant grants no room beyond the confirmed carry-over.                                                                                                                                                                           |

D-00b is the decision that these two readings are allowed to diverge. **An empty „Max.
Minusstunden" field is therefore never "unlimited booking room"** — for the one write path that
enforces it (below), it means exactly the tolerance the gate applied before Phase 100 existed: none.
An unconfigured tenant sees byte-identical gate behaviour to pre-Phase-100.

### Which write path enforces it today — and which do not

**Enforced today:** `POST /api/v1/leave/requests`, OVERTIME_COMP branch only (`leave.ts:429`). A
request whose needed hours exceed confirmed carry-over + resolved tolerance is rejected with a 400
that names the applied tolerance in the German rejection copy. `GET /leave/overtime-balance`
(`leave.ts:1817`) exposes the identical resolved figure the gate enforces, so the request form's own
affordability display can never disagree with the server (D-15/D-16).

**Deliberately NOT enforced** (`100-CONTEXT.md`, Deferred Ideas — a separate, later product decision,
not an oversight of this phase):

- **Time-entry creation** (clock-in/out, manual entries) — an employee can still clock a day that
  pushes the balance past the configured tolerance; only an OVERTIME_COMP LEAVE request is gated.
- **Monatsabschluss** (month close) — closing a month never rejects based on this value.
- **Payout** — see the separate, unrelated floor below.

### The payout floor is a different, unconfigurable limit (D-03)

`overtime.ts:317` (`OVERDRAW_PREVENTED`) rejects any payout that would push the stored balance below
`0`. This is a SEPARATE, deliberately unconfigurable limit, untouched by Phase 100. A tenant with a
configured tolerance of, say, 10:00 Std. still cannot pay out into a negative balance — the tolerance
only ever governs whether an OVERTIME_COMP leave request may be booked, never a cash payout.

### The fail-safe branch applies zero tolerance (D-02)

When the gate's confirmed-carry-over read fails and the OVERTIME_COMP branch falls back to the
stored `OvertimeAccount.balanceHours` (`leave.ts:457`), the applied tolerance is forced to **0**
regardless of what is configured anywhere. Reason: a fail-safe must never be MORE generous than the
normal path — an error in the saldo read path must not silently widen the booking limit.
