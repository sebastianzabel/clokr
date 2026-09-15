// Reduced from apps/api/src/routes/time-entries.ts:1521-1560 — the dominant fetch-then-compare
// idiom (D-13). The `employee.findUnique` call's `where` reads a field off `existing`, a row
// already fetched (and tenant-compared) earlier in the SAME handler — not off the request.
// This is deliberately NOT a candidate: `existing.employeeId` is not a client-supplied value.
declare const app: {
  prisma: {
    timeEntry: { findUnique: (args: unknown) => Promise<{ employeeId: string }> };
    employee: { findUnique: (args: unknown) => unknown };
  };
};

export async function updateEntryHandler(req: { params: unknown }) {
  const { id } = req.params as { id: string };
  const existing = await app.prisma.timeEntry.findUnique({ where: { id } });
  const targetEmployee = await app.prisma.employee.findUnique({
    where: { id: existing.employeeId },
  });
  return targetEmployee;
}
