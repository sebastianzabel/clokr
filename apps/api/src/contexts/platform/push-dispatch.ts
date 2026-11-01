/**
 * Issue #608 (D-10, P-608-09, P-608-10) - sending a push to a person's devices.
 *
 * This task ships the "send a test" path only. The payload is built from the constants of
 * `notification-push-policy.ts` - there is no parameter through which a title or message could
 * enter (AC-4 by construction). A failed device is logged with `{ statusCode, host }` only. Plan 03
 * adds the shared outcome handler (404/410 deletes the row) and the `notify()` dispatch.
 */
import type { FastifyInstance } from "fastify";
import { PUSH_TEST_PAYLOAD, PUSH_TEST_TTL_SECONDS } from "./notification-push-policy";
import { pushLogFields, sendWebPush } from "./push-sender";

export type TestPushDeviceResult = {
  id: string;
  deviceLabel: string;
  outcome: "SENT" | "REMOVED" | "FAILED";
};

export async function sendTestPush(
  app: FastifyInstance,
  scope: { tenantId: string; userId: string },
): Promise<TestPushDeviceResult[]> {
  const rows = await app.prisma.pushSubscription.findMany({
    where: { userId: scope.userId, tenantId: scope.tenantId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const results: TestPushDeviceResult[] = [];
  // One device after the other: a person owns at most a handful and the sends stay bounded.
  for (const row of rows) {
    const sent = await sendWebPush(
      { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
      PUSH_TEST_PAYLOAD,
      PUSH_TEST_TTL_SECONDS,
    );
    if (sent.outcome === "SENT") {
      await app.prisma.pushSubscription.updateMany({
        where: { id: row.id },
        data: { lastSuccessAt: new Date() },
      });
      results.push({ id: row.id, deviceLabel: row.deviceLabel, outcome: "SENT" });
      continue;
    }
    app.log.warn(pushLogFields(row.endpoint, sent.statusCode), "Test push was not delivered");
    results.push({ id: row.id, deviceLabel: row.deviceLabel, outcome: "FAILED" });
  }
  return results;
}
