// Negative (Phase 89): Json path that does not end in "tenantId" does not count.
declare const app: {
  prisma: { auditLog: { findFirst: (args: unknown) => unknown } };
};

export async function readAuditLogHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };
  const tenantId = req.user.tenantId;
  return app.prisma.auditLog.findFirst({
    where: { id, newValue: { path: ["actor", "operatorId"], equals: tenantId } },
  });
}
