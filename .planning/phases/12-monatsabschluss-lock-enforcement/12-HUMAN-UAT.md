---
status: complete
phase: 12-monatsabschluss-lock-enforcement
source: [12-VERIFICATION.md]
started: 2026-04-13T16:00:00.000Z
updated: 2026-04-13T18:30:00.000Z
---

## Current Test

[testing complete]

## Tests

### 1. Calendar lock icon rendering
expected: A small padlock SVG icon appears in calendar day cells for days that have locked time entries (CSS class `cal-lock-icon`, above the worked hours)
result: pass

### 2. Hidden edit/delete controls for locked entries
expected: In the list view, locked entries show no edit (pencil) or delete (trash) icon — the action cell is completely empty
result: pass

### 3. "Abgeschlossen" badge in month summary bar
expected: When any entry in the month is locked, a lock icon + "Abgeschlossen" label appears in the month summary bar after the Gesamt-Saldo section
result: pass

### 4. "Entsperren" button role gating
expected: The "Entsperren" button is visible for ADMIN/MANAGER users when the month is locked; it is NOT visible for EMPLOYEE users
result: pass

### 5. earlyClose:true response field on POST /close-month
expected: Calling `POST /api/v1/overtime/close-month` before the 15th of the following month returns `{ ..., earlyClose: true, gracePeriodEnds: "<ISO date of day 15>" }` in the response body
result: pass

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

