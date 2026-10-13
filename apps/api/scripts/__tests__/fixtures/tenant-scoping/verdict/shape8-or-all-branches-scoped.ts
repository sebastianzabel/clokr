// Shape 8 (Phase 89): `OR` whose EVERY branch is tenant-scoped — a relation branch and a Json-path branch. Scoped.
declare const app: {
  prisma: { auditLog: { findFirst: (args: unknown) => unknown } };
};

export async function readAuditLogHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };
  const tenantId = req.user.tenantId;
  return app.prisma.auditLog.findFirst({
    where: {
      id,
      OR: [
        { user: { employee: { tenantId } } },
        { userId: null, newValue: { path: ["actor", "tenantId"], equals: tenantId } },
      ],
    },
  });
}
