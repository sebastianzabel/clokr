import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// ────────────────────────────────────────────────────────────────────────────
// Issue #200 — the IN-APP notification channel. Proves that the title and the
// message of the SAME leave-request notification agree on the leave type, for
// the three registers (Antrag / reflexive SICK / Meldung), read straight from
// the stored Notification row (no transformation between create and read).
//
// Year 2027 dates throughout, non-overlapping ranges — Issue #34 / project
// memory: hardcoded current-year dates are a known time-bomb class in this
// suite.
// ────────────────────────────────────────────────────────────────────────────

describe("Leave-request notification copy (Issue #200)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lrnc");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createLeaveRequestAndGetManagerNotification(payload: {
    type: string;
    startDate: string;
    endDate: string;
  }) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const requestId = JSON.parse(res.body).id as string;

    const notif = await app.prisma.notification.findFirst({
      where: { userId: data.adminUser.id, type: "LEAVE_REQUEST", relatedId: requestId },
    });
    expect(notif).not.toBeNull();
    return notif!;
  }

  it("VACATION (Antrag register): title and message agree", async () => {
    const notif = await createLeaveRequestAndGetManagerNotification({
      type: "VACATION",
      startDate: "2027-03-01",
      endDate: "2027-03-05",
    });

    expect(notif.title).toBe("Neuer Urlaubsantrag");
    expect(notif.message).toBe("Max Test hat Urlaub beantragt (2027-03-01 – 2027-03-05)");
  });

  it("SICK (reflexive register): title and message agree", async () => {
    const notif = await createLeaveRequestAndGetManagerNotification({
      type: "SICK",
      startDate: "2027-04-05",
      endDate: "2027-04-07",
    });

    expect(notif.title).toBe("Neue Krankmeldung");
    expect(notif.message).toBe("Max Test hat sich krankgemeldet (2027-04-05 – 2027-04-07)");
  });

  it("SICK: goes red the instant the hardcoded 'Neuer Urlaubsantrag' regression returns", async () => {
    const notif = await createLeaveRequestAndGetManagerNotification({
      type: "SICK",
      startDate: "2027-04-12",
      endDate: "2027-04-14",
    });

    expect(notif.title).not.toBe("Neuer Urlaubsantrag");
    expect(notif.message).not.toContain("-Antrag gestellt");
  });

  it("SICK: title and message agree they are both about sickness (no title/body contradiction)", async () => {
    const notif = await createLeaveRequestAndGetManagerNotification({
      type: "SICK",
      startDate: "2027-04-19",
      endDate: "2027-04-21",
    });

    expect(notif.title).toMatch(/krank/i);
    expect(notif.message).toMatch(/krank/i);
  });

  it("MATERNITY (Meldung register): title and message agree", async () => {
    const notif = await createLeaveRequestAndGetManagerNotification({
      type: "MATERNITY",
      startDate: "2027-05-03",
      endDate: "2027-05-07",
    });

    expect(notif.title).toBe("Neue Mutterschutz-Meldung");
    expect(notif.message).toBe("Max Test hat Mutterschutz angemeldet (2027-05-03 – 2027-05-07)");
  });
});
