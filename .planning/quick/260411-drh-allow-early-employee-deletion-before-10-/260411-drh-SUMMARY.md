---
phase: 260411-drh
plan: 01
subsystem: employees
tags: [gdpr, retention, hard-delete, audit, admin]
dependency_graph:
  requires: []
  provides: [forceDelete on hard-delete endpoint, retention-override acknowledgement UI]
  affects: [apps/api/src/routes/employees.ts, apps/web/src/routes/(app)/admin/employees/+page.svelte, apps/web/src/lib/api/client.ts]
tech_stack:
  added: []
  patterns: [zod optional body, $state forceDeleteAck, api.delete with body]
key_files:
  created: []
  modified:
    - apps/api/src/routes/employees.ts
    - apps/api/src/__tests__/employees.test.ts
    - apps/web/src/routes/(app)/admin/employees/+page.svelte
    - apps/web/src/lib/api/client.ts
decisions:
  - forceDelete only bypasses the retention check — the anonymize-first guard is always enforced
  - audit newValue captures both forceDelete flag and retentionExpiresAt so auditors can identify early overrides
  - UI submit button requires forceDeleteAck regardless — no implicit pass when already past retention window
metrics:
  duration: ~10 minutes
  completed: 2026-04-11
  tasks_completed: 2
  tasks_total: 3
  files_modified: 4
---

# Phase 260411-drh Plan 01: Allow Early Employee Deletion Before 10-Year Retention — Summary

**One-liner:** Optional `forceDelete` bypass on hard-delete endpoint with mandatory admin acknowledgement checkbox in the UI and audit trail flagging the override.

## What Was Built

### API changes (`apps/api/src/routes/employees.ts`)

- Defined `forceDeleteBodySchema = z.object({ forceDelete: z.boolean().optional() }).optional()` at the route level.
- In `DELETE /:id/hard-delete` handler: parse body with `forceDeleteBodySchema.parse(req.body ?? {}) ?? {}` — tolerates empty/missing body (existing callers unaffected).
- Anonymize-first guard (`firstName !== "Gelöscht"`) is unchanged and still blocks `forceDelete: true`.
- Retention check updated: `if (new Date() < retentionExpires && !forceDelete)` — only blocks when flag is absent.
- Audit call extended with `newValue: { forceDelete: forceDelete === true, retentionExpiresAt: retentionExpires.toISOString() }` for every HARD_DELETE, enabling auditors to identify overrides.

### Tests (`apps/api/src/__tests__/employees.test.ts`)

Four new vitest cases in `describe("DELETE /:id/hard-delete — forceDelete bypass")`:
1. Without `forceDelete`, returns 409 with `retentionExpiresAt` inside retention window.
2. With `{ forceDelete: true }`, returns 204 and employee row is deleted.
3. Audit entry after force-delete contains `forceDelete: true` and future `retentionExpiresAt`.
4. Non-anonymized employee returns 409 "Mitarbeiter muss zuerst anonymisiert werden" even with `forceDelete: true`.

### API client (`apps/web/src/lib/api/client.ts`)

- `api.delete` signature extended to accept optional `body?: unknown` parameter.
- When body is provided, it is JSON-stringified and sent in the request body (Content-Type header set automatically by the existing `request()` helper).

### UI changes (`apps/web/src/routes/(app)/admin/employees/+page.svelte`)

- Added `let forceDeleteAck = $state(false)` near other hard-delete state.
- `confirmHardDelete(emp)` resets `forceDeleteAck = false` when opening the modal.
- `doHardDelete()` passes `{ forceDelete: forceDeleteAck }` as body and resets `forceDeleteAck` on success.
- Cancel button handler resets `forceDeleteAck = false`.
- Modal body now shows a `<label class="force-delete-ack">` with checkbox and the exact German text:
  > "Ich bestätige, dass die gesetzliche Aufbewahrungsfrist (10 Jahre) noch nicht abgelaufen ist und ich die vorzeitige Löschung verantworte."
- "Endgültig löschen" button disabled with `!forceDeleteAck || hardDeleting`.
- Added `.force-delete-ack` CSS class using `var(--color-bg-subtle)`, `var(--color-border)`, `var(--color-text)` — no hardcoded hex colors.

## How to Reproduce the Verified Flow

1. Run `docker compose up --build -d`.
2. Log in as admin at `http://localhost:3000/admin/employees`.
3. Tick "Anonymisierte anzeigen" to show anonymized records.
4. Click "Endgültig löschen" on an anonymized employee row.
5. Verify the modal shows:
   - Existing warning paragraph (§ 147 AO / 10 Jahre).
   - New checkbox with the German confirmation text above.
   - "Endgültig löschen" button is **disabled** until checkbox is ticked.
6. Tick the checkbox — the button becomes enabled.
7. Click "Endgültig löschen" — employee disappears from list.
8. Verify in the audit log (AuditLog table or `/admin/audit`) that the HARD_DELETE entry has `newValue.forceDelete = true` and `newValue.retentionExpiresAt` in the future.
9. Open another employee's modal and confirm the checkbox starts **unchecked**.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- `apps/api/src/routes/employees.ts` — modified (forceDelete logic present).
- `apps/api/src/__tests__/employees.test.ts` — modified (4 new tests, all GREEN).
- `apps/web/src/routes/(app)/admin/employees/+page.svelte` — modified (checkbox + forceDeleteAck state).
- `apps/web/src/lib/api/client.ts` — modified (api.delete accepts optional body).
- Commits: `46a15bc` (API + tests), `11287e0` (UI + client).
