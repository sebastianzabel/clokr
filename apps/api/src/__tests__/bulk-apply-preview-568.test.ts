/**
 * Issue #568 — the bulk apply of the tenant's default working time is a two-step flow: a read-only,
 * server-computed preview with a fingerprint, then an apply that accepts only a selection inside
 * the server's own candidate set, only with the matching fingerprint, never retroactively.
 *
 * Why: on 04.10.2026 the one-step apply turned an individual 16 h Mo-Do contract into 40 h Mo-Fr,
 * retroactively and without confirmation. Agreed working time is contract content (§ 611a BGB); a
 * change must be communicated at the latest on the day it takes effect (§ 3 Satz 1 NachwG).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import {
  TEST_TZ,
  earliestBulkEffectiveFromStr,
  firstOfNextMonthInstant,
  midMonthInstant,
  monthFirstAheadStr,
  todayStr,
} from "./test-dates";
import { applyBulkDefaults, previewBulkApply, type BulkPreviewBody } from "./bulk-apply-helpers";

const DEFAULTS_40 = {
  defaultWeeklyHours: 40,
  defaultMondayHours: 8,
  defaultTuesdayHours: 8,
  defaultWednesdayHours: 8,
  defaultThursdayHours: 8,
  defaultFridayHours: 8,
  defaultSaturdayHours: 0,
  defaultSundayHours: 0,
};

// Differs from the stored defaults of every seeded tenant (40 h) on purpose.
const DEFAULTS_38 = {
  defaultWeeklyHours: 38,
  defaultMondayHours: 7.6,
  defaultTuesdayHours: 7.6,
  defaultWednesdayHours: 7.6,
  defaultThursdayHours: 7.6,
  defaultFridayHours: 7.6,
  defaultSaturdayHours: 0,
  defaultSundayHours: 0,
};

type Fixture = Awaited<ReturnType<typeof seedTestData>>;
type ScheduleKind = "individual16" | "shift" | "none";

describe("Issue #568 — bulk apply preview and guarded apply", () => {
  let app: FastifyInstance;
  const fixtures: Fixture[] = [];

  async function newTenant(label: string): Promise<Fixture> {
    const fixture = await seedTestData(app, `bulk568-${label}`);
    fixtures.push(fixture);
    return fixture;
  }

  async function mkEmployee(
    tenantId: string,
    label: string,
    schedule: ScheduleKind,
    extra: { overtimeMode?: string; maxNegativeBalanceMinutes?: number } = {},
  ): Promise<string> {
    const uid = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `bulk568-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `B568-${uid}`,
        firstName: `Vor${label}`,
        lastName: `Schau${label}`,
        hireDate: new Date("2024-01-01"),
      },
    });
    if (schedule === "individual16") {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          weeklyHours: 16,
          mondayHours: 4,
          tuesdayHours: 4,
          wednesdayHours: 4,
          thursdayHours: 4,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4],
          validFrom: new Date("2024-01-01"),
          ...extra,
        },
      });
    } else if (schedule === "shift") {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: 30,
          contractWorkDaysPerWeek: 4,
          validFrom: new Date("2024-01-01"),
        },
      });
    }
    return employee.id;
  }

  async function rawPreview(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/settings/work/apply-defaults/preview",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  async function putWork(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  /** Every row-count / config fact that a refused apply must leave untouched. */
  async function stateOf(fixture: Fixture) {
    const employeeIds = (
      await app.prisma.employee.findMany({
        where: { tenantId: fixture.tenant.id },
        select: { id: true },
      })
    ).map((e) => e.id);
    return {
      schedules: await app.prisma.workSchedule.count({
        where: { employeeId: { in: employeeIds } },
      }),
      audits: await app.prisma.auditLog.count({ where: { userId: fixture.adminUser.id } }),
      config: await app.prisma.tenantConfig.findUnique({
        where: { tenantId: fixture.tenant.id },
        select: { updatedAt: true, defaultWeeklyHours: true, overtimeThreshold: true },
      }),
    };
  }

  async function schedulesOf(employeeId: string) {
    return app.prisma.workSchedule.findMany({
      where: { employeeId },
      orderBy: { validFrom: "asc" },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    for (const fixture of fixtures) await cleanupTestData(app, fixture.tenant.id);
    await closeTestApp();
  });

  describe("preview", () => {
    let data: Fixture;
    let individualId = "";
    let noContractId = "";
    let shiftId = "";

    beforeAll(async () => {
      data = await newTenant("preview");
      individualId = await mkEmployee(data.tenant.id, "Ind", "individual16");
      noContractId = await mkEmployee(data.tenant.id, "Non", "none");
      shiftId = await mkEmployee(data.tenant.id, "Shf", "shift");
    });

    it("P1: classifies the workforce and answers the response contract", async () => {
      const res = await rawPreview(data.adminToken, DEFAULTS_40);
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as BulkPreviewBody;

      const individual = body.candidates.find((c) => c.employeeId === individualId);
      expect(individual?.category).toBe("INDIVIDUAL");
      expect(individual?.defaultSelected).toBe(false);
      expect(individual?.before?.weeklyHours).toBe(16);
      expect(individual?.before?.workDays).toEqual([1, 2, 3, 4]);
      expect(individual?.after.weeklyHours).toBe(40);
      expect(individual?.after.workDays).toEqual([1, 2, 3, 4, 5]);

      const none = body.candidates.find((c) => c.employeeId === noContractId);
      expect(none?.category).toBe("NO_CONTRACT");
      expect(none?.defaultSelected).toBe(true);
      expect(none?.before).toBeNull();

      // The seeded admin and employee have a 40 h Mo-Fr contract = the proposal: not candidates.
      expect(body.candidates.map((c) => c.employeeId)).not.toContain(data.employee.id);
      expect(
        body.nonCandidates
          .find((g) => g.reason === "ALREADY_MATCHES_NEW")
          ?.employees.map((e) => e.employeeId),
      ).toContain(data.employee.id);

      expect(body.candidates.map((c) => c.employeeId)).not.toContain(shiftId);
      const other = body.nonCandidates.find((g) => g.reason === "OTHER_SCHEDULE_TYPE");
      expect(other?.employees.map((e) => e.employeeId)).toContain(shiftId);
      expect(other?.count).toBe(other?.employees.length);

      expect(body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(body.effectiveFrom).toBe(body.earliestEffectiveFrom);
      expect(body.allowedEffectiveFrom[0]).toBe(body.earliestEffectiveFrom);
      expect(body.earliestEffectiveFrom.endsWith("-01")).toBe(true);
      expect(body.earliestEffectiveFrom >= todayStr()).toBe(true);
      expect(body.latestEffectiveFrom).toBe(
        body.allowedEffectiveFrom[body.allowedEffectiveFrom.length - 1],
      );
    });

    it("P2: writes no TenantConfig, WorkSchedule or AuditLog row (D-09 g)", async () => {
      const before = await stateOf(data);
      expect(
        (await rawPreview(data.adminToken, { ...DEFAULTS_40, defaultWeeklyHours: 36 })).statusCode,
      ).toBe(200);
      expect((await rawPreview(data.adminToken, DEFAULTS_40)).statusCode).toBe(200);
      expect(await stateOf(data)).toEqual(before);
    });

    it("P3: an effectiveFrom that is not a month-first answers 400 BULK_APPLY_NOT_MONTH_FIRST", async () => {
      const res = await rawPreview(data.adminToken, {
        ...DEFAULTS_40,
        effectiveFrom: "2099-01-15",
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(JSON.parse(res.body).code).toBe("BULK_APPLY_NOT_MONTH_FIRST");
    });

    it("P5: a contract stored at the LOCAL midnight of effectiveFrom (previous UTC day) is at the date, not a candidate (review WR-01)", async () => {
      const effectiveFrom = monthFirstAheadStr(2);
      const hireId = await mkEmployee(data.tenant.id, "Hir", "none");
      // A hire contract of the 1st: employee creation stores validFrom = new Date(hireDate), an
      // instant — local midnight Europe/Berlin is 22:00 or 23:00 UTC of the PREVIOUS day.
      const localMidnight = fromZonedTime(`${effectiveFrom}T00:00:00`, TEST_TZ);
      expect(localMidnight.toISOString().slice(0, 10) < effectiveFrom).toBe(true);
      await app.prisma.workSchedule.create({
        data: {
          employeeId: hireId,
          weeklyHours: 16,
          mondayHours: 4,
          tuesdayHours: 4,
          wednesdayHours: 4,
          thursdayHours: 4,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4],
          validFrom: localMidnight,
        },
      });
      const body = await previewBulkApply(app, data.adminToken, {
        defaults: DEFAULTS_40,
        effectiveFrom,
      });
      expect(body.candidates.map((c) => c.employeeId)).not.toContain(hireId);
      expect(
        body.nonCandidates
          .find((g) => g.reason === "CONTRACT_AT_DATE_EXISTS")
          ?.employees.map((e) => e.employeeId),
      ).toContain(hireId);
    });

    it("P6: a FIXED row whose workDays diverge from its day-hours is INDIVIDUAL, never pre-ticked or ALREADY_MATCHES_NEW (review IN-01)", async () => {
      const legacyId = await mkEmployee(data.tenant.id, "Leg", "none");
      // Legacy row of the Phase 95b kind: Mo-Fr 8 h day-hours, but a workDays list that dropped Friday.
      await app.prisma.workSchedule.create({
        data: {
          employeeId: legacyId,
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4],
          validFrom: new Date("2024-01-01"),
        },
      });
      // Against the unchanged 40 h defaults the hours alone would be "already matches new".
      const body = await previewBulkApply(app, data.adminToken, { defaults: DEFAULTS_40 });
      const candidate = body.candidates.find((c) => c.employeeId === legacyId);
      expect(candidate?.category).toBe("INDIVIDUAL");
      expect(candidate?.defaultSelected).toBe(false);
      expect(candidate?.before?.workDays).toEqual([1, 2, 3, 4]);
      expect(candidate?.after.workDays).toEqual([1, 2, 3, 4, 5]);
      expect(
        body.nonCandidates
          .find((g) => g.reason === "ALREADY_MATCHES_NEW")
          ?.employees.map((e) => e.employeeId) ?? [],
      ).not.toContain(legacyId);
    });

    it("P4: a caller without tenant-settings:update gets 403", async () => {
      const res = await rawPreview(data.empToken, DEFAULTS_40);
      expect(res.statusCode, res.body).toBe(403);
    });
  });

  describe("apply", () => {
    // Pinned to the 11th of the current tenant-local month: the earliest allowed effective date is
    // then the 1st of next month under any real-world date, and no month boundary can slide
    // between a preview and its apply.
    const pinnedNow = midMonthInstant();
    const nextMonthFirstNow = firstOfNextMonthInstant();

    beforeAll(() => {
      vi.useFakeTimers({ now: pinnedNow, toFake: ["Date"] });
    });

    afterEach(() => {
      vi.setSystemTime(pinnedNow);
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    /** A fresh tenant with the interesting employee kinds; tokens re-issued at the faked "now". */
    async function scenario(label: string) {
      const data = await newTenant(label);
      const token = reissueTokenNow(app, data.adminToken);
      const individualId = await mkEmployee(data.tenant.id, "Ind", "individual16", {
        overtimeMode: "TRACK_ONLY",
        maxNegativeBalanceMinutes: 600,
      });
      const noContractId = await mkEmployee(data.tenant.id, "Non", "none");
      const shiftId = await mkEmployee(data.tenant.id, "Shf", "shift");
      return {
        data,
        token,
        individualId,
        noContractId,
        shiftId,
        adminEmployeeId: data.adminEmployee.id,
        employeeId: data.employee.id,
      };
    }

    it("(a) applies only the pre-selected employees; the individual 16 h contract stays untouched", async () => {
      const t = await scenario("a");
      const before = await schedulesOf(t.individualId);
      const { res, preview } = await applyBulkDefaults(app, t.token, {
        defaults: DEFAULTS_38,
        employeeIds: "defaultSelected",
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).appliedCount).toBe(3);

      const selectedIds = preview.candidates
        .filter((c) => c.defaultSelected)
        .map((c) => c.employeeId);
      expect(selectedIds.sort()).toEqual([t.adminEmployeeId, t.employeeId, t.noContractId].sort());

      const after = await schedulesOf(t.individualId);
      expect(after).toHaveLength(before.length);
      expect(after[after.length - 1].id).toBe(before[before.length - 1].id);
      expect(Number(after[after.length - 1].weeklyHours)).toBe(16);

      for (const id of selectedIds) {
        const rows = await schedulesOf(id);
        const newest = rows[rows.length - 1];
        expect(newest.validFrom.toISOString().slice(0, 10)).toBe(preview.effectiveFrom);
        expect(Number(newest.weeklyHours)).toBe(38);
        expect(newest.type).toBe("FIXED_SCHEDULE");
      }
    });

    it("(b) an explicitly listed individual contract gets exactly one new row with its terms carried over", async () => {
      const t = await scenario("b");
      const before = await schedulesOf(t.individualId);
      const { res, preview } = await applyBulkDefaults(app, t.token, {
        defaults: DEFAULTS_38,
        employeeIds: [t.individualId],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).appliedCount).toBe(1);

      const after = await schedulesOf(t.individualId);
      expect(after).toHaveLength(before.length + 1);
      const created = after[after.length - 1];
      expect(created.validFrom.toISOString().slice(0, 10)).toBe(preview.effectiveFrom);
      expect(Number(created.weeklyHours)).toBe(38);
      expect(created.workDays).toEqual([1, 2, 3, 4, 5]);
      expect(created.overtimeMode).toBe("TRACK_ONLY");
      expect(created.maxNegativeBalanceMinutes).toBe(600);
      // The other candidates were not listed, so nobody else changed.
      expect(await schedulesOf(t.noContractId)).toHaveLength(0);
    });

    it("(c) a stale preview answers 409 BULK_APPLY_PREVIEW_STALE and writes nothing, not even the config", async () => {
      const t = await scenario("c");

      // 1: a future FIXED contract appears for a candidate after the preview.
      const preview1 = await previewBulkApply(app, t.token, { defaults: DEFAULTS_38 });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: t.employeeId,
          weeklyHours: 20,
          mondayHours: 5,
          tuesdayHours: 5,
          wednesdayHours: 5,
          thursdayHours: 5,
          fridayHours: 0,
          workDays: [1, 2, 3, 4],
          validFrom: new Date(`${monthFirstAheadStr(4)}T00:00:00Z`),
        },
      });
      let baseline = await stateOf(t.data);
      let res = await putWork(t.token, {
        ...DEFAULTS_38,
        applyToExisting: true,
        applyEmployeeIds: [t.noContractId],
        previewFingerprint: preview1.fingerprint,
        effectiveFrom: preview1.effectiveFrom,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).code).toBe("BULK_APPLY_PREVIEW_STALE");
      expect(await stateOf(t.data)).toEqual(baseline);

      // 2: the stored defaults change after the preview.
      const preview2 = await previewBulkApply(app, t.token, { defaults: DEFAULTS_38 });
      await app.prisma.tenantConfig.update({
        where: { tenantId: t.data.tenant.id },
        data: { overtimeThreshold: 61 },
      });
      baseline = await stateOf(t.data);
      res = await putWork(t.token, {
        ...DEFAULTS_38,
        applyToExisting: true,
        applyEmployeeIds: [t.noContractId],
        previewFingerprint: preview2.fingerprint,
        effectiveFrom: preview2.effectiveFrom,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(await stateOf(t.data)).toEqual(baseline);

      // 3: a tampered fingerprint.
      const { res: tampered } = await applyBulkDefaults(app, t.token, {
        defaults: DEFAULTS_38,
        employeeIds: [t.noContractId],
        fingerprint: "0".repeat(64),
      });
      expect(tampered.statusCode, tampered.body).toBe(409);
      expect(JSON.parse(tampered.body).code).toBe("BULK_APPLY_PREVIEW_STALE");
      expect(await stateOf(t.data)).toEqual(baseline);
      expect(baseline.config?.defaultWeeklyHours.toString()).toBe("40");
    });

    it("(d) an id outside the server's candidate set answers 409 and writes nothing", async () => {
      const t = await scenario("d");
      const other = await newTenant("d-foreign");
      const foreignEmployeeId = other.employee.id;
      const baseline = await stateOf(t.data);
      const foreignBaseline = await stateOf(other);
      for (const badId of [t.shiftId, foreignEmployeeId, "5b4c3f2e-9d1a-4c7b-8e6f-0a1b2c3d4e5f"]) {
        const { res } = await applyBulkDefaults(app, t.token, {
          defaults: DEFAULTS_38,
          employeeIds: [t.noContractId, badId],
        });
        expect(res.statusCode, `${badId}: ${res.body}`).toBe(409);
        expect(JSON.parse(res.body).code).toBe("BULK_APPLY_PREVIEW_STALE");
      }
      expect(await stateOf(t.data)).toEqual(baseline);
      expect(await stateOf(other)).toEqual(foreignBaseline);
    });

    it("(e) refuses a missing selection, a retroactive, a too-far and a non-month-first date with 400", async () => {
      const t = await scenario("e");
      const baseline = await stateOf(t.data);
      const fingerprint = "a".repeat(64);
      const full = {
        ...DEFAULTS_38,
        applyToExisting: true,
        applyEmployeeIds: [t.noContractId],
        previewFingerprint: fingerprint,
        effectiveFrom: earliestBulkEffectiveFromStr(),
      };

      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["no trio", { ...DEFAULTS_38, applyToExisting: true }, "BULK_APPLY_SELECTION_REQUIRED"],
        [
          "empty applyEmployeeIds",
          { ...full, applyEmployeeIds: [] },
          "BULK_APPLY_SELECTION_REQUIRED",
        ],
        [
          "missing fingerprint",
          { ...full, previewFingerprint: undefined },
          "BULK_APPLY_SELECTION_REQUIRED",
        ],
        [
          "missing effectiveFrom",
          { ...full, effectiveFrom: undefined },
          "BULK_APPLY_SELECTION_REQUIRED",
        ],
        [
          "1st of the current month",
          { ...full, effectiveFrom: monthFirstAheadStr(0) },
          "BULK_APPLY_RETROACTIVE",
        ],
        [
          "13 months ahead",
          { ...full, effectiveFrom: monthFirstAheadStr(13) },
          "BULK_APPLY_TOO_FAR",
        ],
        [
          "not a month-first",
          { ...full, effectiveFrom: `${monthFirstAheadStr(2).slice(0, 8)}15` },
          "BULK_APPLY_NOT_MONTH_FIRST",
        ],
      ];
      for (const [label, payload, code] of cases) {
        const res = await putWork(t.token, payload);
        expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code, label).toBe(code);
        expect(typeof body.error, label).toBe("string");
        expect(await stateOf(t.data), label).toEqual(baseline);
      }
    });

    it("(f) audits one CREATE per applied employee and one ids-only BULK_APPLY row", async () => {
      const t = await scenario("f");
      const { res, preview } = await applyBulkDefaults(app, t.token, {
        defaults: DEFAULTS_38,
        employeeIds: [t.individualId, t.noContractId],
      });
      expect(res.statusCode, res.body).toBe(200);

      const creates = await app.prisma.auditLog.findMany({
        where: { userId: t.data.adminUser.id, action: "CREATE", entity: "WorkSchedule" },
      });
      expect(creates).toHaveLength(2);
      const created = await app.prisma.workSchedule.findMany({
        where: {
          employeeId: { in: [t.individualId, t.noContractId] },
          validFrom: { gte: new Date(`${preview.effectiveFrom}T00:00:00Z`) },
        },
      });
      expect(created).toHaveLength(2);
      const byEntity = new Map(creates.map((row) => [row.entityId, row]));
      const individualRow = byEntity.get(
        created.find((c) => c.employeeId === t.individualId)?.id ?? "",
      );
      const noContractRow = byEntity.get(
        created.find((c) => c.employeeId === t.noContractId)?.id ?? "",
      );
      expect(individualRow?.oldValue).toBeTruthy();
      expect(noContractRow?.oldValue ?? null).toBeNull();

      const config = await app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: t.data.tenant.id },
      });
      const bulk = await app.prisma.auditLog.findMany({
        where: { userId: t.data.adminUser.id, action: "BULK_APPLY" },
      });
      expect(bulk).toHaveLength(1);
      expect(bulk[0].entity).toBe("TenantConfig");
      expect(bulk[0].entityId).toBe(config.id);
      const value = bulk[0].newValue as Record<string, unknown>;
      expect(value.appliedEmployeeIds).toEqual([t.individualId, t.noContractId].sort());
      const deselected = preview.candidates
        .map((c) => c.employeeId)
        .filter((id) => id !== t.individualId && id !== t.noContractId)
        .sort();
      expect(deselected.length).toBeGreaterThan(0);
      expect(value.deselectedCandidateIds).toEqual(deselected);
      expect(value.previewFingerprint).toBe(preview.fingerprint);
      expect(value.effectiveFrom).toBe(preview.effectiveFrom);
      expect(value.values).toBeTruthy();
      // Ids only: no seeded person name appears anywhere in the row.
      const json = JSON.stringify(value);
      expect(json).not.toContain("VorInd");
      expect(json).not.toContain("SchauInd");
      expect(json).not.toContain("VorNon");
      expect(json).not.toContain("Admin");

      const update = await app.prisma.auditLog.findMany({
        where: { userId: t.data.adminUser.id, action: "UPDATE", entity: "TenantConfig" },
      });
      expect(update).toHaveLength(1);
      const updateValue = update[0].newValue as Record<string, unknown>;
      expect(updateValue.appliedCount).toBe(2);
      expect(updateValue).not.toHaveProperty("applyEmployeeIds");
      expect(updateValue).not.toHaveProperty("previewFingerprint");
    });

    it("(h) on the 1st of a month that very day is the earliest date and the apply runs the saldo path", async () => {
      const t = await scenario("h");
      vi.setSystemTime(nextMonthFirstNow);
      const token = reissueTokenNow(app, t.data.adminToken);
      const preview = await previewBulkApply(app, token, { defaults: DEFAULTS_38 });
      expect(preview.earliestEffectiveFrom).toBe(earliestBulkEffectiveFromStr());
      expect(preview.earliestEffectiveFrom.endsWith("-01")).toBe(true);
      expect(preview.earliestEffectiveFrom).toBe(todayStr());

      const { res } = await applyBulkDefaults(app, token, {
        defaults: DEFAULTS_38,
        employeeIds: [t.noContractId],
      });
      expect(res.statusCode, res.body).toBe(200);
      const rows = await schedulesOf(t.noContractId);
      expect(rows).toHaveLength(1);
      expect(rows[0].validFrom.toISOString().slice(0, 10)).toBe(preview.earliestEffectiveFrom);
    });

    it("(i) the earliest effective date mid-month is the 1st of next month", async () => {
      const t = await scenario("i");
      const preview = await previewBulkApply(app, t.token, { defaults: DEFAULTS_38 });
      expect(preview.earliestEffectiveFrom).toBe(earliestBulkEffectiveFromStr());
      expect(preview.earliestEffectiveFrom).toBe(monthFirstAheadStr(1));
      expect(preview.latestEffectiveFrom).toBe(monthFirstAheadStr(12));
      expect(preview.allowedEffectiveFrom).toHaveLength(12);
    });

    it("(j) a PUT without the apply flag ignores the selection fields and writes no contract", async () => {
      const t = await scenario("j");
      const baselineSchedules = (await stateOf(t.data)).schedules;
      const res = await putWork(t.token, {
        ...DEFAULTS_38,
        applyEmployeeIds: [t.noContractId],
        previewFingerprint: "b".repeat(64),
        effectiveFrom: earliestBulkEffectiveFromStr(),
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.appliedCount).toBe(0);
      expect(body.skippedModelSwitch).toBe(0);
      expect((await stateOf(t.data)).schedules).toBe(baselineSchedules);
      // The defaults themselves were saved.
      const config = await app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: t.data.tenant.id },
      });
      expect(Number(config.defaultWeeklyHours)).toBe(38);
    });

    it("counts same-month model switches in the response and refuses them as selection (O3)", async () => {
      const t = await scenario("k");
      const preview0 = await previewBulkApply(app, t.token, { defaults: DEFAULTS_38 });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: t.employeeId,
          type: "MONTHLY_HOURS",
          weeklyHours: null,
          monthlyHours: 40,
          validFrom: new Date(`${preview0.effectiveFrom}T00:00:00Z`),
        },
      });
      const preview = await previewBulkApply(app, t.token, { defaults: DEFAULTS_38 });
      expect(
        preview.nonCandidates
          .find((g) => g.reason === "SAME_MONTH_MODEL_SWITCH")
          ?.employees.map((e) => e.employeeId),
      ).toEqual([t.employeeId]);
      const { res: refused } = await applyBulkDefaults(app, t.token, {
        defaults: DEFAULTS_38,
        employeeIds: [t.employeeId],
      });
      expect(refused.statusCode).toBe(409);

      const { res } = await applyBulkDefaults(app, t.token, {
        defaults: DEFAULTS_38,
        employeeIds: [t.noContractId],
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.appliedCount).toBe(1);
      expect(body.skippedModelSwitch).toBe(1);
    });

    it("works for a tenant without a TenantConfig row (stored defaults = schema defaults)", async () => {
      const t = await scenario("l");
      await app.prisma.tenantConfig.deleteMany({ where: { tenantId: t.data.tenant.id } });
      const { res, preview } = await applyBulkDefaults(app, t.token, {
        defaults: DEFAULTS_38,
        employeeIds: [t.noContractId],
      });
      expect(res.statusCode, res.body).toBe(200);
      // The seeded 40 h contracts equal the schema defaults the missing row stands for.
      expect(preview.candidates.find((c) => c.employeeId === t.employeeId)?.category).toBe(
        "MATCHES_DEFAULTS",
      );
      const config = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: t.data.tenant.id },
      });
      expect(Number(config?.defaultWeeklyHours)).toBe(38);
      expect(await schedulesOf(t.noContractId)).toHaveLength(1);
    });
  });
});
