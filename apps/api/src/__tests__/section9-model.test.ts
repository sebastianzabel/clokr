/**
 * Phase 104 Plan 01 — model-level pin for the Section9Credit persistence foundation
 * (§ 9 BUrlG "Krank im Urlaub"). Verifies:
 *
 *   1. A Section9Credit round-trips with the correct AU_PENDING/no-credit defaults.
 *   2. The Restrict FKs actually hold at the database level — a LeaveRequest that a
 *      Section9Credit points at cannot be deleted, so the coupling can never be
 *      silently orphaned (CLAUDE.md: "CASCADE = Restrict").
 *   3. R8 / D-03's dead-code claim ("Absence.SICK is never created, Absence.documentPath
 *      is never written with a value") is still true in the source tree.
 *   4. Section9Credit has no deletedAt column — D-11 makes rejection a re-openable
 *      status transition, not a soft delete.
 *
 * No PII — fixtures use only generated tenant/employee rows (memory
 * feedback_no_pii_in_github).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

// Recursively collects every file path under `dir`. Small, local helper — this repo has
// no existing shared "walk a directory" utility to reuse (checked before adding this).
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (statSync(full).isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe("Section9Credit — model shape (Phase 104 Plan 01)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sickTypeId: string;
  let sickRequestId: string;
  let vacationRequestId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9-model");

    const sickType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        name: "Krankmeldung",
        isPaid: true,
        requiresApproval: false,
      },
    });
    sickTypeId = sickType.id;

    const vacationRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-08-10"),
        endDate: new Date("2026-08-14"),
        days: 5,
        status: "APPROVED",
      },
    });
    vacationRequestId = vacationRequest.id;

    const sickRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: sickTypeId,
        startDate: new Date("2026-08-12"),
        endDate: new Date("2026-08-13"),
        days: 2,
        status: "APPROVED",
      },
    });
    sickRequestId = sickRequest.id;
  });

  afterAll(async () => {
    try {
      // Must run BEFORE cleanupTestData: the Restrict FKs (Test 2) mean a leftover
      // Section9Credit row would make cleanupTestData's leaveRequest.deleteMany throw.
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("section9-model test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("Test 1: round-trips with AU_PENDING default and no credit yet", async () => {
    const credit = await app.prisma.section9Credit.create({
      data: {
        employeeId: data.employee.id,
        sickRequestId,
        vacationRequestId,
        overlapStart: new Date("2026-08-12"),
        overlapEnd: new Date("2026-08-13"),
      },
    });

    expect(credit.status).toBe("AU_PENDING");
    expect(credit.creditedDays).toBeNull();
    expect(credit.creditedStart).toBeNull();
    expect(credit.creditedEnd).toBeNull();
    expect(credit.documentPath).toBeNull();
    expect(credit.sickRequestId).toBe(sickRequestId);
    expect(credit.vacationRequestId).toBe(vacationRequestId);
  });

  it("Test 2: deleting a linked LeaveRequest is rejected by the database (Restrict FK)", async () => {
    // The Test 1 row still exists and points at sickRequestId — proves the audit chain
    // (which LeaveRequest a credit references) cannot be broken by a delete.
    await expect(
      app.prisma.leaveRequest.delete({ where: { id: sickRequestId } }),
    ).rejects.toThrow();
  });

  // R8 / D-03: sickness lives in LeaveRequest only. Absence.SICK has no writer, and
  // Absence.documentPath is only ever nulled (DSGVO), never written with a value.
  // If this test ever fails, R8's premise changed — a second sickness write path
  // appeared and § 9's LeaveRequest-only assumption must be revisited before the test
  // is relaxed.
  it("Test 3: no source file creates an Absence.SICK row or writes a non-null documentPath", () => {
    const srcRoot = resolve(__dirname, "..");
    const files = walk(srcRoot).filter((f) => f.endsWith(".ts") && !f.includes("__tests__"));
    expect(files.length).toBeGreaterThan(0);
    const src = files.map((f) => readFileSync(f, "utf8")).join("\n");

    // Every absence.create(Many) call site in the tree must be a VOCATIONAL_SCHOOL write,
    // never a SICK/SICK_CHILD one.
    const createBlocks = src.match(/absence\.create(Many)?\(\{[\s\S]{0,600}?\}\)/g) ?? [];
    expect(createBlocks.length).toBeGreaterThan(0);
    for (const b of createBlocks) {
      expect(b).toMatch(/VOCATIONAL_SCHOOL/);
      expect(b).not.toMatch(/type:\s*"SICK/);
    }

    // documentPath is only ever nulled in a Prisma `data:` write payload. Scoped to
    // `data: { ... }` blocks specifically (not `[^}]*` across the whole file) so
    // legitimate reads like `select: { documentPath: true }` or
    // `where: { documentPath: { not: null } }` — both present in employees.ts's DSGVO
    // deletion flow — do not trip this check; only an actual write payload counts.
    const dataWriteBlocks = src.match(/data:\s*\{[^}]*documentPath:[^}]*\}/g) ?? [];
    expect(dataWriteBlocks.length).toBeGreaterThan(0);
    for (const b of dataWriteBlocks) {
      expect(b).toMatch(/documentPath:\s*null\b/);
    }
  });

  it("Test 4: Section9Credit has no deletedAt column (D-11 is a status transition, not a soft delete)", async () => {
    const cols = await app.prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Section9Credit'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("deletedAt");
    // Sanity check that we queried the right table at all (catches a silent 0-row typo).
    expect(names).toContain("status");
  });
});
