---
phase: 260410-idv
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/api/src/routes/reports.ts
autonomous: true
requirements:
  - QUICK-260410-idv
must_haves:
  truths:
    - "GET /api/v1/reports/monthly returns no rows for anonymized (DSGVO-deleted) employees"
    - "GET /api/v1/reports/datev (DATEV LODAS export) contains no lines for anonymized employees"
    - "Active employees (user.isActive === true) continue to appear in both reports exactly as before"
  artifacts:
    - path: "apps/api/src/routes/reports.ts"
      provides: "Monthly and DATEV report routes that filter out anonymized employees"
      contains: "user: { isActive: true }"
  key_links:
    - from: "apps/api/src/routes/reports.ts (GET /monthly handler)"
      to: "prisma.employee.findMany where clause"
      via: "user: { isActive: true } relation filter"
      pattern: "user:\\s*\\{\\s*isActive:\\s*true\\s*\\}"
    - from: "apps/api/src/routes/reports.ts (GET /datev handler)"
      to: "prisma.employee.findMany where clause"
      via: "user: { isActive: true } relation filter"
      pattern: "user:\\s*\\{\\s*isActive:\\s*true\\s*\\}"
---

<objective>
Exclude anonymized (DSGVO-deleted) and inactive employees from the Monthly report and DATEV LODAS export in `apps/api/src/routes/reports.ts`.

Purpose: After DSGVO anonymization, `User.isActive` is set to `false` and the employee's personal data is scrubbed. These employees must not appear in the Monthly report or DATEV export — otherwise reports contain placeholder rows for "Gelöscht / GELÖSCHT-XXX" employees and export files ship anonymized stubs to payroll. The overtime routes already handle this via `user: { isActive: true }` filter; reports must match the same pattern.

Output: `reports.ts` with two `where` clauses extended by `user: { isActive: true }` — one for `/monthly`, one for `/datev`. No other behavior changes.
</objective>

<execution_context>
@/Users/sebastianzabel/git/clokr/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastianzabel/git/clokr/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@apps/api/src/routes/reports.ts
@apps/api/src/routes/overtime.ts

<interfaces>
<!-- Reference pattern already in use in overtime.ts (line 178-188) -->
<!-- Executor should use this exact shape in reports.ts — no codebase exploration needed. -->

Reference pattern from apps/api/src/routes/overtime.ts (GET /team-week handler, ~line 178):
```ts
const employees = await app.prisma.employee.findMany({
  where: {
    tenantId,
    user: { isActive: true },
  },
  include: {
    user: { select: { isActive: true } },
    workSchedules: { orderBy: { validFrom: "desc" } },
  },
  orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
});
```

Current shape in apps/api/src/routes/reports.ts (GET /monthly handler, ~line 30):
```ts
const employees = await app.prisma.employee.findMany({
  where: {
    tenantId: req.user.tenantId,
    ...(employeeId ? { id: employeeId } : {}),
    exitDate: null,
  },
  include: { /* ... */ },
  orderBy: { lastName: "asc" },
});
```

Current shape in apps/api/src/routes/reports.ts (GET /datev handler, ~line 275):
```ts
const employees = await app.prisma.employee.findMany({
  where: { tenantId: req.user.tenantId, exitDate: null },
  include: { /* ... */ },
});
```

