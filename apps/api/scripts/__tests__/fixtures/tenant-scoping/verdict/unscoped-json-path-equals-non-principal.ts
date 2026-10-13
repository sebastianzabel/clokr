// Negative (Phase 89): `equals` a value that is NOT the principal tenant (client-supplied id) does not count.
declare const app: {
  prisma: { auditLog: { findFirst: (args: unknown) => unknown } };
};

export async function readAuditLogHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };
  const tenantId = req.user.tenantId;
  return app.prisma.auditLog.findFirst({
    where: { id, newValue: { path: ["actor", "tenantId"], equals: id } },
  });
}
