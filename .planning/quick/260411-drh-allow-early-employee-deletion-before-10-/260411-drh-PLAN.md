---
phase: 260411-drh
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/api/src/routes/employees.ts
  - apps/web/src/routes/(app)/admin/employees/+page.svelte
autonomous: false
requirements:
  - drh-01-allow-early-hard-delete-with-acknowledgement
must_haves:
  truths:
    - "Admin can hard-delete an already-anonymized employee before the 10-year retention period expires, but only when explicitly confirming override"
    - "Without the override confirmation, the existing retention guard still returns 409 with retentionExpiresAt"
    - "Every early (force) deletion is recorded in the audit log with a distinct marker so auditors can reconstruct the override"
    - "The override confirmation is a checkbox in the existing hard-delete modal, defaulting to unchecked, with the German text specified in the quick task context"
    - "The 'Endgültig löschen' button in the modal is disabled until both the existing intent is shown AND (only if not yet past retention) the override checkbox is checked"
  artifacts:
    - path: "apps/api/src/routes/employees.ts"
      provides: "DELETE /:id/hard-delete accepts optional { forceDelete: boolean } body, skips retention check when true, audits with forceDelete flag"
      contains: "forceDelete"
    - path: "apps/web/src/routes/(app)/admin/employees/+page.svelte"
      provides: "Hard-delete modal renders retention-override checkbox with required confirmation text; sends forceDelete flag to API"
      contains: "forceDelete"
  key_links:
    - from: "apps/web/src/routes/(app)/admin/employees/+page.svelte"
      to: "DELETE /api/v1/employees/:id/hard-delete"
      via: "api.delete(..., { body: { forceDelete: true } })"
      pattern: "forceDelete"
    - from: "apps/api/src/routes/employees.ts"
      to: "app.audit(...)"
      via: "audit newValue includes forceDelete flag and retentionExpiresAt for override"
      pattern: "forceDelete.*true"
---

<objective>
Allow admins to hard-delete an already-anonymized employee BEFORE the legal 10-year retention period (§ 147 AO / § 257 HGB) expires, provided they explicitly acknowledge responsibility for the early deletion via a confirmation checkbox.

Purpose: The existing hard-delete endpoint blocks every deletion inside the retention window. In rare cases (e.g., faulty test records, clearly non-payroll-relevant accounts) admins need a way to force-delete without waiting 10 years. The override must be explicit, auditable, and only possible through an admin-confirmed UI flow — all other revisionssicher rules (anonymize-first, audit log, etc.) remain unchanged.

Output:
- API: `DELETE /api/v1/employees/:id/hard-delete` accepts optional `{ forceDelete?: boolean }` body. When `forceDelete === true`, the retention check is bypassed but the audit entry flags the override.
- UI: The existing Schritt-2 "Endgültig löschen" modal in the admin employees page shows a retention-override checkbox with the exact German text from the quick task context. The "Endgültig löschen" button stays disabled until the checkbox is ticked, and the client sends `forceDelete: true` when confirmed.
</objective>

<execution_context>
@/Users/sebastianzabel/git/clokr/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastianzabel/git/clokr/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@apps/api/src/routes/employees.ts
@apps/web/src/routes/(app)/admin/employees/+page.svelte

<interfaces>
<!-- Relevant pieces extracted from the existing code. Executors should use these directly. -->

Current hard-delete endpoint (apps/api/src/routes/employees.ts, ~lines 535-606):

```ts
const DEFAULT_RETENTION_YEARS = 10;

app.delete("/:id/hard-delete", {
  schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
  preHandler: requireRole("ADMIN"),
  handler: async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);

    const employee = await app.prisma.employee.findUnique({
      where: { id, tenantId: req.user.tenantId },
      include: { user: true },
    });
    if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

    // Guard: must be already anonymized
    if (employee.firstName !== "Gelöscht") {
      return reply.code(409).send({ error: "Mitarbeiter muss zuerst anonymisiert werden" });
    }

    const retentionYears = DEFAULT_RETENTION_YEARS;
    const retentionStart: Date = employee.exitDate ?? employee.createdAt;
    const retentionExpires = new Date(
      retentionStart.getFullYear() + retentionYears, 11, 31, 23, 59, 59,
    );
    if (new Date() < retentionExpires) {
      return reply.code(409).send({
        error: "Aufbewahrungsfrist noch nicht abgelaufen",
        retentionExpiresAt: retentionExpires.toISOString(),
      });
    }

    await app.audit({
      userId: req.user.sub,
      action: "HARD_DELETE",
      entity: "Employee",
      entityId: id,
      oldValue: { employeeNumber: ..., userEmail: ..., retentionStart: ... },
      request: { ip: req.ip, headers: req.headers as Record<string, string> },
    });

    // Hard delete in correct order (breaks, timeEntries, leaveRequests, absences,
    // leaveEntitlement, workSchedule, overtimeAccount, employee, user)
  },
});
```

