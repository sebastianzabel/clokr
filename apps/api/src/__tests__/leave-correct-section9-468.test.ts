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

  // ── Task 2: partial overlap (A-3), type change, sick side, cross-year, guards ────────

  // Carries the "A-3 partial" fixture from the first `it` into the second (the plan's own
  // <behavior> list splits "partial" and "a second correction of the same vacation" into two
  // separate bullets — one `it` per bullet).
  let partialVacId: string;
  let partialSickId: string;
  let partialOriginalCreditId: string;
  let partialRevision1Id: string;

  it("A-3 partial: a confirmed credit partially clipped by the new range is superseded and replaced by exactly one revision+1 correction credit for the still-covered part", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2028-02-07",
      endDate: "2028-02-18",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    await approve(vacId);
    expect(await getVacationUsed(2028)).toBe(10);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2028-02-14",
      endDate: "2028-02-16",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    const creditId = credit!.id;
    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2028-02-14",
      attestValidTo: "2028-02-16",
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(await getVacationUsed(2028)).toBe(7);

    // Shorten the tail by one day — the credit (02-14..02-16) now only PARTIALLY overlaps.
    const correctRes = await correct(vacId, { startDate: "2028-02-07", endDate: "2028-02-15" });
    expect(correctRes.statusCode).toBe(200);
    expect(Number(JSON.parse(correctRes.body).days)).toBe(7);
    expect(await getVacationUsed(2028)).toBe(5);
    expect(await getEntitlementSelfHeal(2028)).toBe(5);

    const originalAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(originalAfter?.status).toBe("SUPERSEDED");

    const correctionCredits = await app.prisma.section9Credit.findMany({
      where: { supersedesId: creditId },
    });
    expect(correctionCredits).toHaveLength(1);
    const revision1 = correctionCredits[0];
    expect(revision1.status).toBe("CONFIRMED");
    expect(revision1.revision).toBe(1);
    expect(revision1.sickRequestId).toBe(sickId);
    expect(revision1.vacationRequestId).toBe(vacId);
    expect(revision1.creditedStart?.toISOString().slice(0, 10)).toBe("2028-02-14");
    expect(revision1.creditedEnd?.toISOString().slice(0, 10)).toBe("2028-02-15");
    expect(Number(revision1.creditedDays)).toBe(2);

    const supersedeAudit = await app.prisma.auditLog.findFirst({
      where: { action: "SECTION9_CREDIT_SUPERSEDED", entity: "Section9Credit", entityId: creditId },
    });
    expect(supersedeAudit).not.toBeNull();
    const correctedAudit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SECTION9_CREDIT_CORRECTED",
        entity: "Section9Credit",
        entityId: revision1.id,
      },
    });
    expect(correctedAudit).not.toBeNull();
    const correctedNewVal = correctedAudit?.newValue as {
      supersedesId?: string;
      revision?: number;
      creditedDays?: number;
    } | null;
    expect(correctedNewVal?.supersedesId).toBe(creditId);
    expect(correctedNewVal?.revision).toBe(1);
    expect(correctedNewVal?.creditedDays).toBe(2);

    partialVacId = vacId;
    partialSickId = sickId;
    partialOriginalCreditId = creditId;
    partialRevision1Id = revision1.id;
  });

  it("A-3 second correction: narrowing the SAME vacation again supersedes the revision-1 credit and replaces it with a revision-2 credit for what remains", async () => {
    const correctRes2 = await correct(partialVacId, {
      startDate: "2028-02-07",
      endDate: "2028-02-14",
    });
    expect(correctRes2.statusCode).toBe(200);
    expect(Number(JSON.parse(correctRes2.body).days)).toBe(6);
    expect(await getVacationUsed(2028)).toBe(5);
    expect(await getEntitlementSelfHeal(2028)).toBe(5);

    const revision1After = await app.prisma.section9Credit.findUnique({
      where: { id: partialRevision1Id },
    });
    expect(revision1After?.status).toBe("SUPERSEDED");
    // The original (revision 0) stays SUPERSEDED, untouched by this second correction.
    const originalStillSuperseded = await app.prisma.section9Credit.findUnique({
      where: { id: partialOriginalCreditId },
    });
    expect(originalStillSuperseded?.status).toBe("SUPERSEDED");

    const revision2Candidates = await app.prisma.section9Credit.findMany({
      where: { supersedesId: partialRevision1Id },
    });
    expect(revision2Candidates).toHaveLength(1);
    const revision2 = revision2Candidates[0];
    expect(revision2.revision).toBe(2);
    expect(revision2.sickRequestId).toBe(partialSickId);
    expect(revision2.vacationRequestId).toBe(partialVacId);
    expect(revision2.creditedStart?.toISOString().slice(0, 10)).toBe("2028-02-14");
    expect(revision2.creditedEnd?.toISOString().slice(0, 10)).toBe("2028-02-14");
    expect(Number(revision2.creditedDays)).toBe(1);
  });

  it("type change: correcting the vacation's TYPE away from VACATION fully supersedes its confirmed credit (no partial cancellation)", async () => {
    const usedBeforeApprove = await getVacationUsed(2028); // continues the shared 2028 entitlement row
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2028-04-03",
      endDate: "2028-04-07",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    await approve(vacId);
    expect(await getVacationUsed(2028)).toBe(usedBeforeApprove + 5);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2028-04-05",
      endDate: "2028-04-07",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    const creditId = credit!.id;
    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2028-04-05",
      attestValidTo: "2028-04-07",
    });
    expect(confirmRes.statusCode).toBe(200);
    const usedBeforeTypeChange = await getVacationUsed(2028);

    // RED proof (see SUMMARY): before this plan's fix, a type change netted the credit's
    // creditedDays against the reversed OLD gross and drove usedDays NEGATIVE relative to the
    // vacation's own contribution — the credit must instead be unconditionally undone.
    const correctRes = await correct(vacId, {
      startDate: "2028-04-03",
      endDate: "2028-04-07",
      type: "SICK",
    });
    expect(correctRes.statusCode).toBe(200);
    // Reverse the OLD 5-day VACATION gross (-5) AND undo the credit's earlier give-back (+3):
    // usedBeforeTypeChange - 5 + 3. The NEW side (SICK) books nothing. This lands exactly back
    // at the PRE-approval baseline (usedBeforeApprove) — the whole request's net contribution
    // to the VACATION ledger is now zero, since none of its days are VACATION any more.
    expect(await getVacationUsed(2028)).toBe(usedBeforeTypeChange - 5 + 3);
    expect(await getVacationUsed(2028)).toBe(usedBeforeApprove);
    expect(await getEntitlementSelfHeal(2028)).toBe(usedBeforeApprove);

    const creditAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(creditAfter?.status).toBe("SUPERSEDED");
    // No replacement correction credit — a type change never clips, it fully supersedes.
    const replacements = await app.prisma.section9Credit.findMany({
      where: { supersedesId: creditId },
    });
    expect(replacements).toHaveLength(0);
  });

  it("sick side: correcting the SICK request's own range so a confirmed credit no longer covers all of it clips/supersedes exactly the same way", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2028-05-08",
      endDate: "2028-05-19",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    await approve(vacId);
    const usedBefore = await getVacationUsed(2028);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2028-05-17",
      endDate: "2028-05-19",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    const creditId = credit!.id;
    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2028-05-17",
      attestValidTo: "2028-05-19",
    });
    expect(confirmRes.statusCode).toBe(200);
    const creditedDays = Number(JSON.parse(confirmRes.body).creditedDays);
    expect(creditedDays).toBe(3);
    expect(await getVacationUsed(2028)).toBe(usedBefore - 3);

    // Correct the SICK request itself — shrink it to one day.
    const correctRes = await correct(sickId, { startDate: "2028-05-17", endDate: "2028-05-17" });
    expect(correctRes.statusCode).toBe(200);

    // The old credit (3 days) is undone (+3), a 1-day replacement is re-credited (-1): net +2
    // relative to right after confirm.
    expect(await getVacationUsed(2028)).toBe(usedBefore - 3 + 3 - 1);
    expect(await getEntitlementSelfHeal(2028)).toBe(usedBefore - 3 + 3 - 1);

    const originalAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(originalAfter?.status).toBe("SUPERSEDED");
    const replacements = await app.prisma.section9Credit.findMany({
      where: { supersedesId: creditId },
    });
    expect(replacements).toHaveLength(1);
    expect(replacements[0].creditedStart?.toISOString().slice(0, 10)).toBe("2028-05-17");
    expect(replacements[0].creditedEnd?.toISOString().slice(0, 10)).toBe("2028-05-17");
    expect(Number(replacements[0].creditedDays)).toBe(1);
    expect(replacements[0].sickRequestId).toBe(sickId);
    expect(replacements[0].vacationRequestId).toBe(vacId);
  });

  it("cross-year: a corrected range that moves a confirmed credit entirely outside leaves both years' ledgers equal to self-heal (no stray -3 in the origin year)", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2027-12-27",
      endDate: "2028-01-07",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    await approve(vacId);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2027-12-29",
      endDate: "2027-12-31",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    const creditId = credit!.id;
    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2027-12-29",
      attestValidTo: "2027-12-31",
    });
    expect(confirmRes.statusCode).toBe(200);

    // Move the vacation entirely into 2028 — the credit (12-29..12-31, 2027) now falls fully
    // outside the new range.
    const correctRes = await correct(vacId, { startDate: "2028-01-03", endDate: "2028-01-07" });
    expect(correctRes.statusCode).toBe(200);

    const creditAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(creditAfter?.status).toBe("SUPERSEDED");

    expect(await getVacationUsed(2027)).toBe(await getEntitlementSelfHeal(2027));
    expect(await getVacationUsed(2028)).toBe(await getEntitlementSelfHeal(2028));
  });

  it("guards: confirm/reject on a SUPERSEDED credit is rejected 409 (T-468-20)", async () => {
    const vac1 = await createRequest({
      type: "VACATION",
      startDate: "2028-06-05",
      endDate: "2028-06-16",
    });
    const vac1Id = JSON.parse(vac1.body).id as string;
    await approve(vac1Id);
    const sick1 = await createRequest({
      type: "SICK",
      startDate: "2028-06-14",
      endDate: "2028-06-16",
    });
    const sick1Id = JSON.parse(sick1.body).id as string;
    await approve(sick1Id);
    const credit1 = await app.prisma.section9Credit.findFirst({
      where: { sickRequestId: sick1Id },
    });
    const credit1Id = credit1!.id;
    await confirmSection9(credit1Id, {
      attestValidFrom: "2028-06-14",
      attestValidTo: "2028-06-16",
    });
    await correct(vac1Id, { startDate: "2028-06-05", endDate: "2028-06-13" });
    const credit1After = await app.prisma.section9Credit.findUnique({ where: { id: credit1Id } });
    expect(credit1After?.status).toBe("SUPERSEDED");

    const confirmSuperseded = await confirmSection9(credit1Id, {
      attestValidFrom: "2028-06-14",
      attestValidTo: "2028-06-16",
    });
    expect(confirmSuperseded.statusCode).toBe(409);
    expect(JSON.parse(confirmSuperseded.body).error).toBe(
      "Der Vorgang ist durch eine Korrektur überholt.",
    );
    const rejectSuperseded = await app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${credit1Id}/reject`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { reason: "Testablehnung" },
    });
    expect(rejectSuperseded.statusCode).toBe(409);
    expect(JSON.parse(rejectSuperseded.body).error).toBe(
      "Der Vorgang ist durch eine Korrektur überholt.",
    );
  });

  it("guards: an AU_PENDING credit whose overlap only partially stays inside a corrected range is clipped to the vacation's CURRENT range at confirm time", async () => {
    const vac2 = await createRequest({
      type: "VACATION",
      startDate: "2028-07-03",
      endDate: "2028-07-14",
    });
    const vac2Id = JSON.parse(vac2.body).id as string;
    await approve(vac2Id);
    const sick2 = await createRequest({
      type: "SICK",
      startDate: "2028-07-12",
      endDate: "2028-07-14",
    });
    const sick2Id = JSON.parse(sick2.body).id as string;
    await approve(sick2Id);
    const credit2 = await app.prisma.section9Credit.findFirst({
      where: { sickRequestId: sick2Id },
    });
    const credit2Id = credit2!.id;

    // Shorten the vacation by one day BEFORE confirming — the still-AU_PENDING credit's own
    // overlap field is untouched (D-04: AU_PENDING partial overlap is left alone by /correct).
    const correctVac2 = await correct(vac2Id, { startDate: "2028-07-03", endDate: "2028-07-13" });
    expect(correctVac2.statusCode).toBe(200);
    const credit2AfterCorrect = await app.prisma.section9Credit.findUnique({
      where: { id: credit2Id },
    });
    expect(credit2AfterCorrect?.status).toBe("AU_PENDING");

    const confirmPartial = await confirmSection9(credit2Id, {
      attestValidFrom: "2028-07-12",
      attestValidTo: "2028-07-14",
    });
    expect(confirmPartial.statusCode).toBe(200);
    const confirmPartialBody = JSON.parse(confirmPartial.body);
    expect(confirmPartialBody.creditedStart).toBe("2028-07-12");
    expect(confirmPartialBody.creditedEnd).toBe("2028-07-13"); // clipped to the CURRENT range
    expect(Number(confirmPartialBody.creditedDays)).toBe(2);
  });

  it("guards: an AU_PENDING credit left fully outside after a correction is superseded with no ledger effect (nothing was ever booked)", async () => {
    const vac3 = await createRequest({
      type: "VACATION",
      startDate: "2028-08-07",
      endDate: "2028-08-18",
    });
    const vac3Id = JSON.parse(vac3.body).id as string;
    await approve(vac3Id);
    const usedBeforeSick3 = await getVacationUsed(2028);
    const sick3 = await createRequest({
      type: "SICK",
      startDate: "2028-08-16",
      endDate: "2028-08-18",
    });
    const sick3Id = JSON.parse(sick3.body).id as string;
    await approve(sick3Id);
    const credit3 = await app.prisma.section9Credit.findFirst({
      where: { sickRequestId: sick3Id },
    });
    const credit3Id = credit3!.id;
    expect(credit3?.status).toBe("AU_PENDING");
    const usedAfterSick3Approve = await getVacationUsed(2028);
    expect(usedAfterSick3Approve).toBe(usedBeforeSick3); // D-09: detection is effect-free

    const correctVac3 = await correct(vac3Id, { startDate: "2028-08-07", endDate: "2028-08-11" });
    expect(correctVac3.statusCode).toBe(200);
    const credit3After = await app.prisma.section9Credit.findUnique({ where: { id: credit3Id } });
    expect(credit3After?.status).toBe("SUPERSEDED");
    // No ledger write for an AU_PENDING supersede — only the gross reverse/apply moved usedDays.
    const newDays3 = Number(JSON.parse(correctVac3.body).days);
    expect(await getVacationUsed(2028)).toBe(usedAfterSick3Approve - 10 + newDays3);
  });

  it("reads: GET /requests omits section9Status for a request whose only credit is superseded; GET /section9?status=SUPERSEDED lists overholt rows (was 400)", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2028-09-04",
      endDate: "2028-09-15",
    });
    const vacId = JSON.parse(vac.body).id as string;
    await approve(vacId);
    const sick = await createRequest({
      type: "SICK",
      startDate: "2028-09-13",
      endDate: "2028-09-15",
    });
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    const creditId = credit!.id;
    await confirmSection9(creditId, { attestValidFrom: "2028-09-13", attestValidTo: "2028-09-15" });
    await correct(vacId, { startDate: "2028-09-04", endDate: "2028-09-12" });
    const creditAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(creditAfter?.status).toBe("SUPERSEDED");

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests?employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body) as Array<{ id: string; section9Status: unknown }>;
    const vacRow = listBody.find((r) => r.id === vacId);
    expect(vacRow).toBeTruthy();
    expect(vacRow?.section9Status).toBeNull();

    const section9ListRes = await app.inject({
      method: "GET",
      url: "/api/v1/leave/section9?status=SUPERSEDED",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(section9ListRes.statusCode).toBe(200);
    const section9ListBody = JSON.parse(section9ListRes.body) as Array<{
      id: string;
      status: string;
    }>;
    expect(section9ListBody.some((r) => r.id === creditId && r.status === "SUPERSEDED")).toBe(true);
  });

  // ── Issue #468 code review (2026-10-03): CR-01/WR-02/WR-03 regression guards ────────────

  /** Seed a MONTHLY superseded:false SaldoSnapshot = "month is closed/locked" (same fixture
   * shape as leave-correct.test.ts's own `lockMonth`). */
  async function lockMonth(employeeId: string, year: number, month: number) {
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: new Date(Date.UTC(year, month - 1, 1)),
        periodEnd: new Date(Date.UTC(year, month, 0)),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });
  }

  async function getEntitlementUsed(leaveTypeId: string, year: number): Promise<number> {
    const e = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId, year },
    });
    return Number(e?.usedDays ?? -999);
  }

  it("CR-01: a CONFIRMED § 9 credit against a non-VACATION (UNPAID) leave request is clawed back exactly once when /correct moves it fully outside the new range", async () => {
    const unpaid = await createRequest({
      type: "UNPAID",
      startDate: "2029-06-01",
      endDate: "2029-06-12",
    });
    expect(unpaid.statusCode).toBe(201);
    const unpaidId = JSON.parse(unpaid.body).id as string;
    await approve(unpaidId);

    const unpaidType = await app.prisma.leaveType.findFirst({
      where: { tenantId: data.tenant.id, code: "UNPAID" },
    });
    expect(unpaidType).not.toBeNull();
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: unpaidType!.id,
      years: [2029],
    });
    // UNPAID is entitlement-neutral on approval (leave.ts only deducts for VACATION), so a
    // freshly-seeded row starts at usedDays=0 — give it a non-zero baseline so the claw-back
    // below is observable instead of landing on an already-correct 0.
    const unpaidEnt = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId: unpaidType!.id, year: 2029 },
    });
    await app.prisma.leaveEntitlement.update({
      where: { id: unpaidEnt!.id },
      data: { usedDays: 5 },
    });

    const sick = await createRequest({
      type: "SICK",
      startDate: "2029-06-10",
      endDate: "2029-06-12",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    expect(credit).not.toBeNull();
    const creditId = credit!.id;

    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2029-06-10",
      attestValidTo: "2029-06-12",
    });
    expect(confirmRes.statusCode).toBe(200);
    const creditedDays = Number(JSON.parse(confirmRes.body).creditedDays);
    expect(creditedDays).toBeGreaterThan(0);
    expect(await getEntitlementUsed(unpaidType!.id, 2029)).toBe(5 - creditedDays);

    // CR-01: shorten the UNPAID request's tail so the credit's range is now fully outside.
    const correctRes = await correct(unpaidId, {
      startDate: "2029-06-01",
      endDate: "2029-06-09",
    });
    expect(correctRes.statusCode).toBe(200);

    const creditAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(creditAfter?.status).toBe("SUPERSEDED");

    // Before the fix: the undo was gated on leaveType.code === "VACATION" and never ran for
    // UNPAID, permanently stranding the give-back at (5 - creditedDays) — a silent, permanent
    // over-credit. The fix claws it back exactly once, restoring the pre-confirm baseline.
    expect(await getEntitlementUsed(unpaidType!.id, 2029)).toBe(5);
  });

  it("CR-01: a CONFIRMED § 9 credit against a non-VACATION (UNPAID) leave request, partially clipped by /correct, is undone and re-credited for exactly the clipped remainder", async () => {
    const unpaid = await createRequest({
      type: "UNPAID",
      startDate: "2029-07-01",
      endDate: "2029-07-12",
    });
    expect(unpaid.statusCode).toBe(201);
    const unpaidId = JSON.parse(unpaid.body).id as string;
    await approve(unpaidId);

    const unpaidType = await app.prisma.leaveType.findFirst({
      where: { tenantId: data.tenant.id, code: "UNPAID" },
    });
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: unpaidType!.id,
      years: [2029],
    });
    const unpaidEnt = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId: unpaidType!.id, year: 2029 },
    });
    await app.prisma.leaveEntitlement.update({
      where: { id: unpaidEnt!.id },
      data: { usedDays: 5 },
    });

    const sick = await createRequest({
      type: "SICK",
      startDate: "2029-07-10",
      endDate: "2029-07-12",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    const creditId = credit!.id;
    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2029-07-10",
      attestValidTo: "2029-07-12",
    });
    expect(confirmRes.statusCode).toBe(200);
    const creditedDays = Number(JSON.parse(confirmRes.body).creditedDays);
    expect(creditedDays).toBeGreaterThan(0);
    const usedAfterConfirm = await getEntitlementUsed(unpaidType!.id, 2029);
    expect(usedAfterConfirm).toBe(5 - creditedDays);

    // Shorten the tail by one day — the credit (07-10..07-12) now only PARTIALLY overlaps.
    const correctRes = await correct(unpaidId, {
      startDate: "2029-07-01",
      endDate: "2029-07-11",
    });
    expect(correctRes.statusCode).toBe(200);

    const originalAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(originalAfter?.status).toBe("SUPERSEDED");
    const replacements = await app.prisma.section9Credit.findMany({
      where: { supersedesId: creditId },
    });
    expect(replacements).toHaveLength(1);
    const clippedDays = Number(replacements[0].creditedDays);
    expect(clippedDays).toBeGreaterThan(0);
    expect(clippedDays).toBeLessThan(creditedDays); // strictly the clipped part, not the whole

    // Before the fix: Step 10b's re-credit was ALSO gated on vacationTypeCode === "VACATION",
    // so for UNPAID the clip would undo the full original credit (claw-back) but never
    // re-apply the still-covered remainder, leaving the ledger PERMANENTLY short by
    // `clippedDays`. The fix re-credits exactly the clipped part: net movement is
    // (+creditedDays undo) - (clippedDays re-credit), i.e. usedDays ends up HIGHER than right
    // after confirm by (creditedDays - clippedDays) — never losing the clipped days.
    const expectedUsed = usedAfterConfirm + creditedDays - clippedDays;
    expect(await getEntitlementUsed(unpaidType!.id, 2029)).toBe(expectedUsed);
  });

  it("WR-03: a § 9 ledger write that touches a locked month OUTSIDE the correction's own delta-lock range is blocked (409), not silently booked", async () => {
    // Vacation spans April into May; the sick/credit range straddles the same boundary
    // (04-28..05-02). Shrinking the vacation's tail to end in April removes only MAY days from
    // the delta-lock's own symmetric diff — April stays in the retained intersection and is
    // NOT type/halfDay-changed, so computeAffectedMonths above never flags April. But Step 8b's
    // ledger UNDO always targets the credit's OWN creditedStart (04-28) through creditedEnd
    // (05-02) — which includes April days the delta-lock never checked. Locking April alone
    // (May stays open) must still block the correction.
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2029],
    });

    const vac = await createRequest({
      type: "VACATION",
      startDate: "2029-04-20",
      endDate: "2029-05-10",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    await approve(vacId);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2029-04-28",
      endDate: "2029-05-02",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    expect(credit).not.toBeNull();
    const creditId = credit!.id;

    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2029-04-28",
      attestValidTo: "2029-05-02",
    });
    expect(confirmRes.statusCode).toBe(200);
    const usedAfterConfirm = await getEntitlementUsed(data.vacationType.id, 2029);

    // Lock April only AFTER create/approve/confirm — the pre-468 closed-month TRANSITION
    // guard (Issue #446) blocks CREATING/APPROVING a request that touches an already-closed
    // month, which would reject the fixture setup above for the wrong reason.
    await lockMonth(data.employee.id, 2029, 4);

    // Shrink the vacation's tail into April only — removes May 1-10 (delta-lock sees MAY as
    // affected, never April), but the credit's own creditedStart (04-28) is in April.
    const correctRes = await correct(vacId, { startDate: "2029-04-20", endDate: "2029-04-30" });
    expect(correctRes.statusCode).toBe(409);
    expect(JSON.parse(correctRes.body).error).toBe("Gesperrter Monat — Korrektur nicht möglich");

    // Nothing was written: the vacation request, the credit and the ledger are all unchanged.
    const vacAfter = await app.prisma.leaveRequest.findUnique({ where: { id: vacId } });
    expect(vacAfter?.endDate.toISOString().slice(0, 10)).toBe("2029-05-10");
    const creditAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(creditAfter?.status).toBe("CONFIRMED");
    expect(await getEntitlementUsed(data.vacationType.id, 2029)).toBe(usedAfterConfirm);
  });

  it("WR-02: a /correct call racing a concurrent writer that already superseded the same credit is rejected (409), never double-undoing the ledger", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2029-08-01",
      endDate: "2029-08-12",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    await approve(vacId);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2029-08-10",
      endDate: "2029-08-12",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirst({ where: { sickRequestId: sickId } });
    const creditId = credit!.id;
    const confirmRes = await confirmSection9(creditId, {
      attestValidFrom: "2029-08-10",
      attestValidTo: "2029-08-12",
    });
    expect(confirmRes.statusCode).toBe(200);
    const usedAfterConfirm = await getEntitlementUsed(data.vacationType.id, 2029);

    // Deterministic reproduction of the race (Issue #468 review, WR-02): an interactive
    // transaction holds an UNCOMMITTED UPDATE lock on the credit row (status -> SUPERSEDED,
    // simulating a concurrent writer that reached Step 8b first) while `/correct` is fired —
    // `touchingSection9Credits`'s own pre-transaction read runs OUTSIDE any transaction
    // (plain SELECT, READ COMMITTED) and therefore still sees the pre-lock CONFIRMED status,
    // classifying the credit for supersede exactly as the real race requires. `/correct`'s own
    // `updateMany` then BLOCKS on the same row lock; releasing the lock (committing the
    // concurrent writer) lets it proceed and re-evaluate `status: { not: "SUPERSEDED" }`
    // against the now-current (SUPERSEDED) value — 0 rows match, so the fix's optimistic-lock
    // guard throws before `deductVacationDays` ever runs a second time.
    let releaseLock: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const concurrentWriterTx = app.prisma.$transaction(async (tx) => {
      await tx.section9Credit.update({ where: { id: creditId }, data: { status: "SUPERSEDED" } });
      await lockHeld; // hold the row lock open until released below
    });

    // Give the concurrent writer's UPDATE time to acquire the row lock before /correct's own
    // pre-transaction read runs.
    await new Promise((r) => setTimeout(r, 50));

    const correctPromise = correct(sickId, { startDate: "2029-08-20", endDate: "2029-08-20" });

    // Give /correct time to run its pre-transaction read and reach (and block on) the same
    // row's UPDATE inside its own transaction.
    await new Promise((r) => setTimeout(r, 50));

    releaseLock!();
    await concurrentWriterTx;

    const correctRes = await correctPromise;
    expect(correctRes.statusCode).toBe(409);
    expect(JSON.parse(correctRes.body).error).toBe(
      "Gleichzeitige Änderung der § 9-Gutschrift — bitte erneut versuchen.",
    );

    // Nothing from the LOSING /correct call was applied: the credit stays exactly as the
    // concurrent writer left it (SUPERSEDED), the sick request's dates are unchanged, and —
    // the actual bug WR-02 fixes — the ledger undo ran NEITHER zero NOR twice via /correct;
    // the concurrent writer itself never touched the ledger (it only flipped status, mirroring
    // "a second replacement row is not the issue — a second unconditional ledger write is").
    const creditAfter = await app.prisma.section9Credit.findUnique({ where: { id: creditId } });
    expect(creditAfter?.status).toBe("SUPERSEDED");
    const sickAfter = await app.prisma.leaveRequest.findUnique({ where: { id: sickId } });
    expect(sickAfter?.endDate.toISOString().slice(0, 10)).toBe("2029-08-12");
    expect(await getEntitlementUsed(data.vacationType.id, 2029)).toBe(usedAfterConfirm);
  });
});
