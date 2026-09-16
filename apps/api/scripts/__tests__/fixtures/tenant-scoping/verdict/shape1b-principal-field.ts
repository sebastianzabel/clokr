// Reduced from apps/api/src/routes/notifications.ts:24-32 (PATCH /:id/read) — Shape 1b: `where`
// constrains on a principal field OTHER than tenantId (`userId: req.user.sub`), D-13 way 1's
// strictly-tighter sub-form (inline-principal-field): a User belongs to exactly one Employee's
// tenant, so this cannot widen the result set across a tenant boundary.
declare const app: {
  prisma: { notification: { updateMany: (args: unknown) => unknown } };
};

export async function markNotificationReadHandler(req: { params: unknown; user: { sub: string } }) {
  const { id } = req.params as { id: string };
  await app.prisma.notification.updateMany({
    where: { id, userId: req.user.sub },
    data: { read: true },
  });
  return { success: true };
}
