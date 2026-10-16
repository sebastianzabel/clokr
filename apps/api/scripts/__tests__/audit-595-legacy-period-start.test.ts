/**
 * Issue #595 (P-08) - audit-595-legacy-period-start.ts is a read-only listing.
 *
 * Pure cases pin `classifySnapshotRows` (the storage convention of each row, the duplicate months
 * with the row the account reads, which months turn from Prognose to Bestaetigt, which converted
 * rows had a month label one month early); one integration case runs `main` against a seeded
 * tenant and proves no snapshot row changes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  saldoSnapshotPeriodBounds,
  legacySaldoSnapshotPeriodBounds,
} from "../../src/__tests__/test-dates";
import { classifySnapshotRows, main, type SnapshotRow } from "../audit-595-legacy-period-start";

const BERLIN = "Europe/Berlin";
const CLOSED = new Date("2026-10-01T05:00:00Z");

function row(id: string, periodStart: string, employeeId = "e1", closedAt = CLOSED): SnapshotRow {
  return { id, employeeId, periodStart: new Date(`${periodStart}T00:00:00Z`), closedAt };
}

describe("classifySnapshotRows (Europe/Berlin)", () => {
  it("a row stored on the 1st is LEGACY, the converted start date is TZ, a 15th is UNNAMED", () => {
    // September 2026 converted = 2026-08-31 (local midnight 22:00Z of the day before).
    const result = classifySnapshotRows(
      [row("legacy", "2026-09-01"), row("tz", "2026-08-31", "e2"), row("odd", "2026-09-15", "e3")],
      BERLIN,
    );
    const kindOf = (id: string) => result.rows.find((r) => r.id === id)!;
    expect(kindOf("legacy")).toMatchObject({ kind: "LEGACY", month: "2026-09" });
    expect(kindOf("tz")).toMatchObject({ kind: "TZ", month: "2026-09" });
    expect(kindOf("odd")).toMatchObject({ kind: "UNNAMED", month: null });
    expect(result.legacy.map((r) => r.id)).toEqual(["legacy"]);
    expect(result.tz.map((r) => r.id)).toEqual(["tz"]);
    expect(result.unnamed.map((r) => r.id)).toEqual(["odd"]);
    expect(result.total).toBe(3);
  });

  it("a legacy and a converted row of one month form one duplicate group naming the row the account reads", () => {
    const result = classifySnapshotRows(
      [
        row("legacy", "2026-10-01"),
        row("tz", "2026-09-30", "e1", new Date("2026-10-02T05:00:00Z")),
      ],
      BERLIN,
    );
    expect(result.duplicates).toEqual([
      { employeeId: "e1", month: "2026-10", selectedId: "tz", otherIds: ["legacy"] },
    ]);
    // The converted sibling is the record: the month was already closed before #595.
    expect(result.statusBecomesConfirmed).toEqual([]);
  });

  it("a legacy row without a converted sibling is a month whose status turns from Prognose to Bestaetigt", () => {
    const result = classifySnapshotRows(
      [row("only-legacy", "2026-11-01"), row("tz", "2026-09-30")],
      BERLIN,
    );
    expect(result.statusBecomesConfirmed.map((r) => r.id)).toEqual(["only-legacy"]);
    expect(result.duplicates).toEqual([]);
  });

  it("converted rows whose stored UTC month differs from the named month are the corrected labels", () => {
    const result = classifySnapshotRows(
      [row("tz", "2026-09-30"), row("legacy", "2026-11-01", "e2")],
      BERLIN,
    );
    expect(result.monthNameCorrected.map((r) => r.id)).toEqual(["tz"]);
    expect(result.monthNameCorrected[0].month).toBe("2026-10");
  });

  it("in a zone where both conventions store the 1st nothing is legacy and no label changes", () => {
    const result = classifySnapshotRows([row("a", "2026-09-01")], "UTC");
    expect(result.rows[0]).toMatchObject({ kind: "TZ", month: "2026-09" });
    expect(result.legacy).toEqual([]);
    expect(result.statusBecomesConfirmed).toEqual([]);
    expect(result.monthNameCorrected).toEqual([]);
  });

  it("duplicates are grouped per employee, never across employees", () => {
    const result = classifySnapshotRows(
      [row("a", "2026-10-01", "e1"), row("b", "2026-09-30", "e2")],
      BERLIN,
    );
    expect(result.duplicates).toEqual([]);
    expect(result.statusBecomesConfirmed.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("main (read-only)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "a595");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } finally {
      await closeTestApp();
    }
  });

  async function create(employeeId: string, bounds: { start: Date; end: Date }) {
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });
  }

  it("lists the fixture and changes no SaldoSnapshot row", async () => {
    const e = data.employee.id;
    await create(e, legacySaldoSnapshotPeriodBounds(2026, 3));
    await create(e, saldoSnapshotPeriodBounds(new Date("2026-04-01T00:00:00Z")));
    await create(e, legacySaldoSnapshotPeriodBounds(2026, 5));
    await create(e, saldoSnapshotPeriodBounds(new Date("2026-05-01T00:00:00Z")));
    await create(e, {
      start: new Date("2026-06-15T00:00:00Z"),
      end: new Date("2026-06-30T00:00:00Z"),
    });

    const fullRows = () =>
      app.prisma.saldoSnapshot.findMany({
        where: { employee: { tenantId: data.tenant.id } },
        orderBy: { id: "asc" },
      });
    const before = await fullRows();
    expect(before).toHaveLength(5);

    const lines: string[] = [];
    const reports = await main(app.prisma, {
      tenantId: data.tenant.id,
      out: (line) => lines.push(line),
    });

    const after = await fullRows();
    expect(after).toEqual(before);

    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.timeZone).toBe(BERLIN);
    expect(r.result.total).toBe(5);
    expect(r.result.legacy).toHaveLength(2);
    expect(r.result.tz).toHaveLength(2);
    expect(r.result.unnamed).toHaveLength(1);
    expect(r.result.duplicates).toHaveLength(1);
    expect(r.result.statusBecomesConfirmed).toHaveLength(1);
    expect(r.result.monthNameCorrected).toHaveLength(2);

    const text = lines.join("\n");
    expect(text).toContain(`tenant ${data.tenant.id}`);
    expect(text).toContain("Status wechselt zu Bestaetigt: 1");
    expect(text).toContain("Monatsname korrigiert: 2");
    expect(text).toContain("Duplicate months: 1");
    // Ids only: the fixture person's name never appears.
    expect(text).not.toContain(data.employee.firstName);
  });
});
