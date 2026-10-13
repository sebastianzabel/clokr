import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";
import { validatePassword, loadPasswordPolicy } from "../password-policy";
import { TENANT_DEACTIVATED_ERROR, isTenantRowActive } from "../tenant-status"; // Phase 88 (#88), AC-88-08

/** SHA-256 hash for tokens stored in DB. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const acceptSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function invitationRoutes(app: FastifyInstance) {
  // POST /api/v1/invitations/accept  — öffentlich, kein Auth
  app.post("/accept", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: { tags: ["Einladung"] },
    handler: async (req, reply) => {
      const { token, password } = acceptSchema.parse(req.body);

      const invitation = await app.prisma.invitation.findUnique({
        where: { token: hashToken(token) },
        include: {
          employee: { include: { user: true, tenant: { select: { deactivatedAt: true } } } },
        },
      });

      if (!invitation) {
        return reply.code(404).send({ error: "Ungültiger Einladungslink" });
      }

      if (invitation.acceptedAt) {
        return reply.code(409).send({ error: "Dieser Link wurde bereits verwendet" });
      }

      if (invitation.expiresAt < new Date()) {
        return reply.code(410).send({
          error: "Dieser Link ist abgelaufen. Bitte wenden Sie sich an den Administrator.",
        });
      }

      // Phase 88 (AC-88-08): a deactivated tenant's invitation activates nothing — the user stays
      // inactive and the invitation stays unused, so it works again after a reactivation.
      if (!isTenantRowActive(invitation.employee.tenant)) {
        return reply.code(403).send(TENANT_DEACTIVATED_ERROR);
      }

      // Validate password against tenant policy
      const policy = await loadPasswordPolicy(app, invitation.employee.tenantId);
      const check = validatePassword(password, policy);
      if (!check.valid) {
        return reply.code(400).send({ error: check.errors.join(". ") });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      await app.prisma.$transaction([
        app.prisma.user.update({
          where: { id: invitation.employee.userId },
          data: { passwordHash, isActive: true },
        }),
        app.prisma.invitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        }),
      ]);

      await app.audit({
        action: "UPDATE",
        entity: "User",
        entityId: invitation.employee.userId,
        newValue: { isActive: true, invitationAccepted: true },
      });

      return { success: true, message: "Passwort gesetzt. Sie können sich jetzt anmelden." };
    },
  });
}
