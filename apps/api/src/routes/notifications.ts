import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth";

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET / — list user's non-dismissed notifications (newest first, last 50)
  app.get("/", {
    schema: { tags: ["Benachrichtigungen"], security: [{ bearerAuth: [] }] },
    handler: async (req, _reply) => {
      const notifications = await app.prisma.notification.findMany({
        where: { userId: req.user.sub, dismissedAt: null },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      const unreadCount = await app.prisma.notification.count({
        where: { userId: req.user.sub, read: false, dismissedAt: null },
      });
      return { notifications, unreadCount };
    },
  });

  // PATCH /:id/read — mark as read
  app.patch("/:id/read", {
    schema: { tags: ["Benachrichtigungen"], security: [{ bearerAuth: [] }] },
    handler: async (req, _reply) => {
      const { id } = req.params as { id: string };
      await app.prisma.notification.updateMany({
        where: { id, userId: req.user.sub },
        data: { read: true },
      });
      return { success: true };
    },
  });

  // PATCH /read-all — mark all as read
  app.patch("/read-all", {
    schema: { tags: ["Benachrichtigungen"], security: [{ bearerAuth: [] }] },
    handler: async (req, _reply) => {
      await app.prisma.notification.updateMany({
        where: { userId: req.user.sub, read: false },
        data: { read: true },
      });
      return { success: true };
    },
  });

  // DELETE /:id — soft-dismiss a single notification
  app.delete("/:id", {
    schema: { tags: ["Benachrichtigungen"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await app.prisma.notification.updateMany({
        where: { id, userId: req.user.sub, dismissedAt: null },
        data: { dismissedAt: new Date() },
      });
      if (result.count === 0)
        return reply.code(404).send({ error: "Benachrichtigung nicht gefunden" });
      return { success: true };
    },
  });

  // DELETE /dismiss-all — soft-dismiss all of the current user's non-dismissed notifications
  app.delete("/dismiss-all", {
    schema: { tags: ["Benachrichtigungen"], security: [{ bearerAuth: [] }] },
    handler: async (req, _reply) => {
      const result = await app.prisma.notification.updateMany({
        where: { userId: req.user.sub, dismissedAt: null },
        data: { dismissedAt: new Date() },
      });
      return { success: true, count: result.count };
    },
  });
}
