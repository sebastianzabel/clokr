// Negative (Phase 89): any operator beyond path/equals (here `string_contains`) disqualifies the Json-path form.
declare const app: {
  prisma: { auditLog: { findFirst: (args: unknown) => unknown } };
};

export async function readAuditLogHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };
  const tenantId = req.user.tenantId;
  return app.prisma.auditLog.findFirst({
    where: {
      id,
      newValue: { path: ["actor", "tenantId"], equals: tenantId, string_contains: "x" },
    },
  });
}
