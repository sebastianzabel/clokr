/**
 * section9-invariants.test.ts — the legal guarantees of Phase 104, as standalone tests.
 *
 * These are not behaviour tests; they are the properties that make the § 9 implementation lawful
 * and audit-proof. If one of them fails, the fix is the production code, never the assertion.
 *
 *   R7  — a credit runs into an isLocked month as a correction, without unlocking it
 *   D-16 — the credit is entitlement-side only; no SaldoSnapshot is touched
 *   D-05 — the approved vacation request is never physically altered
 *   D-02 — attestPresent stays a consequence-free display flag
 *   D-20 — the existing expiry-warning mechanism carries the notice duty (EuGH C-684/16)
 *   R3  — the audit entry states R3's exact required note text, verbatim (see Test below)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("§ 9 BUrlG legal invariants — Phase 104-06 Task 3", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let r7CreditId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9inv");
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createRequest(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload,
    });
  }

  async function approve(id: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
  }

  async function confirmCredit(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${id}/confirm`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });
  }

  async function vacAndSick(vacRange: [string, string], sickRange: [string, string]) {
    const vac = await createRequest({
      type: "VACATION",
      startDate: vacRange[0],
      endDate: vacRange[1],
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: sickRange[0],
      endDate: sickRange[1],
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    return { vacId, sickId, creditId: credit.id };
  }

  it("R7: AU confirmed into an isLocked month credits without unlocking", async () => {
    const { vacId, sickId, creditId } = await vacAndSick(
      ["2026-03-09", "2026-03-13"],
      ["2026-03-11", "2026-03-12"],
    );
    r7CreditId = creditId;

    // Simulate a closed March 2026 for this employee: a locked TimeEntry (on a day OUTSIDE
    // the vacation range, so it is unaffected by the request lifecycle above) plus an active
    // SaldoSnapshot row for the month — exactly the two artifacts a real Monatsabschluss
    // produces and that R7 requires the § 9 credit to leave untouched.
    const lockedEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date("2026-03-02T00:00:00Z"),
        startTime: new Date("2026-03-02T07:00:00Z"),
        endTime: new Date("2026-03-02T15:30:00Z"),
        breakMinutes: 30,
        type: "WORK",
        isLocked: true,
        lockedAt: new Date("2026-04-01T00:00:00Z"),
      },
    });
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: new Date("2026-03-01T00:00:00Z"),
        periodEnd: new Date("2026-03-31T00:00:00Z"),
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2026-04-01T00:00:00Z"),
        closedBy: data.adminEmployee.id,
      },
    });

    const snapshotsBefore = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: data.employee.id },
      orderBy: { id: "asc" },
    });
    const lockedEntryBefore = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: lockedEntry.id },
    });

    const res = await confirmCredit(creditId, {
      attestSource: "EAU",
      attestValidFrom: "2026-03-11",
      attestValidTo: "2026-03-12",
      reason: "AU liegt vor — Monat ist bereits abgeschlossen",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).creditedDays).toBe(2);

    const snapshotsAfter = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: data.employee.id },
      orderBy: { id: "asc" },
    });
    const lockedEntryAfter = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: lockedEntry.id },
    });

    // Not "no error was thrown" — the actual rows must be byte-identical.
    expect(snapshotsAfter).toEqual(snapshotsBefore);
    expect(lockedEntryAfter).toEqual(lockedEntryBefore);
    expect(lockedEntryAfter.isLocked).toBe(true);

    // The vacation/sick requests themselves are untouched by the locked-month machinery either.
    const vacationRow = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacId } });
    const sickRow = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: sickId } });
    expect(vacationRow.status).toBe("APPROVED");
    expect(sickRow.status).toBe("APPROVED");
  });

  it("D-16: the credit does not change any saldo figure", async () => {
    const { creditId } = await vacAndSick(
      ["2026-04-13", "2026-04-17"],
      ["2026-04-15", "2026-04-16"],
    );

    const before = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(before.statusCode).toBe(200);
    const balanceBefore = JSON.parse(before.body).balanceHours;

    const res = await confirmCredit(creditId, {
      attestSource: "EAU",
      attestValidFrom: "2026-04-15",
      attestValidTo: "2026-04-16",
      reason: "AU liegt vor — Saldo darf sich nicht ändern",
    });
    expect(res.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(after.statusCode).toBe(200);
    const balanceAfter = JSON.parse(after.body).balanceHours;

    expect(balanceAfter).toBe(balanceBefore);
  });

  it("D-05: the approved vacation LeaveRequest is byte-identical after a confirm", async () => {
    const { vacId, creditId } = await vacAndSick(
      ["2026-05-04", "2026-05-08"],
      ["2026-05-06", "2026-05-07"],
    );

    const before = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacId } });

    const res = await confirmCredit(creditId, {
      attestSource: "PAPIER",
      attestValidFrom: "2026-05-06",
      attestValidTo: "2026-05-07",
      reason: "AU liegt vor — Urlaubsantrag bleibt unverändert",
    });
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacId } });

    // Every column, including updatedAt — not just the fields the confirm handler "shouldn't"
    // have touched, but literally all of them.
    expect(after).toEqual(before);
  });

  it("D-02: attestPresent is not a trigger and is not written", async () => {
    const { vacId, sickId, creditId } = await vacAndSick(
      ["2026-06-01", "2026-06-05"],
      ["2026-06-03", "2026-06-04"],
    );

    const creditsBeforeAttest = await app.prisma.section9Credit.count({
      where: { sickRequestId: sickId },
    });
    expect(creditsBeforeAttest).toBe(1);

    // Setting attestPresent via the pre-existing display-flag endpoint must NOT itself create
    // a credit or touch the entitlement — the § 9 credit fires exclusively from the explicit
    // confirm action.
    const attestRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${sickId}/attest`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { attestPresent: true, attestValidFrom: "2026-06-03", attestValidTo: "2026-06-04" },
    });
    expect(attestRes.statusCode).toBe(200);

    const creditsAfterAttest = await app.prisma.section9Credit.count({
      where: { sickRequestId: sickId },
    });
    expect(creditsAfterAttest).toBe(1);

    const sickBeforeConfirm = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: sickId },
    });
    const vacBeforeConfirm = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: vacId },
    });
    expect(sickBeforeConfirm.attestPresent).toBe(true);
    expect(vacBeforeConfirm.attestPresent).toBe(false);

    const res = await confirmCredit(creditId, {
      attestSource: "EAU",
      attestValidFrom: "2026-06-03",
      attestValidTo: "2026-06-04",
      reason: "AU liegt vor — attestPresent bleibt unangetastet",
    });
    expect(res.statusCode).toBe(200);

    const sickAfterConfirm = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: sickId },
    });
    const vacAfterConfirm = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: vacId },
    });
    // Unchanged by the confirm — still exactly what the earlier PATCH /attest call set.
    expect(sickAfterConfirm.attestPresent).toBe(sickBeforeConfirm.attestPresent);
    expect(sickAfterConfirm.attestValidFrom).toEqual(sickBeforeConfirm.attestValidFrom);
    expect(vacAfterConfirm.attestPresent).toBe(vacBeforeConfirm.attestPresent);
  });

  it("D-20: credited days raise the remaining entitlement the existing expiry warning reads", async () => {
    const { creditId } = await vacAndSick(
      ["2026-07-06", "2026-07-10"],
      ["2026-07-08", "2026-07-09"],
    );

    async function usedDays() {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/entitlements/${data.employee.id}?year=2026`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const rows = JSON.parse(res.body) as Array<{
        leaveType?: { name: string };
        usedDays?: number;
      }>;
      return Number(rows.find((r) => r.leaveType?.name === "Urlaub")?.usedDays ?? 0);
    }

    const before = await usedDays();

    const res = await confirmCredit(creditId, {
      attestSource: "EAU",
      attestValidFrom: "2026-07-08",
      attestValidTo: "2026-07-09",
      reason: "AU liegt vor — Resturlaub steigt über das normale usedDays-Feld",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).creditedDays).toBe(2);

    const after = await usedDays();
    // The ordinary usedDays field is what the existing October/November/December expiry
    // reminders (Hinweispflicht, EuGH C-684/16) already read — no § 9-specific warning
    // logic exists or is needed.
    expect(after).toBe(before - 2);
  });

  it("R3 audit wording: the SECTION9_CREDIT_CONFIRMED audit row states the required text", async () => {
    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SECTION9_CREDIT_CONFIRMED",
        entity: "Section9Credit",
        entityId: r7CreditId,
      },
    });
    expect(audit).not.toBeNull();
    const newValue = audit!.newValue as { note: string };
    expect(newValue.note).toBe("§ 9 BUrlG, nicht angerechnet");
  });
});
