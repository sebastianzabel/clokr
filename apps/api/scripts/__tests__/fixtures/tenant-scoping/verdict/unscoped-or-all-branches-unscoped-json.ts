// Negative (Phase 89): `OR` whose second branch is a Json path on the wrong key stays a finding even though the first branch is scoped.
declare const app: {
  prisma: { auditLog: { findFirst: (args: unknown) => unknown } };
};

export async function readAuditLogHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };
  const tenantId = req.user.tenantId;
  return app.prisma.auditLog.findFirst({
    where: {
      OR: [
        { user: { employee: { tenantId } } },
        { userId: null, newValue: { path: ["actor", "operatorId"], equals: tenantId } },
      ],
    },
  });
}
