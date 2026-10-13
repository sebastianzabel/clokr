// Shape 8b (Phase 89): Json-path constraint in the exact accepted form, last path element "tenantId", equals the principal tenant. Scoped.
declare const app: {
  prisma: { auditLog: { findFirst: (args: unknown) => unknown } };
};

export async function readAuditLogHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };
  const tenantId = req.user.tenantId;
  return app.prisma.auditLog.findFirst({
    where: { id, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
  });
}
