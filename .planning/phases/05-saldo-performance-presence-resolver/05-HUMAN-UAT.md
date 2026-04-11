---
status: partial
phase: 05-saldo-performance-presence-resolver
source: [05-VERIFICATION.md]
started: 2026-04-11T00:00:00Z
updated: 2026-04-11T00:00:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Leave approval updates saldo
expected: Call PATCH /leave/requests/:id/review with { status: "APPROVED" } and verify OvertimeAccount.balanceHours changes before/after. Code wiring at leave.ts:735-741 confirmed correct.
result: [pending]

### 2. Bulk import updates saldo per employee
expected: Upload a CSV via POST /api/v1/imports/time-entries and verify each employee's balance is updated. Code wiring at imports.ts:182/225/237-241 confirmed correct.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
