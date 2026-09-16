// Adversarial fixture (CR-02 finding 2, 204-REVIEW.md): the OUTER, client-supplied `id` is never
// validated. A nested helper function declares its OWN `id`, shadowing the outer one, and only
// that local, unrelated string literal is ever checked against a tenant-scoped fetch — the update
// below still runs on the real, unvalidated outer `id`. Verbatim from the reviewer's own
// reproduction: `collectWhereIdentifiers`'s "shared identifier" search compares bare identifier
// TEXT with no scope/binding resolution, so the earlier fetch's `where: { id, ... }` inside
// `helper()` was wrongly treated as sharing an identifier with the outer, real `id` — this is
// exactly the T-204-11 false negative the shared-identifier requirement exists to prevent, only
// defeated by name shadowing rather than by omitting the check outright.
declare const app: {
  prisma: {
    coverageRule: {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
      update: (args: unknown) => unknown;
    };
  };
};

export async function shadowedIdentifierHandler(req: {
  params: unknown;
  user: { tenantId: string };
}) {
  const { id } = req.params as { id: string };

  async function helper() {
    const id = "totally-unrelated-literal"; // SHADOWS outer id
    const inner = await app.prisma.coverageRule.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!inner) return;
  }
  await helper();

  const updated = await app.prisma.coverageRule.update({ where: { id }, data: {} }); // outer id, unscoped
  return updated;
}
