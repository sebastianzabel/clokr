// Negative (Phase 89): `OR` with ONE unscoped branch (`{ id }`) stays a finding.
declare const app: {
  prisma: { auditLog: { findFirst: (args: unknown) => unknown } };
};

export async function readAuditLogHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };
  const tenantId = req.user.tenantId;
  return app.prisma.auditLog.findFirst({
    where: {
      OR: [{ user: { employee: { tenantId } } }, { id }],
    },
  });
}
