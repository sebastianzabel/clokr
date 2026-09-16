// Reduced from apps/api/src/routes/integrations.ts:555-565 — Shape 2: a 1-hop relation filter,
// `employee: { tenantId: req.user.tenantId }` (D-13 way 1, inline-relation-filter).
declare const app: {
  prisma: { shift: { findFirst: (args: unknown) => unknown } };
};

export async function removeShiftHandler(req: { query: unknown; user: { tenantId: string } }) {
  const q = req.query as { shiftId: string };
  const shift = await app.prisma.shift.findFirst({
    where: { id: q.shiftId, employee: { tenantId: req.user.tenantId }, deletedAt: null },
    select: { employeeId: true },
  });
  return shift;
}
