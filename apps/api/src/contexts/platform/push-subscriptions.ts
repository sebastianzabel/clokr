/**
 * Issue #608 (D-03, D-04, D-05, P-608-06) - the push-device service: the one place a
 * `PushSubscription` row is created, shaped for the API and audited.
 *
 * A row is a delivery address owned by a user and exists only after an explicit opt-in on that
 * device. The endpoint (a capability URL) and both keys are never returned, logged or audited: the
 * API shows a device by `endpointHash`, the audit row names `deviceLabel` and `consentedAt` only.
 * Tenant and user come from the caller's token, never from the body. Plan 02 adds the
 * existing-endpoint branches, list, delete and the per-person cap.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PushSubscription } from "@clokr/db";
import { deviceLabelFromUserAgent } from "./push-device-label";

export type ApiPushDevice = {
  id: string;
  deviceLabel: string;
  consentedAt: string;
  lastSuccessAt: string | null;
  endpointHash: string;
};

export type AuditRequest = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
};

export function endpointHashOf(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

/** The only shape in which a device leaves the server: no endpoint, no keys. */
export function toApiDevice(row: PushSubscription): ApiPushDevice {
  return {
    id: row.id,
    deviceLabel: row.deviceLabel,
    consentedAt: row.consentedAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
    endpointHash: endpointHashOf(row.endpoint),
  };
}

export type SubscribeInput = {
  tenantId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | undefined;
  request: AuditRequest;
};

export type SubscribeResult = { kind: "CREATED"; device: ApiPushDevice } | { kind: "CONFLICT" };

export async function subscribeDevice(
  app: FastifyInstance,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const existing = await app.prisma.pushSubscription.findUnique({
    where: { endpoint: input.endpoint },
    select: { id: true },
  });
  if (existing) return { kind: "CONFLICT" };

  const deviceLabel = deviceLabelFromUserAgent(input.userAgent);
  const consentedAt = new Date();
  const row = await app.prisma.$transaction(async (tx) => {
    const created = await tx.pushSubscription.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        deviceLabel,
        consentedAt,
      },
    });
    await app.audit({
      userId: input.userId,
      action: "CREATE",
      entity: "PushSubscription",
      entityId: created.id,
      newValue: { deviceLabel, consentedAt: consentedAt.toISOString() },
      request: input.request,
      tx,
    });
    return created;
  });
  return { kind: "CREATED", device: toApiDevice(row) };
}
