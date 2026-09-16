// Adversarial fixture (T-204-12): a comparison where BOTH sides are attacker-controlled —
// `existing.tenantId !== body.tenantId` — never counts as a tenant check. Only a value resolved
// through isPrincipalExpression (traced to req.user in this scope) may bless a comparison.
// Modelled on the general update-after-fetch idiom in apps/api/src/routes/leave.ts:1596-1645,
// but with the comparison's right-hand side swapped for a client-controlled `body.tenantId`.
declare const app: {
  prisma: {
    leaveType: {
      findFirst: (args: unknown) => Promise<{ tenantId: string } | null>;
      update: (args: unknown) => unknown;
    };
  };
};

export async function spoofedCompareHandler(req: {
  params: unknown;
  body: unknown;
  user: { tenantId: string };
}) {
  const { id } = req.params as { id: string };
  const body = req.body as { tenantId: string };

  const existing = await app.prisma.leaveType.findFirst({ where: { id } });
  if (!existing) return { status: 404 };
  // Attacker controls BOTH sides of this comparison — it is not a tenant check.
  if (existing.tenantId !== body.tenantId) {
    return { status: 403 };
  }

  const updated = await app.prisma.leaveType.update({ where: { id }, data: {} });
  return updated;
}
