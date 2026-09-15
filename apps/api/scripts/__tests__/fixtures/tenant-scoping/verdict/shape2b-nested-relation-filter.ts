// Reduced from apps/api/src/routes/audit-logs.ts:27-32 — Shape 2b: a 2-hop relation filter,
// `user: { employee: { tenantId: req.user.tenantId } } }` (D-13 way 1, inline-relation-filter,
// two hops because AuditLog has no direct Employee relation — only via User).
declare const app: {
  prisma: { auditLog: { findFirst: (args: unknown) => unknown } };
};

export async function listAuditLogsHandler(req: { query: unknown; user: { tenantId: string } }) {
  const { action } = req.query as { action?: string };
  const where = {
    user: { employee: { tenantId: req.user.tenantId } },
    ...(action ? { action } : {}),
  };
  const logs = await app.prisma.auditLog.findFirst({ where });
  return logs;
}
