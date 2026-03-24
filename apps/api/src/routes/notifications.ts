import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth";

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET / — list user's notifications (newest first, last 50)
  app.get("/", {
    schema: { tags: ["Benachrichtigungen"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
      const notifications = await app.prisma.notification.findMany({
        where: { userId: req.user.sub },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      const unreadCount = await app.prisma.notification.count({
        where: { userId: req.user.sub, read: false },
      });
      return { notifications, unreadCount };
    },
  });

  // PATCH /:id/read — mark as read
  app.patch("/:id/read", {
    schema: { tags: ["Benachrichtigungen"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
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
    handler: async (req, reply) => {
      await app.prisma.notification.updateMany({
        where: { userId: req.user.sub, read: false },
        data: { read: true },
      });
      return { success: true };
    },
  });
}
