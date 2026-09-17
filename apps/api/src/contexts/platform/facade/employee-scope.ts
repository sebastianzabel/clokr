/**
 * Phase 100B Plan 04 (D-10) — the shared argument shape every conversion wave's facade functions
 * take when the question they answer is "which employee(s), in which tenant".
 *
 * Measured driver (100B-04-PLAN.md Task 3): the same question is asked per-employee
 * (`employeeId`), in bulk (`employeeId: { in: [...] }`) and tenant-wide (`employee: { tenantId }`)
 * — sometimes all three inside `composition/dashboard.ts` alone. That difference is incidental to
 * the QUESTION a caller is asking and essential to the tenant boundary the answer must respect, so
 * it belongs in one shared discriminated union rather than restated in ~40 function signatures.
 *
 * `Employee` is an Unterbau model (ADR 0001) — every context is permitted to read it — which is
 * why this type lives under `contexts/platform/facade/`, not under any single business context.
 *
 * This is the ONE place the {@link EmployeeScope} -> Prisma `where` fragment mapping may be
 * stated — the same rule `resolveContractWorkDaysPerWeek()` carries for its own fallback chain
 * (CLAUDE.md § Schedule Types): no reader of a conversion-wave facade module may rebuild this
 * mapping inline.
 *
 * **Every variant carries `tenantId`, including `kind: "employee"`.** This is deliberate (D-10,
 * T-100B-16): the tenant constraint travels WITH the identifier a client supplied, rather than
 * being assumed the way `confirmed-saldo.ts`'s existing comment documents today ("PURE READ, no
 * tenant argument. Callers MUST already have a tenant-scoped employeeId",
 * `contexts/working-time-account/confirmed-saldo.ts:11-14`) — the convention this type replaces.
 * It is also what makes `lint-facade-signatures`'s F3/G4 rule satisfiable without a named
 * exception for every function that takes a scope: an `EmployeeScope` parameter already carries a
 * `tenantId` sibling for its `employeeId`/`employeeIds`, by construction.
 *
 * This module contains no Prisma CALL of its own — it is a pure, side-effect-free type/function
 * module, so its presence under `contexts/platform/facade/` does not move the
 * `lint:tenant-scoping` gate's counts. It also exports no `db: Prisma.TransactionClient`-taking
 * function, so `lint-facade-signatures`'s F1 (D-07) has nothing to check it against in spirit —
 * `employeeScopeWhere` is still visited because F1 is checked mechanically against every exported
 * function declaration under `contexts/*\/facade/`, regardless of whether it touches Prisma at
 * all. It carries a named exception in `lint-facade-signatures-exceptions.json` for exactly that
 * reason — see this plan's SUMMARY for the full reasoning.
 */
export type EmployeeScope =
  | { kind: "employee"; employeeId: string; tenantId: string }
  | { kind: "employees"; employeeIds: string[]; tenantId: string }
  | { kind: "tenant"; tenantId: string };

/**
 * The `where` fragment selecting the employee(s) an {@link EmployeeScope} names. Every returned
 * shape also implicitly requires the caller's own tenant constraint to be added by the facade
 * function that uses this fragment (typically `employee: { tenantId }` alongside it, or —
 * for a model that itself carries `employeeId` directly — `employeeId` combined with a join back
 * to `Employee.tenantId`); this helper only answers "which employee(s)", not "which tenant",
 * even though every {@link EmployeeScope} variant carries a `tenantId` field for exactly that
 * purpose (see the module header — G4/F3 needs it declared on the SCOPE, not necessarily used
 * again here).
 */
export function employeeScopeWhere(scope: EmployeeScope): {
  employeeId?: string | { in: string[] };
  employee?: { tenantId: string };
} {
  switch (scope.kind) {
    case "employee":
      return { employeeId: scope.employeeId };
    case "employees":
      return { employeeId: { in: scope.employeeIds } };
    case "tenant":
      return { employee: { tenantId: scope.tenantId } };
  }
}
