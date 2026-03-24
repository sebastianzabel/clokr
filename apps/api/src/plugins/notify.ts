import fp from "fastify-plugin";

interface NotifyParams {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    notify: (params: NotifyParams) => Promise<void>;
  }
}

export const notifyPlugin = fp(async (app) => {
  async function notify({ userId, type, title, message, link }: NotifyParams) {
    await app.prisma.notification.create({
      data: { userId, type, title, message, link },
    });
  }

  app.decorate("notify", notify);
});
