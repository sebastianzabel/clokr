// Reduced from apps/api/src/routes/leave.ts:3733-3745 (`resolveWorkDays`) — a module-level
// helper that takes plain parameters, not `req`. `workSchedule.findFirst({ where: { employeeId }
// })`'s `employeeId` is a bare function parameter here, never bound from req.params/req.query/
// req.body in any scope this module can see — deliberately NOT a candidate.
declare const prisma: { workSchedule: { findFirst: (args: unknown) => unknown } };

async function resolveWorkDays(employeeId: string, tenantId: string) {
  const ws = await prisma.workSchedule.findFirst({
    where: { employeeId },
    orderBy: { validFrom: "desc" },
  });
  return { ws, tenantId };
}

export { resolveWorkDays };
