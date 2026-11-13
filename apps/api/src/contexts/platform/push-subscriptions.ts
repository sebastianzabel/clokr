/**
 * Issue #608 (D-03, D-04, D-05, P-608-06) - the push-device service: the one place a
 * `PushSubscription` row is created, shaped for the API and audited.
 *
 * A row is a delivery address owned by a user and exists only after an explicit opt-in on that
 * device. The endpoint (a capability URL) and both keys are never returned, logged or audited: the
 * API shows a device by `endpointHash`, the audit row names `deviceLabel` and `consentedAt` only.
 * Tenant and user come from the caller's token, never from the body.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PushSubscription } from "@clokr/db";
import { uniqueViolationTarget } from "../../utils/prisma-unique-violation";
import { isAnonymizedEmployee } from "./employee-anonymization-filter";
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

export type SubscribeResult =
  | { kind: "CREATED"; device: ApiPushDevice }
  | { kind: "UPDATED"; device: ApiPushDevice }
  | { kind: "REFUSED"; code: PushSubscribeRefusal };

/** The two refusals of a registration; the route words them, the service decides them. */
export type PushSubscribeRefusal =
  "PUSH_ENDPOINT_CONFLICT" | "PUSH_DEVICE_LIMIT" | "PUSH_ACCOUNT_INACTIVE";

/** At most this many devices per person (P-608-08, anti-abuse). */
export const MAX_PUSH_DEVICES_PER_USER = 10;

/** Thrown inside the transaction when a concurrent writer changed the endpoint's row under us. */
class EndpointRaceError extends Error {}

/** Constant-time equality of two key strings (the auth secret is compared here). */
function sameKey(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function isEndpointRace(err: unknown): boolean {
  if (err instanceof EndpointRaceError) return true;
  const target = uniqueViolationTarget(err);
  return target !== null && target.includes("PushSubscription_endpoint_key");
}

/**
 * Registers a device. The endpoint is unique in the table, so there are never two rows per browser
 * subscription (D-05, P-608-07):
 *  - unknown endpoint: a new row (subject to the per-person cap);
 *  - same person again: the one row is updated (keys, label, consent date);
 *  - another person on the same browser: re-assigned, but only when the presented keys equal the
 *    stored ones;
 *  - another person with different keys: refused, nothing written.
 * A unique-violation race with a concurrent writer re-runs the whole transaction once.
 */
export async function subscribeDevice(
  app: FastifyInstance,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  try {
    return await subscribeOnce(app, input);
  } catch (err) {
    if (!isEndpointRace(err)) throw err;
    return subscribeOnce(app, input); // a second race is rethrown to the caller
  }
}

async function subscribeOnce(
  app: FastifyInstance,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const deviceLabel = deviceLabelFromUserAgent(input.userAgent);
  const consentedAt = new Date();
  const auditValue = { deviceLabel, consentedAt: consentedAt.toISOString() };

  return app.prisma.$transaction(async (tx): Promise<SubscribeResult> => {
    // Serialises this person's registrations (review IN-01): without the lock two parallel
    // subscribes can both count 9 devices and both insert. The count below is a new statement
    // after the lock, so it sees the winner's committed row. NO KEY UPDATE conflicts with itself
    // but not with the FOR KEY SHARE that inserting a row referencing the user takes. The user id
    // comes from the verified token.
    const locked = await tx.$queryRaw<
      Array<{ isActive: boolean }>
    >`SELECT "isActive" FROM "User" WHERE id = ${input.userId} FOR NO KEY UPDATE`;

    // Review 2, IN-02: anonymisation deactivates the user and then deletes the push rows. A
    // subscribe that passed `requireAuth` before that commit waits on the lock above and would
    // otherwise create a NEW delivery address for an anonymised or deactivated person afterwards.
    // The state is read after the lock, so it is the committed state of the winner.
    if (locked.length === 0 || locked[0].isActive !== true) {
      return { kind: "REFUSED", code: "PUSH_ACCOUNT_INACTIVE" };
    }
    const employee = await tx.employee.findUnique({
      where: { userId: input.userId, tenantId: input.tenantId },
      select: { firstName: true, lastName: true },
    });
    if (employee && isAnonymizedEmployee(employee)) {
      return { kind: "REFUSED", code: "PUSH_ACCOUNT_INACTIVE" };
    }

    const existing = await tx.pushSubscription.findUnique({ where: { endpoint: input.endpoint } });

    // (b) The same person registers the same browser again: one row, refreshed.
    if (existing && existing.userId === input.userId) {
      const updated = await tx.pushSubscription.update({
        where: { id: existing.id },
        data: { p256dh: input.p256dh, auth: input.auth, deviceLabel, consentedAt },
      });
      await app.audit({
        userId: input.userId,
        action: "UPDATE",
        entity: "PushSubscription",
        entityId: updated.id,
        newValue: auditValue,
        request: input.request,
        tx,
      });
      return { kind: "UPDATED", device: toApiDevice(updated) };
    }

    // (d) Another person's endpoint. Knowing the URL is not enough to take it over: a browser
    // subscription is the endpoint together with its key pair, so a caller who really holds this
    // subscription (a shared phone, a second login in the same browser) presents the same
    // p256dh and auth. Anyone who only learned the URL cannot, and is refused without any write.
    if (
      existing &&
      !(sameKey(existing.p256dh, input.p256dh) && sameKey(existing.auth, input.auth))
    ) {
      return { kind: "REFUSED", code: "PUSH_ENDPOINT_CONFLICT" };
    }

    // (a) and (c): a new row for this person, so the cap applies before anything is written.
    const owned = await tx.pushSubscription.count({ where: { userId: input.userId } });
    if (owned >= MAX_PUSH_DEVICES_PER_USER) return { kind: "REFUSED", code: "PUSH_DEVICE_LIMIT" };

    // (c) Re-assignment: the old owner's row goes, traceable in the old owner's tenant.
    if (existing) {
      const { count } = await tx.pushSubscription.deleteMany({ where: { id: existing.id } });
      if (count === 0) throw new EndpointRaceError();
      await app.audit({
        action: "DELETE",
        entity: "PushSubscription",
        entityId: existing.id,
        oldValue: {
          deviceLabel: existing.deviceLabel,
          consentedAt: existing.consentedAt.toISOString(),
        },
        newValue: {
          reason: "REASSIGNED",
          actor: { type: "SYSTEM", tenantId: existing.tenantId },
        },
        // No `request` and no `userId` on purpose (review WR-02): this row is shown to the OLD
        // owner's tenant, so it must not carry the new owner's IP address, User-Agent or id - they
        // may belong to another tenant. The new owner's own CREATE audit keeps the request data.
        tx,
      });
    }

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
      newValue: auditValue,
      request: input.request,
      tx,
    });
    return { kind: "CREATED", device: toApiDevice(created) };
  });
}

