/**
 * Phase 97 (T2) Plan 04 — Ops script tests for backfill-leave-type-code.
 *
 * This suite is the AC-4 proof: it plants pre-Phase-97 style rows DIRECTLY via
 * `prisma.leaveType.create({ data: { tenantId, name } })` — bypassing `leaveTypeFields()` on
 * purpose, so the row starts out exactly the way a real legacy row would: `code = null`. A
 * migration-level test cannot show this, because `test:setup` applies the migration against an
 * empty `LeaveType` table (see the script's own docblock). This test can, and does.
 *
 * Covers, one `it` per <behavior> point in 97-04-PLAN.md:
 *   1. Dry-run: canonical name ("Urlaub") is planned, reason "canonical", DB untouched
 *   2. Dry-run: legacy alias ("Jahresurlaub") is planned, reason "legacy-alias"
 *   3. Dry-run: unmapped name ("Erholungsurlaub") is reported, NOT planned, gets no code
 *   4. Apply: canonical + legacy rows get their code (and the legacy row its canonical name);
 *      the unmapped row keeps code = null
 *   5. Apply: an already-coded row (SICK) is left alone — not in `planned`, fields unchanged
 *   6. Idempotency: a second --apply run writes nothing (`applied === 0`)
 *   7. Conflict: a tenant with an existing VACATION-coded row plus a codeless "Jahresurlaub" row
 *      reports the codeless row under `conflicts` and does not write it — no unique violation
 *   8. Tenant selection is mandatory: `main([])` throws a German error
 *   9. AC-5: after --apply, `LeaveEntitlement.usedDays`/`totalDays` are unchanged — the script
 *      touches only `LeaveType`
 *  10. (bonus) exactly one AuditLog row per applied change, action LEAVE_TYPE_CODE_BACKFILL
 *
 * Uses initials-only / synthetic names for tenants (no PII per memory
 * feedback_no_pii_in_github).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp } from "../../src/__tests__/setup";
import { main, type BackfillSummary } from "../backfill-leave-type-code";
import type { FastifyInstance } from "fastify";
import type { LeaveTypeCode } from "@clokr/db";

const BACKFILL_ACTION = "LEAVE_TYPE_CODE_BACKFILL";

describe("backfill-leave-type-code (Phase 97 T2 Plan 04)", () => {
  let app: FastifyInstance;

  // ── Tenant A: canonical + legacy-alias + unmapped + already-coded fixtures ──
  let tenantAId: string;
  let vacationRowId: string; // "Urlaub" — codeless, canonical name
  let legacyRowId: string; // "Jahresurlaub" — codeless, legacy alias of VACATION
  let unmappedRowId: string; // "Erholungsurlaub" — codeless, unknown name
  let sickRowId: string; // "Krankmeldung" — already coded SICK via leaveTypeFields

  // ── Tenant B: conflict fixture ───────────────────────────────────────────
  let tenantBId: string;
  let existingVacationRowId: string; // already coded VACATION
  let conflictingLegacyRowId: string; // codeless "Jahresurlaub" — would collide on VACATION

  // ── AC-5 fixture (tenant A) ──────────────────────────────────────────────
  let entitlementId: string;
  const ENTITLEMENT_USED_DAYS = "3.50";
  const ENTITLEMENT_TOTAL_DAYS = "30.00";

  async function createTenant(prisma: FastifyInstance["prisma"], slugPrefix: string) {
    const slug = `${slugPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const tenant = await prisma.tenant.create({
      data: { name: `P97-04 ${slug}`, slug, federalState: "NIEDERSACHSEN" },
    });
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenant.id,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        defaultBreakOver6h: 30,
        defaultBreakOver9h: 45,
      },
    });
    return tenant.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;

    // ── Tenant A ───────────────────────────────────────────────────────────
    tenantAId = await createTenant(prisma, "p9704a");

    const vacationRow = await prisma.leaveType.create({
      data: { tenantId: tenantAId, name: "Urlaub" }, // codeless on purpose — bypasses leaveTypeFields()
    });
    vacationRowId = vacationRow.id;

    const legacyRow = await prisma.leaveType.create({
      data: { tenantId: tenantAId, name: "Jahresurlaub" }, // codeless, legacy alias of VACATION
    });
    legacyRowId = legacyRow.id;

    const unmappedRow = await prisma.leaveType.create({
      data: { tenantId: tenantAId, name: "Erholungsurlaub" }, // codeless, not in the closed vocabulary
    });
    unmappedRowId = unmappedRow.id;

    const sickRow = await prisma.leaveType.create({
      data: {
        tenantId: tenantAId,
        code: "SICK" as LeaveTypeCode,
        name: "Krankmeldung",
        isPaid: true,
        requiresApproval: false,
      },
    });
    sickRowId = sickRow.id;

    // ── AC-5 fixture: a LeaveEntitlement on the (still codeless) vacation row ──
    const empUser = await prisma.user.create({
      data: {
        email: `emp-p9704a-${Date.now().toString(36)}@test.de`,
        passwordHash: "unused-in-this-test",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        userId: empUser.id,
        employeeNumber: `EMP-P9704A-${Date.now().toString(36)}`,
        firstName: "E.",
        lastName: "M.",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    const entitlement = await prisma.leaveEntitlement.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: vacationRowId,
        year: 2026,
        totalDays: ENTITLEMENT_TOTAL_DAYS,
        usedDays: ENTITLEMENT_USED_DAYS,
      },
    });
    entitlementId = entitlement.id;

    // ── Tenant B: conflict fixture ───────────────────────────────────────────
    tenantBId = await createTenant(prisma, "p9704b");

    const existingVacationRow = await prisma.leaveType.create({
      data: {
        tenantId: tenantBId,
        code: "VACATION" as LeaveTypeCode,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
      },
    });
    existingVacationRowId = existingVacationRow.id;

    const conflictingLegacyRow = await prisma.leaveType.create({
      data: { tenantId: tenantBId, name: "Jahresurlaub" }, // codeless — collides with existingVacationRow's code
    });
    conflictingLegacyRowId = conflictingLegacyRow.id;
  }, 60_000);

  afterAll(async () => {
    try {
      const prisma = app.prisma;
      await prisma.auditLog.deleteMany({ where: { action: BACKFILL_ACTION } });
    } catch (err) {
      console.error("97-04 script test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Test 8: tenant selection is mandatory ───────────────────────────────
  it("throws a German error when neither --tenant-id nor --all-tenants is provided", async () => {
    await expect(main([], app.prisma)).rejects.toThrow(/Mandantenauswahl erforderlich/);
  });

  // ── Tests 1-3: dry-run classifies without writing ───────────────────────
  it("dry-run: plans a canonical-name row, writes nothing", async () => {
    const summary: BackfillSummary = await main(["--tenant-id", tenantAId], app.prisma);

    expect(summary.dryRun).toBe(true);

    const planned = summary.planned.find((p) => p.leaveTypeId === vacationRowId);
    expect(planned).toBeDefined();
    expect(planned!.to).toBe("VACATION");
    expect(planned!.reason).toBe("canonical");
    expect(planned!.renameTo).toBeUndefined();

    const row = await app.prisma.leaveType.findUniqueOrThrow({ where: { id: vacationRowId } });
    expect(row.code).toBeNull();
    expect(row.name).toBe("Urlaub");
  });

  it("dry-run: plans a legacy-alias row with reason legacy-alias, writes nothing", async () => {
    const summary: BackfillSummary = await main(["--tenant-id", tenantAId], app.prisma);

    const planned = summary.planned.find((p) => p.leaveTypeId === legacyRowId);
    expect(planned).toBeDefined();
    expect(planned!.to).toBe("VACATION");
    expect(planned!.reason).toBe("legacy-alias");
    expect(planned!.renameTo).toBe("Urlaub");

    const row = await app.prisma.leaveType.findUniqueOrThrow({ where: { id: legacyRowId } });
    expect(row.code).toBeNull();
    expect(row.name).toBe("Jahresurlaub");
  });

  it("dry-run: reports an unmapped name, does not plan it, assigns no replacement code", async () => {
    const summary: BackfillSummary = await main(["--tenant-id", tenantAId], app.prisma);

    expect(summary.planned.some((p) => p.leaveTypeId === unmappedRowId)).toBe(false);
    const unmapped = summary.unmapped.find((u) => u.leaveTypeId === unmappedRowId);
    expect(unmapped).toBeDefined();
    expect(unmapped!.name).toBe("Erholungsurlaub");

    const row = await app.prisma.leaveType.findUniqueOrThrow({ where: { id: unmappedRowId } });
    expect(row.code).toBeNull();
  });

  // ── Test 5: an already-coded row is left alone ──────────────────────────
  it("dry-run: does not plan an already-coded row", async () => {
    const summary: BackfillSummary = await main(["--tenant-id", tenantAId], app.prisma);
    expect(summary.planned.some((p) => p.leaveTypeId === sickRowId)).toBe(false);
  });

  // ── Test 4 + 5 (apply half): --apply writes the planned changes ────────
  it("--apply: writes code (+ rename for legacy) to planned rows, leaves unmapped and already-coded rows untouched", async () => {
    const before = await app.prisma.leaveType.findUniqueOrThrow({ where: { id: sickRowId } });

    const summary: BackfillSummary = await main(["--tenant-id", tenantAId, "--apply"], app.prisma);

    expect(summary.dryRun).toBe(false);
    expect(summary.applied).toBe(2); // vacationRow + legacyRow

    const vacationRow = await app.prisma.leaveType.findUniqueOrThrow({
      where: { id: vacationRowId },
    });
    expect(vacationRow.code).toBe("VACATION");
    expect(vacationRow.name).toBe("Urlaub");

    const legacyRow = await app.prisma.leaveType.findUniqueOrThrow({ where: { id: legacyRowId } });
    expect(legacyRow.code).toBe("VACATION");
    expect(legacyRow.name).toBe("Urlaub"); // renamed to the canonical display name

    const unmappedRow = await app.prisma.leaveType.findUniqueOrThrow({
      where: { id: unmappedRowId },
    });
    expect(unmappedRow.code).toBeNull(); // still no replacement code

    const sickRow = await app.prisma.leaveType.findUniqueOrThrow({ where: { id: sickRowId } });
    expect(sickRow.code).toBe(before.code);
    expect(sickRow.name).toBe(before.name);
  });

  // ── Test 10: exactly one AuditLog row per applied change ────────────────
  it("writes exactly one AuditLog row per applied change, with old/new values", async () => {
    const vacationAudit = await app.prisma.auditLog.findFirst({
      where: { action: BACKFILL_ACTION, entity: "LeaveType", entityId: vacationRowId },
    });
    expect(vacationAudit).toBeDefined();
    expect(vacationAudit!.oldValue).toEqual({ code: null, name: "Urlaub" });
    expect(vacationAudit!.newValue).toEqual({ code: "VACATION", name: "Urlaub" });
    expect(vacationAudit!.userId).toBeNull();

    const legacyAudit = await app.prisma.auditLog.findFirst({
      where: { action: BACKFILL_ACTION, entity: "LeaveType", entityId: legacyRowId },
    });
    expect(legacyAudit).toBeDefined();
    expect(legacyAudit!.oldValue).toEqual({ code: null, name: "Jahresurlaub" });
    expect(legacyAudit!.newValue).toEqual({ code: "VACATION", name: "Urlaub" });

    const auditCount = await app.prisma.auditLog.count({
      where: { action: BACKFILL_ACTION, entity: "LeaveType", entityId: vacationRowId },
    });
    expect(auditCount).toBe(1);
  });

  // ── Test 6: idempotency ──────────────────────────────────────────────────
  it("--apply a second time is a no-op: applied === 0, no new writes", async () => {
    const auditCountBefore = await app.prisma.auditLog.count({
      where: { action: BACKFILL_ACTION },
    });

    const summary: BackfillSummary = await main(["--tenant-id", tenantAId, "--apply"], app.prisma);

    expect(summary.applied).toBe(0);
    expect(summary.planned).toEqual([]);

    const auditCountAfter = await app.prisma.auditLog.count({ where: { action: BACKFILL_ACTION } });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  // ── Test 9: AC-5 — the script never touches LeaveEntitlement ────────────
  it("AC-5: LeaveEntitlement.usedDays/totalDays are unchanged after --apply", async () => {
    const entitlement = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.usedDays.toString()).toBe(ENTITLEMENT_USED_DAYS);
    expect(entitlement.totalDays.toString()).toBe(ENTITLEMENT_TOTAL_DAYS);
  });

  // ── Test 7: conflict is reported, not written, no unique violation ──────
  it("conflict: a codeless legacy row colliding with an already-coded row is reported, not written", async () => {
    const dryRun: BackfillSummary = await main(["--tenant-id", tenantBId], app.prisma);

    expect(dryRun.planned.some((p) => p.leaveTypeId === conflictingLegacyRowId)).toBe(false);
    const conflict = dryRun.conflicts.find((c) => c.leaveTypeId === conflictingLegacyRowId);
    expect(conflict).toBeDefined();
    expect(conflict!.to).toBe("VACATION");
    expect(conflict!.heldBy).toBe(existingVacationRowId);

    // --apply must not throw (no @@unique([tenantId, code]) violation) and must not write the row.
    const applied: BackfillSummary = await main(["--tenant-id", tenantBId, "--apply"], app.prisma);
    expect(applied.applied).toBe(0);

    const row = await app.prisma.leaveType.findUniqueOrThrow({
      where: { id: conflictingLegacyRowId },
    });
    expect(row.code).toBeNull();

    const existingRow = await app.prisma.leaveType.findUniqueOrThrow({
      where: { id: existingVacationRowId },
    });
    expect(existingRow.code).toBe("VACATION"); // untouched
    expect(existingRow.name).toBe("Urlaub");
  });

  // ── --all-tenants scope smoke test ───────────────────────────────────────
  it("--all-tenants scans at least both fixture tenants", async () => {
    const summary: BackfillSummary = await main(["--all-tenants"], app.prisma);
    expect(summary.tenantsScanned).toBeGreaterThanOrEqual(2);
  });
});