Existing modal (apps/web/src/routes/(app)/admin/employees/+page.svelte, ~lines 66-70, 281-299, 742-784):

```svelte
<!-- State -->
let showHardDeleteConfirm = $state(false);
let hardDeletingEmployee: Employee | null = $state(null);
let hardDeleting = $state(false);
let hardDeleteError = $state("");

function confirmHardDelete(emp: Employee) {
  hardDeletingEmployee = emp;
  hardDeleteError = "";
  showHardDeleteConfirm = true;
}

async function doHardDelete() {
  if (!hardDeletingEmployee) return;
  hardDeleting = true;
  hardDeleteError = "";
  try {
    await api.delete(`/employees/${hardDeletingEmployee.id}/hard-delete`);
    // ... reload + close modal
  } catch (e) {
    hardDeleteError = e instanceof Error ? e.message : "Fehler beim endgültigen Löschen";
  } finally {
    hardDeleting = false;
  }
}
```

Rules reminder from CLAUDE.md:
- Audit every mutation via `app.audit({ userId, action, entity, entityId, oldValue, newValue, request })`.
- Locked-month immutability, soft-delete semantics, and anonymize-first requirement MUST remain untouched.
- UI labels in German, code/comments in English.
- Theme colors via CSS custom properties — no hardcoded hex values.
- `api.delete` client helper lives in `apps/web/src/lib/api/client.ts` and supports a JSON body on DELETE requests.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: API — accept forceDelete flag on hard-delete with audit trail</name>
  <files>apps/api/src/routes/employees.ts, apps/api/src/__tests__/employees.test.ts</files>
  <behavior>
    - Test 1 (existing behavior preserved): POST an admin token and call `DELETE /employees/:id/hard-delete` WITHOUT a body on a freshly anonymized employee whose hireDate/exitDate is within the last 10 years → expect 409 and response body contains `retentionExpiresAt`.
    - Test 2 (early delete bypass): Same employee as Test 1, but call `DELETE /employees/:id/hard-delete` with body `{ forceDelete: true }` → expect 204 and the Employee row is gone (`prisma.employee.findUnique` returns null).
    - Test 3 (audit marker): After the successful force-delete in Test 2, the most recent `AuditLog` row for entity `Employee`/entityId of the deleted user has `action === "HARD_DELETE"`, and `newValue` (or `oldValue`) contains `forceDelete: true` plus the computed `retentionExpiresAt` ISO string, so auditors can identify overrides.
    - Test 4 (anonymize guard still active): Create a non-anonymized employee (firstName !== "Gelöscht") and call with `{ forceDelete: true }` → expect 409 "Mitarbeiter muss zuerst anonymisiert werden" (the override only bypasses the retention check, never the anonymize-first rule).
  </behavior>
  <action>
    Write the four vitest cases above in `apps/api/src/__tests__/employees.test.ts` first (RED), colocated with the existing hard-delete tests. Use the same `buildApp()` / seeding helpers that other employee tests use; do not invent new harness utilities. Run the suite and confirm the new tests fail for the right reasons.

    Then update `apps/api/src/routes/employees.ts` (the `DELETE "/:id/hard-delete"` handler only) to:
    1. Parse an optional body with Zod: `const forceBodySchema = z.object({ forceDelete: z.boolean().optional() }).optional();` then `const { forceDelete } = forceBodySchema.parse(req.body ?? {}) ?? {};` Tolerate an empty / missing body (existing callers send none).
    2. Keep the "must be already anonymized" guard exactly as-is — force-delete MUST NOT bypass it.
    3. Compute `retentionExpires` as today, then:
       - If `new Date() < retentionExpires && !forceDelete` → return existing 409 with `retentionExpiresAt` (unchanged behavior).
       - If `new Date() < retentionExpires && forceDelete === true` → proceed with deletion BUT enrich the audit entry.
    4. Extend the `app.audit({...})` call so that for every HARD_DELETE we record whether it was an override. Add a `newValue` field (or extend `oldValue`) with `{ forceDelete: forceDelete === true, retentionExpiresAt: retentionExpires.toISOString() }`. Keep the existing `oldValue` fields (`employeeNumber`, `userEmail`, `retentionStart`). This is the trail auditors need.
    5. Leave the transactional delete block, the 204 response, and all other routes untouched.

    Do NOT change the `DEFAULT_RETENTION_YEARS` constant, the anonymize endpoint, any other route, or the Prisma schema. Do NOT add new config env vars. Do NOT remove the retention check for callers who don't pass the flag — the normal path still returns 409.

    Run `pnpm --filter @clokr/api test -- employees` (or the narrowest matching pattern) until all four new cases are green and nothing else regresses.
  </action>
  <verify>
    <automated>docker compose exec api pnpm --filter @clokr/api test -- src/__tests__/employees.test.ts --run</automated>
  </verify>
  <done>
    - All four new test cases pass; pre-existing employee tests still pass.
    - `DELETE /employees/:id/hard-delete` returns 409 when body is empty and retention not expired (unchanged).
    - `DELETE /employees/:id/hard-delete` with `{ forceDelete: true }` returns 204 even inside the retention window, provided the employee is already anonymized.
    - AuditLog entry for the override contains `forceDelete: true` and `retentionExpiresAt`.
    - Anonymize-first guard still blocks force deletes on non-anonymized employees.
  </done>
