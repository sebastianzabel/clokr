import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "./setup";
import type { FastifyInstance } from "fastify";

/**
 * Issue #468, finding 2 (G18), D-04/A-3, Task 1+2 (plan 05) — `PATCH /requests/:id/correct` now
 * honours CONFIRMED § 9 credits range-aware instead of blindly netting them against the new
 * range: a credit that falls (fully or partially) outside the corrected range is SUPERSEDED
 * (kept, audited, ledger-undone) rather than silently continuing to reduce consumption.
 */
describe("Leave correction and § 9 credits (Issue #468, D-04/A-3)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9c468");
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2027, 2028],
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
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
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode).toBe(200);
    return res;
  }

  function correct(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/correct`,
      headers: {
        authorization: `Bearer ${data.adminToken}`,
        "user-agent": "vitest-agent/1.0",
      },
      payload: { reason: "Korrektur nach Rückfrage", ...payload },
    });
  }

  function confirmSection9(
    creditId: string,
    opts: { attestValidFrom: string; attestValidTo: string },
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${creditId}/confirm`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        attestSource: "EAU",
        attestValidFrom: opts.attestValidFrom,
        attestValidTo: opts.attestValidTo,
        reason: "AU eingereicht",
      },
    });
  }

  async function getVacationUsed(year = 2027): Promise<number> {
    const e = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year },
    });
    return Number(e?.usedDays ?? -999);
  }

  async function getEntitlementSelfHeal(year = 2027) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${data.employee.id}?year=${year}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const rows = JSON.parse(res.body) as Array<{ leaveType?: { name: string }; usedDays?: number }>;
    return Number(rows.find((r) => r.leaveType?.name === "Urlaub")?.usedDays ?? -999);
  }

  // ── Task 1: D-05 "outside" variant (tracer) + "inside" regression guard ──────────

  it("D-05 outside: a confirmed § 9 credit that falls outside the corrected range is SUPERSEDED, ledger-undone, and the new range is fully consumed (not double-credited)", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2027-03-01",
      endDate: "2027-03-12",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    await approve(vacId);
    expect(await getVacationUsed()).toBe(10);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2027-03-10",
      endDate: "2027-03-12",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);

    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    expect(credit).not.toBeNull();
    const creditId = credit!.id;

    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2027-03-10",
      attestValidTo: "2027-03-12",
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(await getVacationUsed()).toBe(7);

    const correctRes = await correct(vacId, { startDate: "2027-03-01", endDate: "2027-03-09" });
    expect(correctRes.statusCode).toBe(200);
    const correctBody = JSON.parse(correctRes.body);
    expect(Number(correctBody.days)).toBe(7);

    // RED proof (see SUMMARY): before this plan's fix, this read 4 — the OLD net-against-new
    // logic kept crediting the now-outside-range credit a SECOND time.
    expect(await getVacationUsed()).toBe(7);

    const creditAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(creditAfter?.status).toBe("SUPERSEDED");

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SECTION9_CREDIT_SUPERSEDED", entity: "Section9Credit", entityId: creditId },
    });
    expect(audit).not.toBeNull();
    const oldVal = audit?.oldValue as { status?: string; creditedDays?: number } | null;
    const newVal = audit?.newValue as {
      status?: string;
      correctedLeaveRequestId?: string;
      auditReason?: string;
    } | null;
    expect(oldVal?.status).toBe("CONFIRMED");
    expect(oldVal?.creditedDays).toBe(3);
    expect(newVal?.status).toBe("SUPERSEDED");
    expect(newVal?.correctedLeaveRequestId).toBe(vacId);

    // Self-heal parity: GET /entitlements recomputes from scratch (approved days − CONFIRMED
    // credits) and must agree with what the ledger write above actually stored.
    expect(await getEntitlementSelfHeal()).toBe(7);
  });

  it("D-05 inside (regression guard): a confirmed credit that stays fully inside the corrected range is untouched", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2027-04-05",
      endDate: "2027-04-16",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    const oldDays = Number(JSON.parse(vac.body).days);
    await approve(vacId);
    const usedBefore = await getVacationUsed();

    const sick = await createRequest({
      type: "SICK",
      startDate: "2027-04-07",
      endDate: "2027-04-09",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    const creditId = credit!.id;
    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2027-04-07",
      attestValidTo: "2027-04-09",
    });
    expect(confirmRes.statusCode).toBe(200);
    const creditedDays = Number(JSON.parse(confirmRes.body).creditedDays);
    const usedAfterConfirm = await getVacationUsed();
    expect(usedAfterConfirm).toBe(usedBefore - creditedDays);

    // Shorten the tail — the credit (04-07..04-09) stays fully inside the new range.
    const correctRes = await correct(vacId, { startDate: "2027-04-05", endDate: "2027-04-14" });
    expect(correctRes.statusCode).toBe(200);
    const newDays = Number(JSON.parse(correctRes.body).days);

    const creditAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(creditAfter?.status).toBe("CONFIRMED"); // untouched
    expect(Number(creditAfter?.creditedDays)).toBe(creditedDays); // unchanged

    // reverse OLD gross (oldDays) + apply NEW gross (newDays); the still-inside credit is
    // untouched, so its earlier give-back (creditedDays) is never re-applied here.
    const expectedUsed = usedAfterConfirm - oldDays + newDays;
    expect(await getVacationUsed()).toBe(expectedUsed);
    expect(await getEntitlementSelfHeal()).toBe(expectedUsed);
  });
});
