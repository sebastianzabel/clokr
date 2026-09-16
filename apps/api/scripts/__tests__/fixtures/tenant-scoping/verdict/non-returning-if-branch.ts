// Adversarial fixture (CR-01, 204-REVIEW.md): the mismatch branch of the tenant comparison falls
// through instead of returning/throwing, so the write below still executes unconditionally.
// Verbatim from the reviewer's own reproduction: `findScopingComparison` previously accepted this
// as `{ scoped: true, via: "fetch-then-compare", ... }` because it only checked that a qualifying
// `BinaryExpression` exists textually before the write, not that the `if` it sits in actually
// exits when the tenants mismatch.
declare const app: {
  prisma: {
    leaveType: {
      findUnique: (args: unknown) => Promise<{ tenantId: string }>;
      update: (args: unknown) => unknown;
    };
  };
};

export async function nonReturningIfBranchHandler(req: {
  params: unknown;
  user: { tenantId: string };
}) {
  const { id } = req.params as { id: string };
  const record = await app.prisma.leaveType.findUnique({ where: { id } });
  if (record.tenantId !== req.user.tenantId) {
    console.warn("mismatch"); // no return!
  }
  const updated = await app.prisma.leaveType.update({ where: { id }, data: {} });
  return updated;
}