// ── List and remove (own devices only) ───────────────────────────────────────

/** The caller's own devices, oldest first. Tenant and user come from the token, never the body. */
export async function listOwnDevices(
  app: FastifyInstance,
  scope: { tenantId: string; userId: string },
): Promise<ApiPushDevice[]> {
  const rows = await app.prisma.pushSubscription.findMany({
    where: { tenantId: scope.tenantId, userId: scope.userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toApiDevice);
}

export type DeviceSelector = { endpoint: string } | { id: string };

export type RemoveOwnDeviceInput = {
  tenantId: string;
  userId: string;
  by: DeviceSelector;
  request: AuditRequest;
};

/**
 * Removes one of the caller's own devices and audits it (D-04: a hard delete, the audit row is the
 * trace). The lookup always carries `userId` AND `tenantId`, never the endpoint or the id alone, so
 * a foreign device is indistinguishable from an unknown one: both return `false`.
 */
export async function removeOwnDevice(
  app: FastifyInstance,
  input: RemoveOwnDeviceInput,
): Promise<boolean> {
  return app.prisma.$transaction(async (tx) => {
    const row = await tx.pushSubscription.findFirst({
      where: { userId: input.userId, tenantId: input.tenantId, ...input.by },
    });
    if (!row) return false;
    await tx.pushSubscription.delete({ where: { id: row.id } });
    await app.audit({
      userId: input.userId,
      action: "DELETE",
      entity: "PushSubscription",
      entityId: row.id,
      oldValue: { deviceLabel: row.deviceLabel, consentedAt: row.consentedAt.toISOString() },
      newValue: { reason: "USER_REMOVED" },
      request: input.request,
      tx,
    });
    return true;
  });
}
