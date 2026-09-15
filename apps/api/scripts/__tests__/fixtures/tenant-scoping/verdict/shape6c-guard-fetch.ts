// Reduced from apps/api/src/routes/shifts.ts:704-726 (PUT /coverage-rules/:id) — Shape 6c,
// guard-fetch (D-13 way 3, sub-form B): the FETCH is itself tenant-scoped inline
// (`tenantId: req.user.tenantId`), followed by a not-found return, and the UPDATE that follows
// re-uses the SAME `id` without repeating the tenant constraint. The call being judged is the
// `update`.
declare const app: {
  prisma: {
    coverageRule: {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
      update: (args: unknown) => unknown;
    };
  };
};

export async function updateCoverageRuleHandler(req: {
  params: unknown;
  user: { tenantId: string };
}) {
  const { id } = req.params as { id: string };
  const existing = await app.prisma.coverageRule.findFirst({
    where: { id, tenantId: req.user.tenantId },
  });
  if (!existing) return { status: 404 };

  const updated = await app.prisma.coverageRule.update({
    where: { id },
    data: {},
  });
  return updated;
}
