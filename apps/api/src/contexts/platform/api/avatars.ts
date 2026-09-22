import { FastifyInstance } from "fastify";
import { requireAuth } from "../../../middleware/auth";
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

      // Same T-100-09 guard as GET/DELETE above (Issue #259, CLOSED-BY this change): the 404
      // body is IDENTICAL to the genuine not-found branch, so this endpoint cannot be used as
      // a tenant-membership oracle. The isSelf/isManager check above stays where it is — it is
      // existence-independent and therefore not an oracle; this guard is what an ADMIN/MANAGER
      // of a FOREIGN tenant runs into. The attempt is not lost: it is recorded in the audit log
      // via app.audit() below, where it belongs.
      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        if (employee) {
          await app.audit({
            userId: req.user.sub,
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "Employee",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

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

      // Phase 258 — tenant isolation guard in the established T-100-09 shape (canonical
      // instance: contexts/platform/api/settings.ts:758-780). The 404 body is IDENTICAL to
      // the genuine not-found branch so this endpoint cannot be used as a tenant-membership
      // oracle: a foreign tenant's real employee and an id that exists nowhere are
      // indistinguishable to the caller. A 403 here would BE the oracle — it would say
      // "this id exists, just not here" — and this route has no role gate (requireAuth
      // only), so any authenticated employee could probe with it. The attempt is not lost:
      // it is recorded in the audit log via app.audit() below, where it belongs.
      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true, avatarPath: true },
      });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        if (employee) {
          await app.audit({
            userId: req.user.sub,
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "Employee",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      // "No avatar stored" is a normal business state, not a failed resource access — a 404
      // here is indistinguishable from the genuine storage failure below (phase 258, D-01).
      // No response body: 204 has none by definition, which is why this one route departs
      // from the house `reply.code(XXX).send({ error: "…" })` shape.
      if (!employee.avatarPath) {
        return reply.code(204).send();
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

      // Same T-100-09 guard as GET above: the 404 body is IDENTICAL to the genuine
      // not-found branch, so this endpoint cannot be used as a tenant-membership oracle.
      // The isSelf/isManager check further up stays where it is — it is existence-
      // independent and therefore not an oracle; this guard is what an ADMIN/MANAGER of a
      // FOREIGN tenant runs into.
      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true, avatarPath: true },
      });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        if (employee) {
          await app.audit({
            userId: req.user.sub,
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "Employee",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      // Unlike GET, DELETE keeps the 404 here: "nothing to delete" really is a failed
      // request, and no display path calls this on every page load (phase 258, D-01 applies
      // to GET only). Reaching this line already proves the caller is in the right tenant,
      // so a distinguishable body here crosses no boundary.
      if (!employee.avatarPath) {
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
