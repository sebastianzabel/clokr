# Characterization Baseline — GitHub Issue #113 (T22)

## 1. Purpose and scope

This is the pre-rebuild characterization baseline for GitHub issue #113, taken **before** #99
(the context-cut, Block 1 of the v1.11.0 milestone) starts. It changes no behavior. It names the
two measured inputs it is derived from: `docs/context-coverage-baseline.md` (the generated per-
context, per-file coverage and test-count table, AC1) and
`apps/api/coverage/coverage-summary.json` / `apps/api/vitest-report.json` (the raw reports that
document was rendered from, at the same HEAD). This file is the curated counterpart: it names the
thin areas by number (AC2), adjudicates every filename-orphaned suspect and the ticket's own
`dashboard.ts`/`reports.ts` premise against those numbers, and states the Wave-3 shortlist and its
cap (D-06/D-08).

## 2. Pointer table

| Artifact                                                                              | Answers                                                                                                | Location                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/context-coverage-baseline.md`                                                   | AC1 — coverage per context area, per file, tests per file                                              | `docs/context-coverage-baseline.md` (generated, regenerate via the commands in its own header)                                        |
| `apps/api/baselines/saldo-path-parity-baseline.json` + `apps/api/baselines/README.md` | AC4 — reproducible before/after comparison of the four saldo compute paths (live, close, cron, recalc) | `apps/api/baselines/`                                                                                                                 |
| This file                                                                             | AC2 (thin areas named by number) / AC3 (characterization tests, filled by 113B-05)                     | `docs/characterization-baseline.md`                                                                                                   |
| The v1.11.0 GitHub milestone description                                              | AC5 — the safe-abort-point table (`Sichere Abbruchpunkte`)                                             | GitHub milestone 6 (`gh api repos/sebastianzabel/clokr/milestones`, filter to `number == 6`), also mirrored in `.planning/PROJECT.md` |

## 3. AC2 — thin areas, named by number

Suite-wide average line coverage (from `coverage-summary.json`'s own `total` entry): **84.35%**
(8304/9844 lines), branches **70.62%** (4997/7075). Per-area line/branch coverage, measured at the
same HEAD as `docs/context-coverage-baseline.md` (`a979789a0ebf80f85e5b09bff7411202f002c36a`):

| Area             | Files | Lines % | Branches % | vs. suite-wide line average (84.35%) |
| ---------------- | ----- | ------- | ---------- | ------------------------------------ |
| unterbau         | 32    | 71.0%   | 60.1%      | **below** (-13.4pp)                  |
| zeiterfassung    | 19    | 77.0%   | 69.7%      | **below** (-7.4pp)                   |
| abwesenheiten    | 26    | 88.4%   | 77.6%      | above (+4.0pp)                       |
| schichtplanung   | 16    | 92.5%   | 69.7%      | above (+8.2pp)                       |
| arbeitszeitkonto | 19    | 91.6%   | 80.6%      | above (+7.3pp)                       |
| rahmen           | 9     | 92.6%   | 79.2%      | above (+8.3pp)                       |
| komposition      | 3     | 85.2%   | 61.7%      | above (+0.9pp)                       |

The two thinnest areas by line coverage are **unterbau** (71.0%) and **zeiterfassung** (77.0%) —
both below the suite-wide average, and both meaningfully below every other area. This is a number,
not a guess: `docs/context-coverage-baseline.md` Table 1, cross-checked against
`coverage-summary.json`'s own `total` entry in the same document.

### Every file below its own area's average (33 of 124 files)

D-05 is binding here: **no row below cites a missing test-file name as evidence.** Every number is
`docs/context-coverage-baseline.md` Table 2's own line/branch percentage for that file, and every
row is placed by comparing that number against its own area's average from the table directly
above — never by whether a same-named test file exists.

| Area             | File                                         | Lines % | Branches % | Area avg (lines) |
| ---------------- | -------------------------------------------- | ------- | ---------- | ---------------- |
| unterbau         | `src/routes/activity.ts`                     | 2.2%    | 0.0%       | 71.0%            |
| unterbau         | `src/routes/invitations.ts`                  | 10.5%   | 0.0%       | 71.0%            |
| unterbau         | `src/routes/holidays.ts`                     | 24.0%   | 1.9%       | 71.0%            |
| unterbau         | `src/plugins/data-retention.ts`              | 40.7%   | 16.7%      | 71.0%            |
| unterbau         | `src/plugins/mailer.ts`                      | 45.5%   | 69.4%      | 71.0%            |
| unterbau         | `src/routes/api-keys.ts`                     | 53.8%   | 12.5%      | 71.0%            |
| unterbau         | `src/routes/auth.ts`                         | 55.4%   | 52.9%      | 71.0%            |
| unterbau         | `src/plugins/school-holidays-sync.ts`        | 60.9%   | 62.5%      | 71.0%            |
| unterbau         | `src/routes/me.ts`                           | 62.5%   | 27.5%      | 71.0%            |
| unterbau         | `src/routes/audit-logs.ts`                   | 66.7%   | 50.0%      | 71.0%            |
| unterbau         | `src/routes/avatars.ts`                      | 68.5%   | 57.7%      | 71.0%            |
| zeiterfassung    | `src/services/clock/types.ts`                | 0.0%    | 0.0%       | 77.0%            |
| zeiterfassung    | `src/services/clock/consolidate.ts`          | 37.0%   | 42.9%      | 77.0%            |
| zeiterfassung    | `src/routes/admin-presence-sources.ts`       | 52.3%   | 38.3%      | 77.0%            |
| zeiterfassung    | `src/plugins/attendance-checker.ts`          | 52.5%   | 51.4%      | 77.0%            |
| abwesenheiten    | `src/routes/company-shutdowns.ts`            | 50.9%   | 35.3%      | 88.4%            |
| abwesenheiten    | `src/utils/find-karenz-overrun-days.ts`      | 76.9%   | 86.2%      | 88.4%            |
| abwesenheiten    | `src/routes/leave.ts`                        | 85.3%   | 70.2%      | 88.4%            |
| abwesenheiten    | `src/plugins/vocational-school-generator.ts` | 85.7%   | 75.0%      | 88.4%            |
| abwesenheiten    | `src/plugins/carryover-warning.ts`           | 85.9%   | 81.5%      | 88.4%            |
| abwesenheiten    | `src/routes/special-leave.ts`                | 86.0%   | 66.7%      | 88.4%            |
| schichtplanung   | `src/plugins/scheduler.ts`                   | 70.8%   | 50.0%      | 92.5%            |
| schichtplanung   | `src/services/phorest/__tests__/helpers.ts`  | 87.5%   | 61.5%      | 92.5%            |
| schichtplanung   | `src/routes/integrations.ts`                 | 87.6%   | 69.7%      | 92.5%            |
| schichtplanung   | `src/routes/shifts.ts`                       | 91.8%   | 68.3%      | 92.5%            |
| arbeitszeitkonto | `src/routes/overtime.ts`                     | 78.6%   | 69.6%      | 91.6%            |
| arbeitszeitkonto | `src/utils/close-month-data.ts`              | 88.9%   | 50.0%      | 91.6%            |
| rahmen           | `src/config.ts`                              | 70.0%   | 40.0%      | 92.6%            |
| rahmen           | `src/utils/crypto.ts`                        | 82.8%   | 50.0%      | 92.6%            |
| rahmen           | `src/middleware/auth.ts`                     | 87.0%   | 81.3%      | 92.6%            |
| rahmen           | `src/app.ts`                                 | 89.6%   | 60.9%      | 92.6%            |
| rahmen           | `src/utils/test-database.ts`                 | 92.1%   | 89.1%      | 92.6%            |
| komposition      | `src/utils/pdf.ts`                           | 82.1%   | 67.3%      | 85.2%            |

Reproduce this table: `docs/context-coverage-baseline.md` Table 1 (area averages) and Table 2
(per-file numbers) — compare each file's own line % against its own area's average row.

## 4. The nine suspects — an explicit verdict each

Two of the nine were already refuted during research: `special-leave.ts` is exercised by
`sec-05-special-leave-put-tenant.test.ts` / `sec-06-special-leave-delete-tenant.test.ts` (plus
`leave-config.test.ts`), and `avatars.ts` by `sec-08-avatars-post-tenant.test.ts` /
`sec-09-avatars-delete-tenant.test.ts` — both under differently-named test files, neither of them
named `special-leave.test.ts` or `avatars.test.ts`. **The list is demonstrably NOT a gap list
(D-20).** Every "test files" cell below was found by grepping the actual API request URL
(`/api/v1/<route-prefix>`) inside `apps/api/src/**/__tests__/*.test.ts` — never by filename
similarity to the suspect's own name.

| File                      | Area           | Lines % | Branches % | Test files that actually exercise it (content search)                                                                                                                                                                                                                                                                                                 | Verdict     |
| ------------------------- | -------------- | ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `retro-entry-requests.ts` | zeiterfassung  | 88.2%   | 72.4%      | `retro-approval-flow.test.ts`, `retro-entry-first.test.ts`, `retro-entry-saldo.test.ts`, `time-entries.test.ts`, `services/clock/__tests__/resolver-invalid-entry.integration.test.ts`                                                                                                                                                                | **COVERED** |
| `activity.ts`             | unterbau       | 2.2%    | 0.0%       | none found — zero test file calls `/api/v1/activity` anywhere in the suite                                                                                                                                                                                                                                                                            | **THIN**    |
| `section9-documents.ts`   | abwesenheiten  | 91.1%   | 81.6%      | `section9-upload.test.ts` (13+ calls against `/api/v1/section9-documents/:id`), `section9-model.test.ts`                                                                                                                                                                                                                                              | **COVERED** |
| `special-leave.ts`        | abwesenheiten  | 86.0%   | 66.7%      | `sec-05-special-leave-put-tenant.test.ts`, `sec-06-special-leave-delete-tenant.test.ts`, `leave-config.test.ts`                                                                                                                                                                                                                                       | **COVERED** |
| `shift-patterns.ts`       | schichtplanung | 97.3%   | 65.4%      | `shifts.test.ts` (`/api/v1/shift-patterns/tenant`, 4 calls)                                                                                                                                                                                                                                                                                           | **COVERED** |
| `avatars.ts`              | unterbau       | 68.5%   | 57.7%      | `sec-08-avatars-post-tenant.test.ts`, `sec-09-avatars-delete-tenant.test.ts`, `section9-upload.test.ts`, `anonymize-helper.test.ts`                                                                                                                                                                                                                   | **COVERED** |
| `api-keys.ts`             | unterbau       | 53.8%   | 12.5%      | `release-notes.test.ts` (2 calls against `/api/v1/api-keys`, incidental to that file's own subject — no dedicated api-keys test)                                                                                                                                                                                                                      | **THIN**    |
| `invitations.ts`          | unterbau       | 10.5%   | 0.0%       | none found — `invitations.ts` exposes exactly one route (`POST /accept`); no test file ever calls `/api/v1/invitations/accept`. (The `resend-invitation` calls in `tenant-isolation.test.ts` hit `POST /employees/:id/resend-invitation`, which lives in `routes/employees.ts`, NOT `routes/invitations.ts` — confirmed by reading both route files.) | **THIN**    |
| `audit-logs.ts`           | unterbau       | 66.7%   | 50.0%      | `tenant-isolation.test.ts` (`GET /api/v1/audit-logs?limit=200`)                                                                                                                                                                                                                                                                                       | **COVERED** |

Verdict rule, stated explicitly: a suspect is **THIN** when it has no test coverage worth the name
(under ~55% lines, and in every actual THIN case here, genuinely zero content-search hits for its
own endpoint) — **COVERED** when line coverage is substantial (≥~65%) and at least one test file
demonstrably exercises its actual route(s) by URL, even where that coverage sits marginally below
its context area's own average (`special-leave.ts`, `avatars.ts`, `audit-logs.ts` are all in that
shape: real, substantial coverage, just not the area's best-covered file). Three of the nine —
`activity.ts`, `api-keys.ts`, `invitations.ts` — are **THIN** by this rule, all three in
`unterbau`, all three confirmed by an explicit "no content-search hit" check, not merely a low
percentage.

## 5. `dashboard.ts` / `reports.ts` — the ticket's premise, adjudicated (D-07)

The ticket's assumption, verbatim (issue #113 acceptance criteria): "Bereiche mit dünner Abdeckung
sind benannt — insbesondere `dashboard.ts` und `reports.ts` (zusammen 3081 Zeilen, komponieren über
11 bzw. 7 Modelle)." — i.e. the ticket suspects these two files are thinly covered.

Measured (komposition area, `docs/context-coverage-baseline.md` Table 2):

| File                      | Lines total | Lines covered | Lines % | Branches total | Branches covered | Branches % |
| ------------------------- | ----------- | ------------- | ------- | -------------- | ---------------- | ---------- |
| `src/routes/dashboard.ts` | 381         | 325           | 85.3%   | 302            | 180              | 59.6%      |
| `src/routes/reports.ts`   | 469         | 408           | 87.0%   | 330            | 207              | 62.7%      |

Content-search-confirmed test files (never by filename similarity):

- **dashboard.ts**: `routes/__tests__/dashboard.test.ts`, `routes/__tests__/dashboard-overtime-trend.test.ts`,
  `__tests__/dashboard-open-items.test.ts`, `__tests__/dashboard-open-items-break.test.ts`,
  `__tests__/dashboard-open-items-window.test.ts`, `__tests__/dashboard-overtime-overview-n1.test.ts`,
  `__tests__/open-items-close-month-parity.test.ts`, plus incidental coverage from `__tests__/leave.test.ts`
  and `routes/__tests__/reports.test.ts` — 9 files touch dashboard behavior in total, 7 of them dedicated.
- **reports.ts**: `routes/__tests__/reports.test.ts`, `__tests__/reports-sick-days.test.ts`, plus incidental
  coverage from `__tests__/carryover-warning.test.ts` — 3 files.

**Verdict: the premise is refuted as stated, but not fully.** Line coverage (85.3% / 87.0%) is
well above the suite-wide average (84.35%) and above six of the seven context areas' own averages
— this is not "thin" in any sense the ticket's own 3081-line/18-model framing implies, and it is
backed by a wide, dedicated test surface (9 dashboard-related files, 3 reports-related files), not
none. **But branch coverage is genuinely comparatively weak** (59.6% / 62.7%, both below the
suite-wide branch average of 70.62%, and both the lowest branch percentages in the komposition
area alongside `pdf.ts`'s 67.3%) — the composition layer's own conditional logic (which of the 11
resp. 7 read models actually gets merged into a given response, under which combination of
tenant-config toggles and schedule types) is exercised less thoroughly than its line count alone
suggests. D-07's own framing — "eine Annahme, kein Nachweis" — is settled: the Nachweis says
**not a coverage gap on lines, worth a closer look on branches**, which is a different and more
precise finding than the ticket's blanket suspicion.

## 6. The D-06 shortlist

A file qualifies only if it passes BOTH: (a) below-average line coverage inside its own context
area (Section 3's table above), AND (b) is named in #99's cross-context-access list or #100's
concrete call-direction-change list — never #99's blanket "every `routes/`/`utils/`/`plugins/`
file moves" fact alone, because #99's own acceptance criteria call that move a "reine
Verschiebung: keine Verhaltensänderung" — a file that only relocates cannot break by construction,
so relocation alone does not create the risk D-06 exists to bound. The risk is in **rewired call
direction** — #100's concrete list is the only source used for (b) here.

#100's named cross-context accesses: `shifts.ts` → `leaveRequest` (5×) / `absence` (5×) (confirmed:
`prisma.leaveRequest.findFirst`/`findMany` at `shifts.ts:163,890,1300,2464,2823` and
`prisma.absence.findFirst`/`findMany` at `shifts.ts:182,905,1323,2480,2833`), `dashboard.ts` →
`leaveRequest` (6×), `leave.ts` → `shift` (3×, confirmed: `shift.findMany`/`updateMany` at
`leave.ts:1420,1431,3818,3974`) / `leave.ts` → `timeEntry` (confirmed: `timeEntry.updateMany` at
`leave.ts:990,1972`), and `utils/leave-check.ts` (named for its display-name-as-control-value fix,
not a cross-context read).

### Qualifies (both (a) and (b))

| File                   | Area           | Lines % (own area avg) | Named by | Behavior a characterization test would pin                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------- | ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/shifts.ts` | schichtplanung | 91.8% (92.5%)          | #100     | Whether creating/assigning a `Shift` for an employee with an overlapping approved `LeaveRequest`/`Absence` is correctly flagged as a conflict (`shifts.ts:163-194`'s `classifyLeaveTypeCode` conflict path), and whether Soll/staffing calculations that read `leaveRequest`/`absence` (`shifts.ts:890-905, 1300-1323, 2464-2480, 2823-2833`) currently exclude those days the same way in every call site. |
| `src/routes/leave.ts`  | abwesenheiten  | 85.3% (88.4%)          | #100     | Whether an APPROVED→CANCELLED leave transition currently revalidates the employee's `TimeEntry` rows for the affected range exactly as today (`leave.ts:1972`'s `timeEntry.updateMany`), and whether leave approval currently cancels/updates conflicting `Shift` rows exactly as today (`leave.ts:1420-1431`).                                                                                             |

### Considered and excluded

| File                       | Area          | Reason excluded                                                                                                                                                                                                                                                                       |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/dashboard.ts`  | komposition   | Named by #100 (b), but line coverage (85.3%) is marginally ABOVE its own area's average (85.2%, precise: 967/1135 = 85.20% vs. dashboard's own 325/381 = 85.30%) — fails (a). Its weak branch coverage (59.6%) is noted in Section 5 but is not, on its own, the criterion D-06 uses. |
| `src/utils/leave-check.ts` | abwesenheiten | Named by #100 (b) for its display-name-as-control-value fix, but is already 100% line/branch covered — fails (a) outright; nothing about it is thin.                                                                                                                                  |

## 7. The D-08 cap, stated with its reason

> **At most 3 files, in at most 2 new test files, with at most 15 new tests.**

Reason: characterization is open-ended upward. Without a cap the gate before Block 1 becomes its
own milestone, which defeats the purpose of a gate. Three files is what fits one execution plan
inside its context budget while leaving room for the D-13 mutation proof on every single test. The
D-06 shortlist above names exactly 2 qualifying files (`shifts.ts`, `leave.ts`) — both fit inside
the 3-file cap with one file of headroom to spare; no file needs to be deferred for capacity
reasons this round.

### Deferred

No file from the D-06 shortlist itself is deferred (both qualifying files fit under the cap). Per
the CONTEXT's own deferred idea ("Die neun Verdachtsfälle wirklich abdecken"): the three genuinely
THIN suspects from Section 4 (`activity.ts`, `api-keys.ts`, `invitations.ts`) do **not** qualify
for the D-06 shortlist — none of them is named by #99–#101's concrete cross-access/call-direction
list, so per D-06 ("eine dünn getestete Datei, die der Umbau nicht anfasst, kann nicht durch den
Umbau brechen") they are out of this phase's scope by design, not by the cap. If their thinness
should be closed, that is its own ticket, not carried along here.

## AC3 — characterization tests written

_(filled by plan 113B-05)_

## D-13 mutation proof evidence

_(filled by plan 113B-05)_

## D-12 findings (issues filed)

_(filled by plan 113B-05)_
