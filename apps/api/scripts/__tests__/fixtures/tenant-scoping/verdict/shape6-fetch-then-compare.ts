// Reduced from apps/api/src/routes/time-entries.ts:681-698 (POST /:id/clock-out) — Shape 6, the
// dominant idiom (D-13 way 3, sub-form A): the fetch's OWN result is compared against
// req.user.tenantId before any further mutation. The comment at time-entries.ts:687 names this
// pattern "fetch-then-compare per D-02" explicitly.
declare const app: {
  prisma: {
    timeEntry: {
      findFirst: (
        args: unknown,
      ) => Promise<{ endTime: string | null; employee: { tenantId: string } } | null>;
    };
  };
};

export async function clockOutHandler(req: {
  params: unknown;
  user: { tenantId: string; sub: string };
}) {
  const { id } = req.params as { id: string };
  const entry = await app.prisma.timeEntry.findFirst({
    where: { id, deletedAt: null },
    include: { employee: true },
  });
  if (!entry) return { status: 404 };
  // D-02/D-07: Reject cross-tenant access (fetch-then-compare per D-02)
  if (entry.employee.tenantId !== req.user.tenantId) {
    return { status: 404 };
  }
  return entry;
}
