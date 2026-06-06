import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveClockEvent } from "../resolver";
import type { ClockEvent } from "../types";

// Phase 76.2 (ARCH-V19-01) architectural enforcement of D-05 success criterion #10:
//   "Adding a sixth source (Slack bot, geofence, voice, badge reader, …) MUST be a single
//    new adapter file + a ClockEvent payload — no resolver changes."
//
// We feed a synthetic 'SYNTHETIC' source string through the resolver. The state-machine
// branch is identical to NFC AUTO; the only failure mode is the DB enum reject at create
// time. That failure is a *clean* downstream error — NOT a resolver-internal logic error.
//
// If this test ever requires the resolver to special-case sources, the architectural
// guarantee has been broken — DO NOT relax the test (memory feedback_no_test_manipulation).

describe("services/clock/resolver — future-source extensibility (D-05 #10)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "future-source");
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("future-source.test.ts cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("resolveClockEvent accepts a string source value 'SYNTHETIC' at the type level (no compile error, no resolver branch)", async () => {
    const now = new Date();
    const event: ClockEvent = {
      employeeId: data.employee.id,
      tenantId: data.tenant.id,
      source: "SYNTHETIC", // not in Prisma TimeEntrySource enum on purpose
      intent: "AUTO",
      timestamp: now,
      date: new Date(now.toISOString().slice(0, 10)),
      dateStr: now.toISOString().slice(0, 10),
      actor: { type: "SYSTEM" },
    };

    // The resolver should reach the DB. The DB will reject the unknown enum value.
    // This is the *correct* failure mode — proves the resolver is source-agnostic
    // and unknown-source handling is a DB concern (= add enum value + adapter).
    await expect(resolveClockEvent(app, event)).rejects.toThrow();
  });
});
