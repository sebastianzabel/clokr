// Phase 76.2 (ARCH-V19-01, sub-req A + D) — Actor-aware audit emission that closes #215.
// Bridges 3 auth paths (JWT, Terminal API key, Programmatic API key) into a unified
// AuditLog write without changing the existing app.audit() signature.
//
// Storage strategy: non-User actors are embedded in newValue.actor JSON (AuditLog.userId
// stays null, no FK violation). When AUDIT-V19-01 lands (v1.9) the JSON migrates to a column.
//
// CR-01 fix: emits the AuditLog row through the resolver's transaction client (`tx`) so
// rolled-back resolver transactions cannot leave orphan audit rows, and so the inserted
// row id is returned directly (no race-prone "most-recent matching row" re-fetch).
import type { FastifyRequest } from "fastify";
import type { Prisma } from "@clokr/db";
import type { Actor } from "./types";

type TxClient = Prisma.TransactionClient;

export function resolveActor(req: FastifyRequest | undefined): Actor {
  if (!req?.user) return { type: "SYSTEM" };
  const sub = req.user.sub;
  if (typeof sub === "string" && sub.startsWith("apikey:")) {
    return { type: "API_KEY", apiKeyId: sub.slice("apikey:".length) };
  }
  // Note: TERMINAL actors are NOT resolved from req — they come from
  // ClockEvent.actor set by the NFC adapter (which uses Terminal API key auth
  // directly in the route handler, not via requireAuth).
  return { type: "USER", userId: sub };
}

export async function emitClockAudit(
  tx: TxClient,
  params: {
    action: string;
    entity: string;
    entityId: string;
    oldValue?: unknown;
    newValue?: unknown;
    actor: Actor;
    req?: FastifyRequest;
  },
): Promise<{ id: string }> {
  const userId = params.actor.type === "USER" ? params.actor.userId : undefined;
  const actorMeta = params.actor.type !== "USER" ? { actor: params.actor } : {};

  const mergedNewValue = params.newValue
    ? typeof params.newValue === "object" && params.newValue !== null
      ? { ...(params.newValue as Record<string, unknown>), ...actorMeta }
      : { value: params.newValue, ...actorMeta }
    : Object.keys(actorMeta).length > 0
      ? actorMeta
      : undefined;

  const created = await tx.auditLog.create({
    data: {
      userId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      oldValue: params.oldValue
        ? (JSON.parse(JSON.stringify(params.oldValue)) as Prisma.InputJsonValue)
        : undefined,
      newValue: mergedNewValue
        ? (JSON.parse(JSON.stringify(mergedNewValue)) as Prisma.InputJsonValue)
        : undefined,
      ipAddress: params.req?.ip,
      userAgent: params.req?.headers["user-agent"] as string | undefined,
    },
    select: { id: true },
  });
  return { id: created.id };
}
