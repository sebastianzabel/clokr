import { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../middleware/auth";
import sharp from "sharp";

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function avatarRoutes(app: FastifyInstance) {
  // POST /api/v1/avatars/:employeeId — upload avatar
  app.post("/:employeeId", {
    schema: { tags: ["Avatare"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };

      // Only self or admin/manager can upload
      const isSelf = req.user.employeeId === employeeId;
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
      if (!isSelf && !isManager) {
        return reply.code(403).send({ error: "Keine Berechtigung" });
      }

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "Keine Datei hochgeladen" });

      if (!ALLOWED_TYPES.includes(data.mimetype)) {
        return reply.code(400).send({ error: "Nur JPG, PNG oder WebP erlaubt" });
      }

      const buffer = await data.toBuffer();
      if (buffer.length > MAX_SIZE) {
        return reply.code(400).send({ error: "Datei darf max. 2 MB groß sein" });
      }

      // Resize to 256x256 and convert to WebP
      const processed = await sharp(buffer)
        .resize(256, 256, { fit: "cover" })
        .webp({ quality: 85 })
        .toBuffer();

      const path = `avatars/${employee.tenantId}/${employeeId}.webp`;
      await app.storage.upload(path, processed, "image/webp");

      await app.prisma.employee.update({
        where: { id: employeeId },
        data: { avatarPath: path },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: employeeId,
        newValue: { avatarPath: path },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true, avatarPath: path };
    },
  });

  // GET /api/v1/avatars/:employeeId — serve avatar (requires auth — DSGVO Art. 4)
  app.get("/:employeeId", {
    schema: { tags: ["Avatare"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee?.avatarPath) {
        return reply.code(404).send({ error: "Kein Avatar vorhanden" });
      }

      // Tenant scope: only users in the same tenant may access the avatar
      if (employee.tenantId !== req.user.tenantId) {
        return reply.code(403).send({ error: "Keine Berechtigung" });
      }

      try {
        const buffer = await app.storage.getBuffer(employee.avatarPath);
        reply.header("Content-Type", "image/webp");
        reply.header("Cache-Control", "private, max-age=3600");
        return reply.send(buffer);
      } catch {
        return reply.code(404).send({ error: "Avatar nicht gefunden" });
      }
    },
  });

  // DELETE /api/v1/avatars/:employeeId — remove avatar
  app.delete("/:employeeId", {
    schema: { tags: ["Avatare"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };

      const isSelf = req.user.employeeId === employeeId;
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
      if (!isSelf && !isManager) {
        return reply.code(403).send({ error: "Keine Berechtigung" });
      }

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee?.avatarPath) {
        return reply.code(404).send({ error: "Kein Avatar vorhanden" });
      }

      try {
        await app.storage.delete(employee.avatarPath);
      } catch {
        /* ignore if already deleted from storage */
      }

      await app.prisma.employee.update({
        where: { id: employeeId },
        data: { avatarPath: null },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: employeeId,
        newValue: { avatarPath: null },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });
}
