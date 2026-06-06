/**
 * Phase 76.2 (ARCH-V19-01 sub-req C step 4 of 4) — /presence/events race generalization.
 *
 * 5 concurrent `connected` events for the same employee on the same date must
 * produce exactly ONE open WIFI TimeEntry row. This is the final piece of sub-req C:
 * 76.1's lock pattern is now generalized to ALL 4 clock transports
 * (/nfc-punch, /clock-in, /:id/clock-out, /presence/events).
 *
 * The 5 responses all return HTTP 200 (idempotent contract — never 409 on /events).
 * Exactly one path goes through the resolver's START branch and creates the row;
 * the other 4 see the existing entry via the adapter's pre-resolver short-circuit
 * (lines 217-236 of pre-Plan-5 presence.ts) and emit WIFI_PRESENCE_CONFIRMED.
 *
 * Pre-Task-2 baseline: The legacy adapter (lines 239-269) uses an inline $transaction
 * with a re-check but NO row lock — this test MAY fail pre-Task-2 because two
 * concurrent transactions can both pass the re-check and create rows. Task 2's
 * migration moves the create through the resolver, whose FOR UPDATE row lock
 * serializes them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";

const TODAY = new Date();
const TODAY_DATE_STR = TODAY.toISOString().slice(0, 10);
const TODAY_UTC_MIDNIGHT = new Date(TODAY_DATE_STR + "T00:00:00Z");
const NOW_ISO = TODAY.toISOString();

const TEST_MAC_RAW = "AA:BB:CC:11:22:33";
const TEST_MAC_NORMALIZED = "aa:bb:cc:11:22:33";

const RUN_ID = Date.now().toString(36);
const RAW_KEY = `clk_p5_race_${RUN_ID}`;
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");

describe("services/clock — /presence/events race (sub-req C step 4 of 4)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let presenceSourceId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "presence-race");

    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { timezone: "Europe/Berlin", wifiPresenceWindowMinutes: 720 },
    });

    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { wifiMacs: [TEST_MAC_NORMALIZED], wifiPresenceEnabled: true },
    });

    await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: TODAY_UTC_MIDNIGHT,
        startTime: "00:00",
        endTime: "23:59",
        label: "Plan-5 race test shift",
      },
    });

    const src = await app.prisma.presenceSource.create({
      data: {
        tenantId: data.tenant.id,
        name: "Plan-5 Race Test FritzBox",
        keyHash: KEY_HASH,
        keyPrefix: RAW_KEY.slice(0, 8),
        revokedAt: null,
      },
    });
    presenceSourceId = src.id;
  });

  afterAll(async () => {
    try {
      const entries = await app.prisma.timeEntry.findMany({
        where: { employeeId: data.employee.id },
        select: { id: true },
      });
      await app.prisma.break.deleteMany({
        where: { timeEntryId: { in: entries.map((e) => e.id) } },
      });
      await app.prisma.auditLog.deleteMany({
        where: {
          OR: [{ entityId: { in: entries.map((e) => e.id) } }, { entityId: data.employee.id }],
        },
      });
      await app.prisma.timeEntry.deleteMany({
        where: { employeeId: data.employee.id },
      });
      await app.prisma.shift.deleteMany({
        where: { employeeId: data.employee.id },
      });
      await app.prisma.presenceSource.deleteMany({
        where: { id: presenceSourceId },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("race.presence cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      select: { id: true },
    });
    await app.prisma.break.deleteMany({
      where: { timeEntryId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.auditLog.deleteMany({
      where: {
        OR: [{ entityId: { in: entries.map((e) => e.id) } }, { entityId: data.employee.id }],
      },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  it("5 concurrent 'connected' events → 5× 200 + exactly 1 open WIFI TimeEntry row", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/presence/events",
          headers: { authorization: `Bearer ${RAW_KEY}` },
          payload: {
            mac: TEST_MAC_RAW,
            eventType: "connected",
            timestamp: NOW_ISO,
            adapter: "fritzbox",
          },
        }),
      ),
    );

    // All 5 must return 200 — idempotent contract; /events never returns 409 on the
    // happy path (Pitfall 4 in RESEARCH.md).
    for (const r of responses) expect(r.statusCode).toBe(200);

    // CORE invariant — exactly 1 open WIFI TimeEntry. Without the resolver's
    // FOR UPDATE row lock, 2+ concurrent INs could each pass the re-check and
    // create separate rows.
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null, source: "WIFI" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].endTime).toBeNull();
  });
});
