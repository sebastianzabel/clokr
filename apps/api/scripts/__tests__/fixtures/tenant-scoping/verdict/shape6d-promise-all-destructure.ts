// Reduced from apps/api/src/routes/overtime.ts:93-116 (GET /:employeeId) — Shape 6d: the SAME
// fetch-then-compare idiom as shape6-fetch-then-compare.ts, but the fetch is one element of a
// `Promise.all([...])` destructured directly into `const [schedule, employee] = await
// Promise.all([...])` rather than a plain `const employee = await ...`. Discovered as a genuine
// recognition gap during Phase 204 Plan 04's D-17 checkpoint triage: `getAssignedVariableName`
// only matched a plain `const V = await <call>` declaration, so this exact real-world site was
// wrongly reported as an unscoped finding on a clean tree — see the D-17 checkpoint report and
// the coordinator's follow-up decision (204-04-SUMMARY.md).
declare const app: {
  prisma: {
    workSchedule: {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
    };
    employee: {
      findUnique: (args: unknown) => Promise<{ id: string; tenantId: string } | null>;
    };
  };
};

export async function overtimeAccountHandler(req: {
  params: unknown;
  user: { tenantId: string; sub: string };
}) {
  const { employeeId } = req.params as { employeeId: string };

  const [schedule, employee] = await Promise.all([
    app.prisma.workSchedule.findFirst({ where: { employeeId } }),
    app.prisma.employee.findUnique({ where: { id: employeeId } }),
  ]);

  if (!employee) return { status: 404 };
  // Tenant isolation check: compare via employee.tenantId (mirrors time-entries.ts:687).
  if (employee.tenantId !== req.user.tenantId) {
    return { status: 404 };
  }
  return { schedule, employee };
}
