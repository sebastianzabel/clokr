import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    audit: (params: {
      userId?: string;
      action: string;
      entity: string;
      entityId?: string;
      oldValue?: unknown;
      newValue?: unknown;
      request?: { ip: string; headers: Record<string, string | string[] | undefined> };
    }) => Promise<void>;
  }
}

export const auditPlugin = fp(async (app) => {
  app.decorate(
    "audit",
    async (params: {
      userId?: string;
      action: string;
      entity: string;
      entityId?: string;
      oldValue?: unknown;
      newValue?: unknown;
      request?: { ip: string; headers: Record<string, string | string[] | undefined> };
    }) => {
      await app.prisma.auditLog.create({
        data: {
          userId: params.userId,
          action: params.action,
          entity: params.entity,
          entityId: params.entityId,
          oldValue: params.oldValue ? JSON.parse(JSON.stringify(params.oldValue)) : undefined,
          newValue: params.newValue ? JSON.parse(JSON.stringify(params.newValue)) : undefined,
          ipAddress: params.request?.ip,
          userAgent: params.request?.headers["user-agent"] as string | undefined,
        },
      });
    },
  );
});
