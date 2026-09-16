// Reduced from apps/api/src/routes/shifts.ts:605-615 (PUT /templates/:id) — Shape 1: `where`
// constrains directly on `tenantId: req.user.tenantId` (D-13 way 1, inline-tenant-id).
declare const app: {
  prisma: { shiftTemplate: { update: (args: unknown) => unknown } };
};

export async function updateTemplateHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };
  const updated = await app.prisma.shiftTemplate.update({
    where: { id, tenantId: req.user.tenantId },
    data: {},
  });
  return updated;
}
