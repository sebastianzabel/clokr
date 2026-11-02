/**
 * Issue #608 (D-04, D-07, D-10, D-11, D-15, P-608-09, P-608-13, P-608-14) - sending a push to a
 * person's devices.
 *
 * Two entry points share one outcome handler: the "send a test" action and the dispatch that
 * `notify()` triggers for every in-app notification. In both the payload is built from the
 * constants of `notification-push-policy.ts` - there is no parameter through which a title or
 * message could enter (AC-4 by construction). A failed device is logged with `{ statusCode, host }`
 * only: the error object of the push library can carry the endpoint (a capability URL).
 */
import type { FastifyInstance } from "fastify";
import {
  PUSH_TEST_PAYLOAD,
  PUSH_TEST_TTL_SECONDS,
  PUSH_TITLE,
  resolvePushPolicy,
  safePushUrl,
} from "./notification-push-policy";
import { pushConfiguration, pushLogFields, sendWebPush, type PushSendOutcome } from "./push-sender";
import { ACTIVE_TENANT_WHERE } from "./tenant-status";

export type TestPushDeviceResult = {
  id: string;
  deviceLabel: string;
  outcome: "SENT" | "REMOVED" | "FAILED";
};

/** The fields of a device row the outcome handler needs; nothing else is ever selected for a send. */
type PushDeviceRow = {
  id: string;
  tenantId: string;
  endpoint: string;
  deviceLabel: string;
  consentedAt: Date;
};

/**
 * Applies the result of one send to the device row. SENT stamps `lastSuccessAt` (best effort);
 * GONE (the push service answered 404 or 410) hard-deletes the row and, when this call removed it,
 * writes a SYSTEM `DELETE` audit stamped with the row's tenant so the tenant's own audit log shows
 * it; FAILED keeps the row and logs the status and the host, never the endpoint.
 */
export async function handleSendOutcome(
  app: FastifyInstance,
  row: PushDeviceRow,
  outcome: PushSendOutcome,
): Promise<TestPushDeviceResult["outcome"]> {
  if (outcome.outcome === "SENT") {
    try {
      await app.prisma.pushSubscription.updateMany({
        where: { id: row.id },
        data: { lastSuccessAt: new Date() },
      });
    } catch {
      // Best effort: a failed bookkeeping write must not turn a delivered push into a failure.
      app.log.debug({ tenantId: row.tenantId }, "Push lastSuccessAt could not be stored");
    }
    return "SENT";
  }
  if (outcome.outcome === "GONE") {
    await app.prisma.$transaction(async (tx) => {
      const { count } = await tx.pushSubscription.deleteMany({ where: { id: row.id } });
      if (count !== 1) return;
      await app.audit({
        action: "DELETE",
        entity: "PushSubscription",
        entityId: row.id,
        oldValue: { deviceLabel: row.deviceLabel, consentedAt: row.consentedAt.toISOString() },
        newValue: {
          reason: "EXPIRED_BY_PUSH_SERVICE",
          actor: { type: "SYSTEM", tenantId: row.tenantId },
        },
        tx,
      });
    });
    return "REMOVED";
  }
  app.log.warn(pushLogFields(row.endpoint, outcome.statusCode), "Push delivery failed");
  return "FAILED";
}

/**
 * Overall deadline of the "send a test" action (review WR-06). Each device keeps its own socket
 * timeout in `push-sender.ts`; this bound is on top of it, so a person with several dead devices
 * never holds the HTTP request for the sum of the per-device timeouts.
 */
export const TEST_PUSH_DEADLINE_MS = 15_000;

export async function sendTestPush(
  app: FastifyInstance,
  scope: { tenantId: string; userId: string },
  options: { deadlineMs?: number } = {},
): Promise<TestPushDeviceResult[]> {
  const rows = await app.prisma.pushSubscription.findMany({
    where: { userId: scope.userId, tenantId: scope.tenantId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const deadlineMs = options.deadlineMs ?? TEST_PUSH_DEADLINE_MS;

  // Every device is sent to in parallel. A device that has not answered when the deadline passes is
  // reported as FAILED; its send keeps running in the background and its outcome is still applied.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"DEADLINE">((resolve) => {
    timer = setTimeout(() => resolve("DEADLINE"), deadlineMs);
  });
  try {
    const settled = await Promise.allSettled(
      rows.map(async (row): Promise<TestPushDeviceResult> => {
        const send = sendWebPush(
          { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
          PUSH_TEST_PAYLOAD,
          PUSH_TEST_TTL_SECONDS,
        ).then((sent) => handleSendOutcome(app, row, sent));
        // Keep a late rejection from becoming an unhandled one once the race is over.
        send.catch(() => undefined);
        const outcome = await Promise.race([send, deadline]);
        return {
          id: row.id,
          deviceLabel: row.deviceLabel,
          outcome: outcome === "DEADLINE" ? "FAILED" : outcome,
        };
      }),
    );
    return settled.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : { id: rows[index].id, deviceLabel: rows[index].deviceLabel, outcome: "FAILED" },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The only inputs a notification push may use: who, which type, and the notification's own link.
 * The in-app title and message are deliberately NOT part of this type (AC-4 by construction).
 */
export type NotificationPushParams = { userId: string; type: string; link?: string | null };

/**
 * Pushes one notification to every device of the recipient (D-10). The tenant is NOT taken from
 * `notify()`'s optional `tenantId` (the attendance-checker calls omit it): it comes from the
 * subscription rows, which also gates a deactivated tenant (D-07). The e-mail switches never gate
 * push (D-11); the opt-in is the existence of a device row. `notify()` runs this fire-and-forget
 * and catches whatever escapes (D-15).
 */
export async function dispatchNotificationPush(
  app: FastifyInstance,
  params: NotificationPushParams,
): Promise<void> {
  const { userId, type, link } = params;
  // Without the VAPID set the push surface does not exist (D-01): rows could only be stale.
  if (!pushConfiguration()) return;

  // Fail-closed, checked before any read: a missing registration surfaces for every recipient.
  const policy = resolvePushPolicy(type);
  if (!policy) {
    app.log.warn(
      { type },
      "Notification push suppressed: type has no entry in the push policy registry (fail-closed) " +
        "- add one in apps/api/src/contexts/platform/notification-push-policy.ts",
    );
    return;
  }
  if (policy.push === "never") {
    app.log.debug({ type }, "Notification push skipped: policy is 'never'");
    return;
  }

  const rows = await app.prisma.pushSubscription.findMany({
    where: { userId, user: { isActive: true }, tenant: ACTIVE_TENANT_WHERE },
    select: {
      id: true,
      tenantId: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      deviceLabel: true,
      consentedAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (rows.length === 0) return;

  // Built once from the registry and the validated link; the in-app title/message never get here.
  const payload = { title: PUSH_TITLE, body: policy.body, url: safePushUrl(link) };
  // In parallel: one dead device must not delay the others. A failure of one device is contained
  // and logged without the error object (it may carry a database detail or the endpoint).
  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        const sent = await sendWebPush(
          { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
          payload,
          policy.ttlSeconds,
        );
        await handleSendOutcome(app, row, sent);
      } catch {
        app.log.warn({ type, tenantId: row.tenantId }, "Push dispatch failed for one device");
      }
    }),
  );
}