After the change, both `where` clauses MUST also contain `user: { isActive: true }` — same relation filter used by overtime.ts.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add user.isActive filter to /monthly and /datev report queries</name>
  <files>apps/api/src/routes/reports.ts</files>
  <action>
    Edit `apps/api/src/routes/reports.ts` to exclude anonymized employees from both report queries by adding `user: { isActive: true }` to the Prisma `where` clauses. This mirrors the pattern already used in `apps/api/src/routes/overtime.ts` (lines ~181 and ~384).

    **Change 1 — GET /monthly handler (around line 30):**

    Current:
    ```ts
    const employees = await app.prisma.employee.findMany({
      where: {
        tenantId: req.user.tenantId,
        ...(employeeId ? { id: employeeId } : {}),
        exitDate: null,
      },
      include: { /* unchanged */ },
      orderBy: { lastName: "asc" },
    });
    ```

    Updated:
    ```ts
    const employees = await app.prisma.employee.findMany({
      where: {
        tenantId: req.user.tenantId,
        ...(employeeId ? { id: employeeId } : {}),
        exitDate: null,
        user: { isActive: true },
      },
      include: { /* unchanged */ },
      orderBy: { lastName: "asc" },
    });
    ```

    **Change 2 — GET /datev handler (around line 275):**

    Current:
    ```ts
    const employees = await app.prisma.employee.findMany({
      where: { tenantId: req.user.tenantId, exitDate: null },
      include: { /* unchanged */ },
    });
    ```

    Updated:
    ```ts
    const employees = await app.prisma.employee.findMany({
      where: {
        tenantId: req.user.tenantId,
        exitDate: null,
        user: { isActive: true },
      },
      include: { /* unchanged */ },
    });
    ```

    **Constraints:**
    - Do NOT modify `include`, `orderBy`, or any downstream logic (DATEV line generation, monthly aggregation, PDF rendering).
    - Do NOT touch any other file — this is a pure `where`-clause scoping fix.
    - Preserve the existing `exitDate: null` filter (it keeps employees who left the company out; `user.isActive` is orthogonal — it also filters DSGVO-anonymized users whose `exitDate` may still be null).
    - Use the exact relation-filter shape `user: { isActive: true }` to stay consistent with `overtime.ts`.
    - Keep the explicit employeeId override in /monthly working (the spread of `...(employeeId ? { id: employeeId } : {})` stays before the new filter).

    **Rationale:** DSGVO anonymization (see `CLAUDE.md` "DSGVO Employee Deletion = Anonymization") sets `User.isActive = false` and scrubs `firstName` / `lastName` / `employeeNumber` to "Gelöscht" / "GELÖSCHT-XXX". Without this filter, monthly PDFs and DATEV exports include rows for these placeholder records, which is both a data-quality issue for admins and an audit-traceability concern for payroll downstream.
  </action>
  <verify>
    <automated>cd /Users/sebastianzabel/git/clokr &amp;&amp; pnpm --filter @clokr/api exec tsc --noEmit</automated>
  </verify>
  <done>
    - `reports.ts` contains `user: { isActive: true }` inside the `where` clause of BOTH the `/monthly` `employee.findMany` and the `/datev` `employee.findMany`.
    - `pnpm --filter @clokr/api exec tsc --noEmit` passes with no new type errors.
    - No other lines in `reports.ts` are modified (include, orderBy, handler logic, schema, imports all unchanged).
    - `grep -n "user: { isActive: true }" apps/api/src/routes/reports.ts` returns exactly 2 matches.
  </done>
</task>

</tasks>

<verification>
1. Type-check passes: `pnpm --filter @clokr/api exec tsc --noEmit`
2. Exactly two occurrences of the new filter in reports.ts:
   `grep -c "user: { isActive: true }" apps/api/src/routes/reports.ts` → `2`
3. Both report routes still compile and register without error (implicit via tsc).
4. Manual smoke (optional, only if API is running):
   - `GET /api/v1/reports/monthly?year=2026&month=4` — response does NOT include any employee whose `user.isActive === false`.
   - `GET /api/v1/reports/datev?year=2026&month=4` — DATEV CSV lines do NOT reference anonymized Personalnummern.
</verification>

<success_criteria>
- Both the `/monthly` and `/datev` handlers in `apps/api/src/routes/reports.ts` filter employees via `user: { isActive: true }`, matching the pattern in `overtime.ts`.
- Anonymized (DSGVO-deleted) employees no longer appear in monthly reports or DATEV exports.
- Active employees are still included exactly as before — report output for real employees is unchanged.
- TypeScript compiles with no new errors.
- No changes outside `apps/api/src/routes/reports.ts`.
</success_criteria>

<output>
After completion, create `.planning/quick/260410-idv-fix-reports-ts-to-exclude-anonymized-ina/260410-idv-SUMMARY.md` summarizing:
- The two lines changed (with before/after snippets)
- Verification output (tsc exit code, grep count)
- Confirmation that no other files were touched
</output>
