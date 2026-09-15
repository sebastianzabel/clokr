// Reduced from apps/api/src/routes/time-entries.ts:869-890 (POST /:id/breaks) — Shape 6b:
// identical to Shape 6, but through an aliased principal (`const user = req.user;`).
declare const app: {
  prisma: {
    timeEntry: {
      findFirst: (args: unknown) => Promise<{ employee: { tenantId: string } } | null>;
    };
  };
};

export async function appendBreakHandler(req: {
  params: unknown;
  user: { tenantId: string; sub: string };
}) {
  const { id } = req.params as { id: string };
  const user = req.user;

  const entry = await app.prisma.timeEntry.findFirst({
    where: { id, deletedAt: null },
    include: { employee: { select: { tenantId: true } } },
  });
  if (!entry) return { status: 404 };

  // Multi-tenancy: cross-tenant access is not allowed.
  if (entry.employee.tenantId !== user.tenantId) {
    return { status: 403 };
  }
  return entry;
}
