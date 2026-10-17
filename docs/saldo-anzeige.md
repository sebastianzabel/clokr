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
  (`getConfirmedCarryOver` / `getConfirmedCarryOverBulk` in `apps/api/src/contexts/working-time-account/confirmed-saldo.ts`
  — the same chain Phase 98's audit walks and verifies, so both features share one source of truth).
  Stable, legally defensible as the entitlement figure. It only moves at Monatsabschluss.
- **„Laufender Monat (Prognose)"** — everything accrued since that last close (the wording itself follows
  the data, see the next paragraph). It is **derived by
  subtraction** (`total − confirmed`) at exactly one place
  (`computeOvertimeBalanceBreakdown` in `apps/api/src/contexts/time-tracking/api/time-entries.ts`), never computed
  independently. This guarantees the two figures always sum to exactly the total the app has always
  shown, and avoids creating a second computation path for the same value — the same shape whose
  violation is why Phase 98 (saldo chain integrity audit) exists in the first place.

**The forecast is worded from the data (Issue #588).** "The open month" is a simplification: the forecast
covers everything **since the last Monatsabschluss** — the current calendar month when the tenant closes
every month, several months when it has stopped closing. Every surface therefore words the forecast from
`unconfirmedMonths`: the number of months from the first open day through the current month, inclusive. It is
computed in `computeOvertimeBalanceBreakdown` (the same place that derives the forecast by subtraction; it
computes no figure differently, the field only reports a count). The rule has three cases:

| `unconfirmedMonths`              | closed month exists | Label                             | Caption under the total               |
| -------------------------------- | ------------------- | --------------------------------- | ------------------------------------- |
| exactly 1                        | any                 | „Laufender Monat (Prognose)“      | „inkl. laufendem Monat“               |
| more than 1                      | yes                 | „Seit Monatsabschluss (Prognose)“ | „inkl. Zeitraum seit Monatsabschluss“ |
| more than 1, or unknown (`null`) | no                  | „Prognose (seit Eintritt)“        | „inkl. Zeitraum seit Eintritt“        |

An unknown value never claims the running month; it is decided by `hasClosedMonth` alone. A column whose rows
disagree reads „Prognose (offener Zeitraum)“ (`FORECAST_LABEL_MIXED`). On the first day of a month after a
month that was not closed yet, the count is 2 (the finished month plus the new one), so the label correctly
says „Seit Monatsabschluss“.

The wording is chosen in exactly one place, `apps/web/src/lib/saldo/forecast-label.ts` (`forecastLabel`,
`forecastColumnLabel`, `forecastCaption`); `SaldoAnzeige`, `KontoSaldoCard`, the team table and every page
call it with both facts (`unconfirmedMonths`, `hasClosedMonth`). The endpoints that carry the value, all
additive: the rows of `GET /dashboard/overtime-overview`, `GET /dashboard` (own `overtime` block),
`GET /overtime/:employeeId` and the visible branches of `GET /leave/overtime-balance` (the masked branch,
`balanceVisible: false`, carries no key). `team-saldo-one-place-588.test.ts` fails when the two literals
appear anywhere else in the web or when a forecast call site does not pass the value.

**No closed month yet** (new hire): `confirmed = 0`, flagged explicitly as "noch kein
Monatsabschluss" rather than a genuine 0h entitlement, so it cannot be misread as "you have zero
overtime" the way a plain `0` would.

## Why the forecast moves — both directions

The forecast is not simply "uncertain", it moves for two distinct, opposite reasons, both rooted in
the SHIFT_BASED roster-proration formula (`calcShiftBasedSaldo()` in
`apps/api/src/contexts/working-time-account/shift-based-saldo.ts` — unchanged by this phase):

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

## Team saldo figures (Issue #588)

One web module, `apps/web/src/lib/reports/team-saldo.ts`, is the ONLY place the team median, the Top 5 plus /
Top 5 minus and the outlier rule live. `/reports` (the „Median-Saldo“ KPI and the Überstunden-Übersicht) and the
dashboard card „Salden“ both read it; no page computes a median, a mean over row saldi or an exclusion of its own.

- **Source.** The rows of `GET /dashboard/overtime-overview` (the two gates `team-overview:read` AND
  `overtime:read`, reach and salon filter unchanged). Three additive row fields feed the module:
  `hasRecordedTime` (a valid, closed, non-deleted WORK entry on or after hire, one bulk read through the
  time-tracking facade `employeesWithValidWorkSince`), `trackOnly` (the #494 rule of the contract valid today,
  reported from the breakdown) and `unconfirmedMonths` (see above; `null` when the live saldo is unavailable).
- **Value.** The total (`balanceHours`, confirmed plus forecast) of a person; Top 5 plus are the five highest
  positive totals, Top 5 minus the five lowest negative ones. A person with a total of exactly 0 is in neither list; ties are broken by name, then id.
- **Median.** The team figure is the median of the counted totals (the middle value; for an even count the mean of the two middle
  values rounded to whole minutes), not the arithmetic mean: one extreme person does not move it. An empty counted set has
  no median.
- **Outlier rule (D-588-2, P-03, P-04).** A person counts for the median and the Top lists only if all of these
  hold: the row belongs to the team employed today (a row of the exited section, `exitedWithOpenFinalSaldo`, is
  neither counted nor listed; it keeps its own section on `/reports`, #613), the server delivered a live saldo
  (`openMonthMinutes` is not `null`), the contract in force is not track-only (`trackOnly` is not true, #494) and the
  person has recorded time since hire (`hasRecordedTime` is not false). A fact the server did not send (an older
  cached answer) never excludes anyone. The others are not dropped silently; each is listed with exactly one
  reason, in this precedence: „Saldo nicht verfügbar“ (`SALDO_UNAVAILABLE`), „nur Zeiterfassung“
  (`TIME_TRACKING_ONLY`), „ohne Erfassung“ (`NO_RECORDED_TIME`). The code is the control value, the German text
  display only (`TEAM_SALDO_EXCLUSION_LABEL`).
- **Format.** Every saldo is ±H:MM through `fmtBalance` (`lib/utils/format-minutes.ts`; sign always shown, U+2212
  for a minus, an exact zero reads „±0:00“, also in every `SaldoAnzeige` variant). The overview table has one
  column per value: Abgeschlossen · forecast (header from `forecastColumnLabel`) · Gesamt.
- **Verlauf.** The former „Verlauf“ column (a sparkline over `snapshots`) is gone; it needed two closed months and
  was empty in practice. The API still sends `snapshots` per row; the period report of #612 shows opening and
  closing saldo instead.
- **Dashboard card.** At the top of the team area: diverging horizontal bars (plus right, minus left of a zero line,
  axis title „Stunden“, no smoothing, colours from `getChartTheme()`), the same persons as a linked list (each links
  to the person's team time entries when the caller may open that page), the median and the excluded persons.
  It loads after the team block and never blocks it; a 403 or a missing right hides it without a request.
- **Guard.** `apps/web/src/__tests__/team-saldo-one-place-588.test.ts` walks the non-test web sources and fails on a
  second median, a mean over row saldi, the forecast literals outside the helper, a forecast call site without the
  value, and a team surface that does not read the module.

Nothing in this section changes a saldo: the module only selects, orders and formats figures the API already
computed.

## PDF export and Berichte

The exported Stundennachweis (single-employee) and Monatsexport (all persons of a month; Issue #617, it replaced the former company-wide PDF), `apps/api/src/composition/reports.ts`

- `apps/api/src/composition/pdf.ts`) and the Kalender-Header/Berichte screens do **not** show the lifetime
  split described above — they show a single, MONTH-scoped Monats-Saldo. Since Issue #451 (D-03),
  `reports.ts` computes NO Soll/Ist/Überstunden of its own any more: the JSON row, the single-employee
  PDF and the Monatsexport all read the same result from
  **`computeMonthReportFigures(app, employeeId, year, month)`**
  (`contexts/working-time-account/month-saldo.ts`, exported via that context's `index.ts`) —
  a CLOSED month returns the stored `SaldoSnapshot` verbatim (`basis: "snapshot"`), an OPEN,
  fully-elapsed month returns the saldo core's own full-month figure (`basis: "fullMonth"`), and
  the current running month returns the saldo core's to-date header (`basis: "toDate"` — SHIFT_BASED
  always takes this branch, since its Soll is roster-based and the not-yet-worked roster must never
  be counted). This closes Issue #451's two literal examples: a FIXED_SCHEDULE 40h Mon–Fri
  employee's May 2026 report now shows `shouldHours` 144, not the old `{day}Hours`-walk's 168 (a
  Monday public holiday was never deducted); a SHIFT_BASED employee's report shows the roster-based
  Soll, not the placeholder walk's 208. This figure has no lifetime counterpart to split against —
  forcing a lifetime "Bestätigt" line into a month-scoped figure would fabricate a key figure that
  was never there. Instead, the figure is **relabelled** using the same two words: a CLOSED month is
  labelled with `OVERTIME_LABEL_CONFIRMED` ("Überstunden (Bestätigt)"), an OPEN month with
  `OVERTIME_LABEL_FORECAST` ("Überstunden (Prognose)") — both exported from `pdf.ts` so the wording
  cannot drift between the single-employee generator and the Monatsexport renderer; `figures.labelled`/
  `figures.basis === "snapshot"` from `computeMonthReportFigures` decides which applies.
- **Verrechnung (D-03 page identity, Issue #451)**: whenever the working-time-account's own
  reconciliation item is non-zero — an approved Überstundenausgleich withdrawal, or a SHIFT_BASED
  § 615 BGB under-/overtime adjustment — both PDFs additionally print a `Verrechnung: <+/-x.xx> h`
  line (single-employee summary box) or a `Verr.` column (Monatsexport table, only when some row has a value), fed by
  `figures.balanceAdjustmentMinutes` from the SAME `computeMonthReportFigures` call, with an
  explaining legend (`BALANCE_ADJUSTMENT_LABEL`/`BALANCE_ADJUSTMENT_LEGEND` in `pdf.ts`). The
  printed arithmetic always closes: **Ist − Soll + Verrechnung = Überstunden**; when there is no
  reconciliation item (`balanceAdjustmentHours == 0`), the simpler Ist − Soll = Überstunden holds
  exactly and the line/column is omitted.

One population is deliberately given **neither** overtime label: a `MONTHLY_HOURS` schedule with no monthly
budget (`monthlyHours` null/0) has no Soll target at all — the screen already shows a dedicated
„Keine Soll-Vorgabe" state for it, and its exported figure never moves. Labelling it "Prognose"
would be a fabrication (there is nothing being forecast) and a screen-vs-export contradiction, so
`computeMonthReportFigures` resolves `labelled: false` for this population and the PDF renderer
omits the label — and, on the Monatsexport table, shows the status „ohne Soll“ with dashes for Soll, Saldo and Gesamtsaldo — for it.

Because the Monatsexport lists many employees at once and month-close happens **per employee**,
one export can legitimately mix confirmed and provisional rows. A document-level label would be
wrong, so each row carries its own Status cell („Bestätigt“, „Prognose“ or „ohne Soll“), and a single
legend line (`MONTHLY_EXPORT_FORECAST_LEGEND`) is printed once at the end of the table, only when at
least one row is a forecast.

The PDF wording constants (`OVERTIME_LABEL_CONFIRMED`, `OVERTIME_LABEL_FORECAST`, `MONTHLY_EXPORT_FORECAST_LEGEND`)
are unchanged by Issue #588: a PDF row is month-scoped, so „Prognose“ there never claims or denies the running month.

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
- All ten `node-cron` registrations in `apps/api/src/contexts/time-tracking/plugins/attendance-checker.ts` were read; their
  eleven `notify()` call sites (missing entries, clock-out reminders, break compliance, etc.) are
  unrelated to saldo comparisons.
- `CARRYOVER_EXPIRING` (`apps/api/src/contexts/absence/plugins/carryover-warning.ts`) is the BUrlG vacation-**day**
  expiry warning — a completely different domain (Urlaubsanspruch, not Überstunden).
- `TenantConfig.emailOnOvertimeWarning` is a config field with **no emitter anywhere** — no code
  path constructs a notification whose type this toggle would gate. This was already documented as
  a dead toggle in `apps/api/src/contexts/platform/plugins/notify.ts` before this phase; Phase 97-02 added a
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
`apps/api/src/contexts/working-time-account/negative-balance-tolerance.ts`):

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
