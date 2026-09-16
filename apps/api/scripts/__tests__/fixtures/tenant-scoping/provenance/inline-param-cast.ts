// Reduced from apps/api/src/routes/time-entries.ts:677-681 — req.params destructured via an
// inline `as` type cast (no zod schema), the more common of the two idioms measured in this
// repo (204-RESEARCH.md §Client-Supplied Identifier Idiom).
declare const app: { prisma: { timeEntry: { findFirst: (args: unknown) => unknown } } };

export async function clockOutHandler(req: { params: unknown }) {
  const { id } = req.params as { id: string };
  const entry = await app.prisma.timeEntry.findFirst({
    where: { id, deletedAt: null },
  });
  return entry;
}
