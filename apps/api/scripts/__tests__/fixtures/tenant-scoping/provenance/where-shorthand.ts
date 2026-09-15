// Reduced from apps/api/src/routes/integrations.ts:470-473 (`const where = {...}; ...
// findFirst({ where, ... })`) — the ONE occurrence of the ES2015 shorthand-property form
// measured in this repo. Unlike the real occurrence (which scopes only on
// `req.user.tenantId`, a principal field), this fixture's `where` references `id` from
// req.params, so it is a candidate whether the shorthand binding resolves back to its
// declaration or not: resolved, it is a normal candidate via "id"; unresolved, it is the
// loud `<unresolved>` candidate (T-204-07). The plan's own text leaves this outcome
// implementation-defined and requires the test to assert whichever this module actually
// produces, explicitly.
declare const app: { prisma: { phorestSyncRun: { findFirst: (args: unknown) => unknown } } };

export async function syncRunLookupHandler(req: { params: unknown }) {
  const { id } = req.params as { id: string };
  const where = { id };

  const run = await app.prisma.phorestSyncRun.findFirst({ where, orderBy: { startedAt: "desc" } });
  return run;
}
