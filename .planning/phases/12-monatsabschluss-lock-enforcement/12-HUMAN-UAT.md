---
status: partial
phase: 12-monatsabschluss-lock-enforcement
source: [12-VERIFICATION.md]
started: 2026-04-13T16:00:00.000Z
updated: 2026-04-13T16:00:00.000Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Calendar lock icon rendering
expected: A small padlock SVG icon appears in calendar day cells for days that have locked time entries (CSS class `cal-lock-icon`, above the worked hours)
result: [pending]

### 2. Hidden edit/delete controls for locked entries
expected: In the list view, locked entries show no edit (pencil) or delete (trash) icon — the action cell is completely empty
result: [pending]

### 3. "Abgeschlossen" badge in month summary bar
expected: When any entry in the month is locked, a lock icon + "Abgeschlossen" label appears in the month summary bar after the Gesamt-Saldo section
result: [pending]

### 4. "Entsperren" button role gating
expected: The "Entsperren" button is visible for ADMIN/MANAGER users when the month is locked; it is NOT visible for EMPLOYEE users
result: [pending]

### 5. earlyClose:true response field on POST /close-month
expected: Calling `POST /api/v1/overtime/close-month` before the 15th of the following month returns `{ ..., earlyClose: true, gracePeriodEnds: "<ISO date of day 15>" }` in the response body
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
