// Adversarial fixture (CR-01, 204-REVIEW.md): a same-scope comparison against
// req.user.tenantId exists, but its boolean result is never used to gate anything — the write
// below runs unconditionally regardless of what the comparison finds. Verbatim from the
// reviewer's own reproduction against the real leaveType idiom: `findScopingComparison`
// previously accepted this as `{ scoped: true, via: "fetch-then-compare", ... }` purely because
// SOME BinaryExpression comparing the fetched row against req.user existed textually before the
// write — it never checked whether that comparison actually short-circuits execution.
declare const app: {
  prisma: {
    leaveType: {
      findUnique: (args: unknown) => Promise<{ tenantId: string }>;
      update: (args: unknown) => unknown;
    };
  };
};

export async function unusedComparisonHandler(req: {
  params: unknown;
  user: { tenantId: string };
}) {
  const { id } = req.params as { id: string };
  const record = await app.prisma.leaveType.findUnique({ where: { id } });
  const isMine = record.tenantId === req.user.tenantId; // never checked!
  const updated = await app.prisma.leaveType.update({ where: { id }, data: {} });
  return { isMine, updated };
}
