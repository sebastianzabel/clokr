/**
 * Issue #444 — RED-then-GREEN + zero-mutation proof for audit-vacation-entitlements.ts.
 *
 * All runs use `--year 2026`. Every case gets its own employee (own User + Employee +
 * WorkSchedule), so assertions can locate a line by `employeeId=<id>` AND `year=<Y>` — never by
 * total line count (seedTestData's own employee may itself carry VACATION rows).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { main, EXIT_OK, EXIT_FINDINGS, parseCli, formatLine } from "../audit-vacation-entitlements";
import type { FastifyInstance } from "fastify";

describe("audit-vacation-entitlements (Issue #444)", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;

  const ids: Record<string, string> = {};
  let counter = 0;

  async function mkEmployee(
    data: Awaited<ReturnType<typeof seedTestData>>,
    opts: {
      classification?: "VOLLZEIT" | "AZUBI";
      birthDate?: string | null;
      hireDate?: string;
      exitDate?: string | null;
      annualVacationDays?: number | null;
      // Issue #450 (D-01/D-09): optional day pattern for the FIRST (hire-time) WorkSchedule row —
      // weekday indices, 0=So..6=Sa, same convention as the model's `workDays` column. Omitted
      // keeps the Prisma-default Mo-Fr (5-day) row every pre-#450 test already relies on.
      firstRowWorkDays?: number[];
    } = {},
  ): Promise<string> {
    counter += 1;
    const suffix = `v444-${counter}-${Date.now().toString(36)}`;
    const user = await app.prisma.user.create({
      data: { email: `${suffix}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const hireDate = opts.hireDate ?? "2020-01-01";
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: suffix,
        firstName: "Test",
        lastName: "Employee",
        classification: opts.classification ?? "VOLLZEIT",
        hireDate: new Date(`${hireDate}T00:00:00Z`),
        exitDate: opts.exitDate ? new Date(`${opts.exitDate}T00:00:00Z`) : null,
        birthDate:
          opts.birthDate === null ? null : new Date(`${opts.birthDate ?? "1990-01-01"}T00:00:00Z`),
        annualVacationDays: opts.annualVacationDays ?? null,
      },
    });
    const wd = opts.firstRowWorkDays;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        validFrom: new Date(`${hireDate}T00:00:00Z`),
        ...(wd
          ? {
              type: "FIXED_SCHEDULE" as const,
              mondayHours: wd.includes(1) ? 8 : 0,
              tuesdayHours: wd.includes(2) ? 8 : 0,
              wednesdayHours: wd.includes(3) ? 8 : 0,
              thursdayHours: wd.includes(4) ? 8 : 0,
              fridayHours: wd.includes(5) ? 8 : 0,
              saturdayHours: 0,
              sundayHours: 0,
              workDays: wd,
            }
          : {}),
      },
    });
    return employee.id;
  }

  /**
   * Issue #450 (D-04/D-11) — adds a LATER WorkSchedule row (a Vertragswechsel) to an employee
   * already created by mkEmployee. Returns the new row's id so a test can assert the D-04
   * normalization-note line names it. `validFrom` may be any calendar day (including a non-1st
   * legacy date) — this helper does not snap it; the production normalization under test does.
   */
  async function mkScheduleChange(
    employeeId: string,
    validFrom: string,
    workDays: number[],
  ): Promise<string> {
    const row = await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "FIXED_SCHEDULE",
        mondayHours: workDays.includes(1) ? 8 : 0,
        tuesdayHours: workDays.includes(2) ? 8 : 0,
        wednesdayHours: workDays.includes(3) ? 8 : 0,
        thursdayHours: workDays.includes(4) ? 8 : 0,
        fridayHours: workDays.includes(5) ? 8 : 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays,
        validFrom: new Date(`${validFrom}T00:00:00Z`),
      },
    });
    return row.id;
  }

  async function mkEntitlement(
    data: Awaited<ReturnType<typeof seedTestData>>,
    employeeId: string,
    year: number,
    opts: {
      totalDays: number;
      usedDays?: number;
      carriedOverDays?: number;
      isAutoCalculated?: boolean;
      carryOverDeadline?: string | null;
    },
  ): Promise<string> {
    const row = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year,
        totalDays: opts.totalDays,
        usedDays: opts.usedDays ?? 0,
        carriedOverDays: opts.carriedOverDays ?? 0,
        isAutoCalculated: opts.isAutoCalculated ?? true,
        carryOverDeadline: opts.carryOverDeadline
          ? new Date(`${opts.carryOverDeadline}T00:00:00Z`)
          : null,
      },
    });
    return row.id;
  }

  async function mkManualWrite(entitlementId: string, totalDays: number) {
    await app.prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entity: "LeaveEntitlement",
        entityId: entitlementId,
        newValue: { totalDays },
      },
    });
  }

  async function mkCarryoverWarned(entitlementId: string) {
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: entitlementId,
        newValue: {},
      },
    });
  }

  async function mkLeaveRequest(
    data: Awaited<ReturnType<typeof seedTestData>>,
    employeeId: string,
    opts: { start: string; end: string; days: number },
  ) {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(`${opts.start}T00:00:00Z`),
        endDate: new Date(`${opts.end}T00:00:00Z`),
        days: opts.days,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });
  }

  function lineFor(lines: string[], employeeId: string, year: number): string | undefined {
    return lines.find(
      (l) => l.includes(`employeeId=${employeeId} `) && l.includes(` year=${year} `),
    );
  }

  async function run(args: string[]): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
      lines.push(String(a[0]));
    });
    try {
      const code = await main(args, app.prisma);
      return { code, lines };
    } finally {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "audit444a");
    dataB = await seedTestData(app, "audit444b");

    // ── Kernkategorien ──────────────────────────────────────────────────────
    ids.ok = await mkEmployee(dataA);
    await mkEntitlement(dataA, ids.ok, 2026, { totalDays: 30 });
    await mkEntitlement(dataA, ids.ok, 2027, { totalDays: 30 });

    ids.underMinManual = await mkEmployee(dataA);
    const underMinManualRow = await mkEntitlement(dataA, ids.underMinManual, 2026, {
      totalDays: 15,
      isAutoCalculated: false,
    });
    await mkManualWrite(underMinManualRow, 15);

    ids.manualLegal = await mkEmployee(dataA);
    const manualLegalRow = await mkEntitlement(dataA, ids.manualLegal, 2026, {
      totalDays: 25,
      isAutoCalculated: false,
    });
    await mkManualWrite(manualLegalRow, 25);

    ids.underMinAuto = await mkEmployee(dataA);
    await mkEntitlement(dataA, ids.underMinAuto, 2026, { totalDays: 18 });

    ids.contractDeviation = await mkEmployee(dataA, { annualVacationDays: 20 });
    await mkEntitlement(dataA, ids.contractDeviation, 2026, { totalDays: 30 });

    ids.birthDateMissing = await mkEmployee(dataA, { classification: "AZUBI", birthDate: null });
    await mkEntitlement(dataA, ids.birthDateMissing, 2026, { totalDays: 30 });

    // Orchestrator correction (GH #444): AZUBI, no person value, birth date known — stored
    // deviates from the apprentice default, not from the (person-value-less) regular target.
    ids.apprenticeDeviation = await mkEmployee(dataA, { classification: "AZUBI" });
    await mkEntitlement(dataA, ids.apprenticeDeviation, 2026, { totalDays: 30 });

    // Issue #468 (D-06/D-07): a Mo-Sa (6-day) employee whose auto-calculated stored row still
    // carries the pre-#468 capped value (30) is an ABWEICHUNG_VERTRAG against the now-correct
    // target (36) — the report lists it, it never writes.
    ids.sixDayContract = await mkEmployee(dataA, { firstRowWorkDays: [1, 2, 3, 4, 5, 6] });
    ids.sixDayContractEntitlement = await mkEntitlement(dataA, ids.sixDayContract, 2026, {
      totalDays: 30,
    });

    ids.tenantBOk = await mkEmployee(dataB);
    await mkEntitlement(dataB, ids.tenantBOk, 2026, { totalDays: 30 });

    // ── Ergänzung ─────────────────────────────────────────────────────────
    ids.nullPlaceholder = await mkEmployee(dataA);
    await mkEntitlement(dataA, ids.nullPlaceholder, 2027, {
      totalDays: 0,
      isAutoCalculated: false,
    });

    ids.crossYearPresent = await mkEmployee(dataA);
    await mkEntitlement(dataA, ids.crossYearPresent, 2026, { totalDays: 30, usedDays: 4 });
    await mkEntitlement(dataA, ids.crossYearPresent, 2027, { totalDays: 30, usedDays: 0 });
    await mkLeaveRequest(dataA, ids.crossYearPresent, {
      start: "2026-12-28",
      end: "2027-01-08",
      days: 9,
    });

    ids.crossYearMissing = await mkEmployee(dataA);
    await mkEntitlement(dataA, ids.crossYearMissing, 2026, { totalDays: 30, usedDays: 4 });
    await mkLeaveRequest(dataA, ids.crossYearMissing, {
      start: "2026-12-28",
      end: "2027-01-08",
      days: 9,
    });

    ids.carryOverLapsed = await mkEmployee(dataA);
    const lapsedPrev = await mkEntitlement(dataA, ids.carryOverLapsed, 2025, {
      totalDays: 30,
      usedDays: 10,
      carriedOverDays: 5,
      carryOverDeadline: "2025-03-31",
    });
    await mkCarryoverWarned(lapsedPrev);
    await mkEntitlement(dataA, ids.carryOverLapsed, 2026, { totalDays: 30, carriedOverDays: 25 });

    ids.carryOverControl = await mkEmployee(dataA);
    const controlPrev = await mkEntitlement(dataA, ids.carryOverControl, 2025, {
      totalDays: 30,
      usedDays: 10,
      carriedOverDays: 5,
      carryOverDeadline: "2025-03-31",
    });
    await mkCarryoverWarned(controlPrev);
    await mkEntitlement(dataA, ids.carryOverControl, 2026, { totalDays: 30, carriedOverDays: 20 });

    ids.contractChange = await mkEmployee(dataA);
    await app.prisma.workSchedule.create({
      data: { employeeId: ids.contractChange, validFrom: new Date("2026-07-01T00:00:00Z") },
    });
    await mkEntitlement(dataA, ids.contractChange, 2026, { totalDays: 30 });
    await mkEntitlement(dataA, ids.contractChange, 2027, { totalDays: 30 });

    // ── Issue #450 (D-04, D-05, D-07, D-09, D-11) — the Prüfbericht as the D-11 dry-run ───────
    // E1: 3-day -> 5-day from 01.07.2026, stored stays at the pre-#450 (newest-row-only) value —
    // old vs per-segment target on the same line.
    ids.e1 = await mkEmployee(dataA, { firstRowWorkDays: [1, 2, 3] });
    await mkScheduleChange(ids.e1, "2026-07-01", [1, 2, 3, 4, 5]);
    await mkEntitlement(dataA, ids.e1, 2026, { totalDays: 18 });

    // E2: same shape as E1, but the row is human-set — never corrected, just listed (D-07).
    ids.e2 = await mkEmployee(dataA, { firstRowWorkDays: [1, 2, 3] });
    await mkScheduleChange(ids.e2, "2026-07-01", [1, 2, 3, 4, 5]);
    const e2Row = await mkEntitlement(dataA, ids.e2, 2026, {
      totalDays: 18,
      isAutoCalculated: false,
    });
    await mkManualWrite(e2Row, 18);

    // E3: 5-day -> 3-day from 01.07.2026, usedDays already exceeds the new (correct) target — the
    // negative remainder must stay visible (D-05), never hidden/clamped.
    ids.e3 = await mkEmployee(dataA, { firstRowWorkDays: [1, 2, 3, 4, 5] });
    await mkScheduleChange(ids.e3, "2026-07-01", [1, 2, 3]);
    await mkEntitlement(dataA, ids.e3, 2026, { totalDays: 24, usedDays: 28 });

    // E4: person base 20, 3-day -> 5-day from 01.07.2026 — the statutory minimum and the
    // apprentice comparison target must follow the segment list too (D-09), never the
    // newest-row-only floor (which would wrongly answer minimum=20 and flag UNTER_MINIMUM).
    ids.e4 = await mkEmployee(dataA, { firstRowWorkDays: [1, 2, 3], annualVacationDays: 20 });
    await mkScheduleChange(ids.e4, "2026-07-01", [1, 2, 3, 4, 5]);
    await mkEntitlement(dataA, ids.e4, 2026, { totalDays: 16 });

    // E5: a legacy non-1st contract change (18.05.2026, pre-Phase-60 shape) — D-04: effective from
    // the 1st of the FOLLOWING month (01.06.2026), logged as an informational normalization note,
    // never as a finding. The entitlement is already set to its correctly-computed target.
    ids.e5 = await mkEmployee(dataA, { firstRowWorkDays: [1, 2, 3, 4, 5] });
    ids.e5ScheduleId = await mkScheduleChange(ids.e5, "2026-05-18", [1, 2, 3]);
    await mkEntitlement(dataA, ids.e5, 2026, { totalDays: 23 });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, dataA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Kernkategorien ────────────────────────────────────────────────────────
  describe("Kernkategorien", () => {
    it("OK: both years, auto, matching target/minimum", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const l2026 = lineFor(lines, ids.ok, 2026)!;
      const l2027 = lineFor(lines, ids.ok, 2027)!;
      expect(l2026).toContain("categories=OK");
      expect(l2026).toContain("manual=no");
      expect(l2026).toContain("target=30.00");
      expect(l2026).toContain("minimum=20.00");
      expect(l2027).toContain("categories=OK");
    });

    it("UNTER_MINIMUM (manual): below minimum even though human-set", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.underMinManual, 2026)!;
      expect(line).toContain("manual=yes");
      expect(line).toContain("categories=UNTER_MINIMUM");
    });

    it("manual-but-legal: marked manual, not an error", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.manualLegal, 2026)!;
      expect(line).toContain("manual=yes");
      expect(line).toContain("categories=OK");
    });

    it("UNTER_MINIMUM (auto): never also ABWEICHUNG_VERTRAG", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.underMinAuto, 2026)!;
      expect(line).toContain("categories=UNTER_MINIMUM");
      expect(line).not.toContain("ABWEICHUNG_VERTRAG");
    });

    it("ABWEICHUNG_VERTRAG: stored deviates from the person-value target", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.contractDeviation, 2026)!;
      expect(line).toContain("target=20.00");
      expect(line).toContain("deviation=10.00");
      expect(line).toContain("categories=ABWEICHUNG_VERTRAG");
    });

    it("GEBURTSDATUM_FEHLT: AZUBI without birth date, nothing else", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.birthDateMissing, 2026)!;
      expect(line).toContain("target=30.00");
      expect(line).toContain("deviation=0.00");
      expect(line).toContain("manual=no");
      expect(line).toContain("categories=GEBURTSDATUM_FEHLT");
      expect(line).not.toContain("UNTER_MINIMUM");
      expect(line).not.toContain("ABWEICHUNG_VERTRAG");
      expect(line).not.toContain("NULL_PLATZHALTER");
    });

    it("Orchestrator correction (#444): AZUBI, no person value, deviates from apprentice default", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.apprenticeDeviation, 2026)!;
      expect(line).toContain("categories=ABWEICHUNG_VERTRAG");
      expect(line).not.toContain("GEBURTSDATUM_FEHLT");
    });

    it("Issue #468 (D-07): a Mo-Sa (6-day) employee's stored-30 auto row shows target=36.00, manual=no, ABWEICHUNG_VERTRAG — and is NOT written", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.sixDayContract, 2026)!;
      expect(line).toContain("target=36.00");
      expect(line).toContain("manual=no");
      expect(line).toContain("categories=ABWEICHUNG_VERTRAG");

      const row = await app.prisma.leaveEntitlement.findUniqueOrThrow({
        where: { id: ids.sixDayContractEntitlement },
      });
      expect(Number(row.totalDays)).toBe(30);
    });

    it("tenant isolation: B has no findings, A does, --all-tenants sees both", async () => {
      const resB = await run(["--tenant-id", dataB.tenant.id, "--year", "2026"]);
      expect(resB.code).toBe(EXIT_OK);
      expect(lineFor(resB.lines, ids.tenantBOk, 2026)).toContain("categories=OK");

      const resA = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      expect(resA.code).toBe(EXIT_FINDINGS);

      const resAll = await run(["--all-tenants", "--year", "2026"]);
      expect(lineFor(resAll.lines, ids.tenantBOk, 2026)).toBeDefined();
      expect(lineFor(resAll.lines, ids.ok, 2026)).toBeDefined();
    });
  });

  // ── Ergänzung ─────────────────────────────────────────────────────────────
  describe("Ergänzung", () => {
    it("NULL_PLATZHALTER only (never also UNTER_MINIMUM/ABWEICHUNG_VERTRAG)", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.nullPlaceholder, 2027)!;
      expect(line).toContain("categories=NULL_PLATZHALTER");
      expect(line).not.toContain("UNTER_MINIMUM");
      expect(line).not.toContain("ABWEICHUNG_VERTRAG");
    });

    it("JAHRESUEBERGREIFEND_FEHLT: row present — only the year with the gap is flagged", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const l2026 = lineFor(lines, ids.crossYearPresent, 2026)!;
      const l2027 = lineFor(lines, ids.crossYearPresent, 2027)!;
      expect(l2026).not.toContain("JAHRESUEBERGREIFEND_FEHLT");
      expect(l2027).toContain("JAHRESUEBERGREIFEND_FEHLT");
    });

    it("JAHRESUEBERGREIFEND_FEHLT: row missing — synthetic line", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lines.find(
        (l) =>
          l.includes(`employeeId=${ids.crossYearMissing} `) &&
          l.includes(" year=2027 ") &&
          l.includes("entitlementId=missing"),
      );
      expect(line).toBeDefined();
      expect(line).toContain("stored=none");
      expect(line).toContain("categories=JAHRESUEBERGREIFEND_FEHLT");
    });

    it("UEBERTRAG_VERFALLEN_WIEDER: lapsed carry still shown the next year", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.carryOverLapsed, 2026)!;
      expect(line).toContain("categories=UEBERTRAG_VERFALLEN_WIEDER");
    });

    it("UEBERTRAG_VERFALLEN_WIEDER control: matches the effective remainder — OK", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.carryOverControl, 2026)!;
      expect(line).not.toContain("UEBERTRAG_VERFALLEN_WIEDER");
    });

    it("VERTRAGSWECHSEL_PRUEFEN: mid-year schedule change flags that year only", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const l2026 = lineFor(lines, ids.contractChange, 2026)!;
      const l2027 = lineFor(lines, ids.contractChange, 2027)!;
      expect(l2026).toContain("VERTRAGSWECHSEL_PRUEFEN");
      expect(l2027).not.toContain("VERTRAGSWECHSEL_PRUEFEN");
    });

    it("VERTRAGSWECHSEL_PRUEFEN control: a single (initial) schedule is never flagged", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.ok, 2026)!;
      expect(line).not.toContain("VERTRAGSWECHSEL_PRUEFEN");
    });
  });

  // ── Issue #450 (D-04, D-05, D-07, D-09, D-11) — Prüfbericht as the D-11 dry-run ────────────
  describe("Issue #450 — Vertragswechsel dry-run (old vs per-segment target)", () => {
    it("E1: 3-day -> 5-day from 01.07.2026 — stored (pre-#450) vs the per-segment target on the same line", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.e1, 2026)!;
      expect(line).toContain("stored=18.00");
      expect(line).toContain("target=24.00");
      expect(line).toContain("deviation=-6.00");
      expect(line).toContain("manual=no");
      expect(line).toContain("categories=ABWEICHUNG_VERTRAG,VERTRAGSWECHSEL_PRUEFEN");
    });

    it("E2: a human-set row is listed with the new per-segment target, never corrected (D-07)", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.e2, 2026)!;
      expect(line).toContain("manual=yes");
      expect(line).toContain("target=24.00");
      expect(line).toContain("categories=VERTRAGSWECHSEL_PRUEFEN");
    });

    it("E3: 5-day -> 3-day from 01.07.2026 — a negative remainder stays visible, never clamped (D-05)", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.e3, 2026)!;
      expect(line).toContain("stored=24.00");
      expect(line).toContain("used=28.00");
      expect(line).toContain("target=24.00");
      expect(line).toContain("categories=VERTRAGSWECHSEL_PRUEFEN");
    });

    it("E4: the minimum and the apprentice comparison target follow the segment list (D-09) — no false UNTER_MINIMUM", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const line = lineFor(lines, ids.e4, 2026)!;
      expect(line).toContain("minimum=16.00");
      expect(line).toContain("target=16.00");
      expect(line).not.toContain("UNTER_MINIMUM");
    });

    it("E5: a legacy non-1st contract start is logged once as a normalization note (D-04), never for the hire row", async () => {
      const { lines } = await run(["--tenant-id", dataA.tenant.id, "--year", "2026"]);
      const notesForEmployee = lines.filter(
        (l) =>
          l.includes(`employeeId=${ids.e5} `) && l.includes("note=VERTRAGSBEGINN_NORMALISIERT"),
      );
      expect(notesForEmployee).toHaveLength(1);
      const note = notesForEmployee[0]!;
      expect(note).toContain(`workScheduleId=${ids.e5ScheduleId}`);
      expect(note).toContain("validFrom=2026-05-18");
      expect(note).toContain("effectiveFrom=2026-06-01");

      const hireRowNote = lines.find(
        (l) =>
          l.includes(`employeeId=${ids.e5} `) &&
          l.includes("validFrom=2020-01-01") &&
          l.includes("note=VERTRAGSBEGINN_NORMALISIERT"),
      );
      expect(hireRowNote).toBeUndefined();
    });
  });

  // ── CLI ───────────────────────────────────────────────────────────────────
  describe("CLI", () => {
    it("main([]) rejects without a tenant selection", async () => {
      await expect(main([], app.prisma)).rejects.toThrow(/Tenant-Auswahl erforderlich/);
    });

    it("parseCli rejects write flags", () => {
      expect(() => parseCli(["--apply"])).toThrow();
      expect(() => parseCli(["--confirm"])).toThrow();
    });

    it("parseCli rejects a non-numeric --year", () => {
      expect(() => parseCli(["--year", "abc"])).toThrow();
    });
  });

  // ── Datenschutz ───────────────────────────────────────────────────────────
  describe("Datenschutz", () => {
    it("no printed line contains seeded PII", async () => {
      const { lines } = await run(["--all-tenants", "--year", "2026"]);
      const blob = lines.join("\n");
      expect(blob).not.toMatch(/Test\s+Employee/);
      expect(blob).not.toContain("1990-01-01");
      expect(blob).not.toMatch(/v444-\d/); // employeeNumber fragment
    });

    it("formatLine contains no PII for a synthetic line", () => {
      const line = formatLine({
        tenantId: "11111111-1111-1111-1111-111111111111",
        employeeId: "22222222-2222-2222-2222-222222222222",
        entitlementId: "missing",
        year: 2027,
        stored: null,
        used: null,
        carriedOver: null,
        target: 30,
        minimum: 20,
        deviation: null,
        manual: false,
        categories: ["JAHRESUEBERGREIFEND_FEHLT"],
      });
      expect(line).toContain("entitlementId=missing");
      expect(line).toContain("stored=none");
      expect(line).toContain("deviation=n/a");
      expect(line).not.toMatch(/firstName|lastName|employeeNumber/);
    });
  });

  // ── Nullmutation ──────────────────────────────────────────────────────────
  describe("Nullmutation", () => {
    it("zero writes: tenant-A LeaveEntitlement snapshot + AuditLog count unchanged", async () => {
      const snapshotBefore = await app.prisma.leaveEntitlement.findMany({
        where: { employee: { tenantId: dataA.tenant.id } },
        select: {
          id: true,
          updatedAt: true,
          totalDays: true,
          usedDays: true,
          carriedOverDays: true,
          isAutoCalculated: true,
        },
        orderBy: { id: "asc" },
      });
      const auditCountBefore = await app.prisma.auditLog.count();

      await main(["--tenant-id", dataA.tenant.id, "--year", "2026"], app.prisma);
      await main(["--all-tenants", "--year", "2026"], app.prisma);

      const snapshotAfter = await app.prisma.leaveEntitlement.findMany({
        where: { employee: { tenantId: dataA.tenant.id } },
        select: {
          id: true,
          updatedAt: true,
          totalDays: true,
          usedDays: true,
          carriedOverDays: true,
          isAutoCalculated: true,
        },
        orderBy: { id: "asc" },
      });
      const auditCountAfter = await app.prisma.auditLog.count();

      expect(snapshotAfter).toEqual(snapshotBefore);
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it("the script source calls no Prisma write method or writing helper", async () => {
      const fs = await import("node:fs");
      const src = fs.readFileSync(
        new URL("../audit-vacation-entitlements.ts", import.meta.url),
        "utf8",
      );
      expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
      expect(src).not.toMatch(/\$execute/);
      for (const helper of [
        "healEntitlementUsedDays",
        "ensureRegularVacationEntitlement",
        "recalculateCarryOver",
        "syncExitYearVacationEntitlement",
        "selfHealUsedDays",
        "upsertVacationEntitlement",
        "ensureVacationEntitlementForYear",
        "deductVacationDays",
        "reverseVacationDays",
        "recalcVacationEntitlementsForContractChange",
      ]) {
        expect(src).not.toContain(helper);
      }
    });
  });
});