</task>

<task type="auto">
  <name>Task 2: Web — retention-override checkbox in hard-delete modal</name>
  <files>apps/web/src/routes/(app)/admin/employees/+page.svelte</files>
  <action>
    Modify ONLY the hard-delete modal (Schritt 2) and the `doHardDelete` function in `apps/web/src/routes/(app)/admin/employees/+page.svelte`. Do not touch the anonymize flow, list rendering, filters, or styles outside of the modal.

    1. Add local Svelte 5 state near the other hard-delete state (around line 66-70):
       ```ts
       let forceDeleteAck = $state(false);
       ```
    2. In `confirmHardDelete(emp)`, reset it: `forceDeleteAck = false;`.
    3. In the cancel handler inside the modal footer, reset it: `forceDeleteAck = false;`.
    4. Update `doHardDelete()` to send the flag:
       ```ts
       await api.delete(`/employees/${hardDeletingEmployee.id}/hard-delete`, {
         body: { forceDelete: forceDeleteAck },
       });
       ```
       If the `api.delete` helper in `apps/web/src/lib/api/client.ts` does not already accept a body option, call it with a request-init style matching the existing helper signature (check the helper first; do NOT add a new method). If the helper truly cannot send a body, fall back to `fetch` via the same `api` module using the existing auth-aware primitive — do not reintroduce raw `fetch`.
    5. Inside the modal body (around line 755-767), after the existing `danger-hint` paragraph, render a checkbox block. Use existing `.form-field` / label conventions found elsewhere in the file — do NOT introduce new class names or inline hex colors:
       ```svelte
       <label class="form-check">
         <input type="checkbox" bind:checked={forceDeleteAck} />
         <span>
           Ich bestätige, dass die gesetzliche Aufbewahrungsfrist (10 Jahre)
           noch nicht abgelaufen ist und ich die vorzeitige Löschung verantworte.
         </span>
       </label>
       ```
       If `.form-check` does not already exist in this file or in `app.css`, reuse the same pattern as the "Anonymisierte anzeigen" toggle (`<label><input type="checkbox" bind:checked={...} /> …</label>`) — keep styling consistent with the file's existing patterns and use `var(--color-*)` tokens only.
    6. Make the "Endgültig löschen" button disabled while `!forceDeleteAck || hardDeleting` so the admin must tick the override before submitting. Label text stays "Endgültig löschen" / "Löschen…" as today.
    7. Keep all existing German copy; only ADD the checkbox line. Do not rewrite the existing warning paragraph.

    Language rules: UI text in German, code/comments in English. Theme colors must come from CSS custom properties. Do not hardcode hex.

    Svelte 5 reminder: use `$state`, `$derived`, `$props` correctly. `{@const}` is forbidden inside `<div>`. If you need a computed disabled value, use `$derived` or compute inline in the template.

    After editing, run the Svelte MCP `svelte-autofixer` on the modified file (or the modified snippet) until zero issues remain, as required by the project's Svelte MCP rules.
  </action>
  <verify>
    <automated>pnpm --filter @clokr/web exec svelte-check --tsconfig ./tsconfig.json</automated>
  </verify>
  <done>
    - `svelte-check` passes with no new errors/warnings for the edited file.
    - svelte-autofixer reports zero issues on the modified component.
    - Manual code review shows: state variable added, reset on open/cancel, checkbox rendered with the exact German text from the quick task context, submit button disabled until ticked, `api.delete` called with `{ forceDelete: forceDeleteAck }`.
    - No hardcoded hex colors introduced; CSS uses `var(--color-*)` tokens.
    - No regressions in anonymize flow, filters, or pagination.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Human verification — early-delete flow end-to-end</name>
  <what-built>
    API now accepts `{ forceDelete: true }` on `DELETE /employees/:id/hard-delete`, bypassing the 10-year retention check while still requiring anonymization first and writing a `HARD_DELETE` audit entry flagged as an override. The admin employees page modal shows a new retention-override checkbox with the required German confirmation text; the submit button is disabled until it is checked.
  </what-built>
  <how-to-verify>
    Preconditions: `docker compose up --build -d` is running.

    1. Log in as an admin at https://localhost (or the configured dev URL) and open /admin/employees.
    2. Tick "Anonymisierte anzeigen" so anonymized records are visible. Pick an already-anonymized test employee (firstName "Gelöscht"). If none exists, first create a throwaway employee, then use the "Anonymisieren" action to produce one.
    3. Click "Endgültig löschen" on that row. Verify the modal opens and:
       - Shows the existing warning paragraph about § 147 AO / 10 Jahre.
       - Shows a new checkbox with the text: "Ich bestätige, dass die gesetzliche Aufbewahrungsfrist (10 Jahre) noch nicht abgelaufen ist und ich die vorzeitige Löschung verantworte."
       - The "Endgültig löschen" button is DISABLED until the checkbox is ticked.
    4. Tick the checkbox, click "Endgültig löschen", confirm the employee row disappears from the list.
    5. Reload the page to confirm the record is gone (not just hidden).
    6. Open the audit log page (or query `AuditLog` directly via `docker compose exec db psql ...`) and confirm there is a `HARD_DELETE` entry for the deleted employee containing `forceDelete: true` and a `retentionExpiresAt` in the future (i.e. proof of override).
    7. Negative check: cancel out of the modal mid-way and confirm the checkbox resets the next time you open it for another employee.
    8. (Optional) From the browser devtools Network tab, confirm the DELETE request payload is `{"forceDelete": true}`.

    Report PASS if all steps match; otherwise describe which step failed.
  </how-to-verify>
  <resume-signal>Type "approved" or describe any issues that need fixing.</resume-signal>
