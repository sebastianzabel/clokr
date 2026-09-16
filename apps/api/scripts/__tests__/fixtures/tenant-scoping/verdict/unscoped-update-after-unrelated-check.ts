// Adversarial fixture (T-204-11): a handler containing a GOOD tenant check on identifier
// `otherId`, and a SEPARATE, unscoped `update` on the client-supplied `id`. A naive "any tenant
// check somewhere in this function" heuristic passes this; the shared-identifier requirement in
// findScopingComparison/findGuardFetch must not. Modelled on the own-data guard idiom at
// apps/api/src/routes/employees.ts:1362-1382 (`device.employeeId !== employeeId`), but with a
// SECOND, unrelated identifier introduced to prove the check does not bleed across identifiers.
declare const app: {
  prisma: {
    presenceDevice: {
      findFirst: (args: unknown) => Promise<{ employeeId: string } | null>;
      update: (args: unknown) => unknown;
    };
  };
};

export async function unrelatedCheckHandler(req: {
  params: unknown;
  query: unknown;
  user: { tenantId: string; employeeId: string };
}) {
  const { id } = req.params as { id: string };
  const { otherId } = req.query as { otherId: string };

  const other = await app.prisma.presenceDevice.findFirst({ where: { id: otherId } });
  if (!other) return { status: 404 };
  // Own-data guard on a DIFFERENT identifier (otherId) — must not bless the update on `id` below.
  if (other.employeeId !== req.user.employeeId) {
    return { status: 403 };
  }

  const updated = await app.prisma.presenceDevice.update({ where: { id }, data: {} });
  return updated;
}
