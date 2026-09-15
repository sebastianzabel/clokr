// Reduced from apps/api/src/routes/time-entries.ts:1795-1811 (PUT /:id, break-slot correction) —
// Shape 7: chained validation ACROSS model boundaries (D-16, T-204-14). `id` was validated
// against TimeEntry via fetch-then-compare earlier in this SAME function; the later
// `break.deleteMany` reuses that identifier on a DIFFERENT model (Break, two relation-hops from a
// tenant-bearing model) without a fresh tenant check of its own. KNOWINGLY NOT recognised — this
// is a named exception (D-16), not a gate defect. The verdict's `detail` must name D-16 so the
// person writing the exception at time-entries.ts:1811 and :2243 knows this miss is expected.
declare const app: {
  prisma: {
    timeEntry: {
      findFirst: (args: unknown) => Promise<{ employee: { tenantId: string } } | null>;
    };
    break: { deleteMany: (args: unknown) => unknown };
  };
};

export async function correctEntryHandler(req: { params: unknown; user: { tenantId: string } }) {
  const { id } = req.params as { id: string };

  const existing = await app.prisma.timeEntry.findFirst({
    where: { id, deletedAt: null },
  });
  if (!existing) return { status: 404 };
  if (existing.employee.tenantId !== req.user.tenantId) {
    return { status: 404 };
  }

  await app.prisma.break.deleteMany({ where: { timeEntryId: id } });
  return { status: 200 };
}
