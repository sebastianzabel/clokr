// Reduced from apps/api/src/routes/shifts.ts:704-726 (PUT /coverage-rules/:id) WITH
// `tenantId: req.user.tenantId` REMOVED from the guarding `findFirst` — i.e. exactly the mutation
// plan 05's AC4 red-once proof performs on the real handler. With the guard broken, the `update`
// that reuses `id` has NO tenant scoping left: not inline, not fetch-then-compare (no comparison
// exists), and not guard-fetch (the earlier fetch is no longer itself tenant-scoped).
declare const app: {
  prisma: {
    coverageRule: {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
      update: (args: unknown) => unknown;
    };
  };
};

export async function updateCoverageRuleHandlerUnscoped(req: {
  params: unknown;
  user: { tenantId: string };
}) {
  const { id } = req.params as { id: string };
  const existing = await app.prisma.coverageRule.findFirst({
    where: { id },
  });
  if (!existing) return { status: 404 };

  const updated = await app.prisma.coverageRule.update({
    where: { id },
    data: {},
  });
  return updated;
}
