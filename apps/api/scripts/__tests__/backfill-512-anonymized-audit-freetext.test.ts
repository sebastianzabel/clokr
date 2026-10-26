/**
 * Issue #512: the backfill redacts, for persons anonymized BEFORE #512, the free text in the
 * AuditLog values naming them - dry run by default, idempotent, nothing for live persons.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, soleAuditRow } from "../../src/__tests__/setup";
import { runBackfill, BACKFILL_MARKER } from "../backfill-512-anonymized-audit-freetext";

const TEXT = "Freitext 512 mit Namen Frau Beispiel";

describe("backfill 512: AuditLog free text of anonymized persons (Bestand)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let legacy: string;
  let live: string;
  let legacyRow: string;
  let liveRow: string;

  async function makeEmployee(label: string, anonymized: boolean) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: anonymized ? "Gelöscht" : "Max",
        lastName: anonymized ? `GELÖSCHT-${label}` : label,
        employeeNumber: `${label}-${suffix}`,
        hireDate: new Date("2024-01-01"),
      },
    });
  }

  const auditFor = async (employeeId: string) =>
    (
      await app.prisma.auditLog.create({
        data: {
          action: "UPDATE",
          entity: "Absence",
          entityId: crypto.randomUUID(),
          newValue: { employeeId, auditReason: TEXT, days: 3 },
        },
      })
    ).id;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bf-512");
    legacy = (await makeEmployee("legacy512", true)).id;
    live = (await makeEmployee("live512", false)).id;
    legacyRow = await auditFor(legacy);
    liveRow = await auditFor(live);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("backfill-512 cleanup failed:", err);
    }
  });

  const stored = async (id: string) =>
    JSON.stringify((await app.prisma.auditLog.findUniqueOrThrow({ where: { id } })).newValue);

  it("dry run counts and writes nothing", async () => {
    const results = await runBackfill(app, { confirm: false, tenantId: data.tenant.id });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ employeeId: legacy, outcome: "planned" });
    expect(results[0].redaction.rowsRedacted).toBe(1);
    expect(await stored(legacyRow)).toContain(TEXT);
  });

  it("--confirm redacts the anonymized person only, audits counts, and is idempotent", async () => {
    const results = await runBackfill(app, { confirm: true, tenantId: data.tenant.id });
    expect(results[0].outcome).toBe("written");
    expect(await stored(legacyRow)).not.toContain(TEXT);
    expect(await stored(legacyRow)).toContain('"days":3');
    expect(await stored(liveRow)).toContain(TEXT); // live person untouched

    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "Employee", entityId: legacy, action: "UPDATE" },
    });
    expect(audit.newValue).toEqual({ auditRowsRedacted: 1, ...BACKFILL_MARKER });

    const again = await runBackfill(app, { confirm: true, tenantId: data.tenant.id });
    expect(again[0].outcome).toBe("unchanged");
  });
});
