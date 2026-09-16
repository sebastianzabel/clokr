// Reduced from apps/api/src/routes/overtime.ts:297-300 (workSchedule.findFirst with
// `where: { employeeId: body.employeeId, ... }`) — a where field read off the parsed request
// body via a local `body` binding, not destructured to its own local name.
declare const z: {
  object: (shape: unknown) => { parse: (value: unknown) => { employeeId: string } };
};
declare const app: { prisma: { workSchedule: { findFirst: (args: unknown) => unknown } } };

const payoutSchema = z.object({ employeeId: "uuid", hours: "number" });

export async function payoutHandler(req: { body: unknown }) {
  const body = payoutSchema.parse(req.body);
  const schedule = await app.prisma.workSchedule.findFirst({
    where: { employeeId: body.employeeId },
  });
  return schedule;
}