</task>

</tasks>

<verification>
- `pnpm --filter @clokr/api test -- src/__tests__/employees.test.ts --run` green (four new cases + all pre-existing).
- `pnpm --filter @clokr/web exec svelte-check` green on the modified file.
- Manual flow in the running Docker stack matches Task 3 steps.
- AuditLog contains a HARD_DELETE row with `forceDelete: true` and `retentionExpiresAt` for the override deletion.
</verification>

<success_criteria>
- Admin can hard-delete an already-anonymized employee before the 10-year retention window, ONLY through explicit checkbox acknowledgement in the UI.
- Callers that omit the flag still hit the existing 409 "Aufbewahrungsfrist noch nicht abgelaufen" guard unchanged.
- Anonymize-first rule is still enforced regardless of `forceDelete`.
- Every override deletion is traceable via AuditLog with a `forceDelete: true` marker (Revisionssicherheit preserved).
- No regressions in the anonymize flow, employee list, filters, or pagination.
- No hardcoded hex colors introduced; Svelte 5 runes used correctly.
</success_criteria>

<output>
After completion, create `.planning/quick/260411-drh-allow-early-employee-deletion-before-10-/260411-drh-SUMMARY.md` documenting:
- What changed in the API (new optional body, retention bypass behind force flag, audit marker).
- What changed in the UI (new state, checkbox text, disabled submit logic).
- How to reproduce the verified flow for QA.
</output>
