// Reduced from apps/api/src/routes/company-shutdowns.ts:16-20 (`const where: ... = { tenantId };
// ...`) — a `where` value built in a differently-named local variable above the call and
// referenced via an explicit `where: someVar` property, not shorthand. Candidate: the variable's
// content is traced back to its declaration and found to reference `id` from req.params.
declare const app: { prisma: { leaveRequest: { findFirst: (args: unknown) => unknown } } };

export async function cancelLeaveRequestHandler(req: { params: unknown }) {
  const { id } = req.params as { id: string };
  const filters = { id, status: "PENDING" };

  const existing = await app.prisma.leaveRequest.findFirst({ where: filters });
  return existing;
}
