/**
 * Issue #805 — the batch pseudonymizer leaves DSGVO-anonymized persons alone.
 *
 * `pseudonymize-dump.ts` used to give EVERY employee a fantasy name, anonymized persons included, so
 * int no longer recognised them as anonymized. The rule is the app's own (`isAnonymizedEmployee()` /
 * `ANONYMIZED_EMPLOYEE_WHERE`); the script imports it and spells no name check of its own, which a
 * source scan below pins. The sweep here only touches this file's own fixture employees.
 *
 * Importing `../pseudonymize-dump` is side-effect-free (run-guard). No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  ANONYMIZED_EMPLOYEE_WHERE,
  isAnonymizedEmployee,
} from "../../src/contexts/platform/employee-anonymization-filter";
import { pseudonymizeEmployees } from "../pseudonymize-dump";

describe("pseudonymize-dump keeps anonymized persons anonymized (Issue #805)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "805-pseudo");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function makePerson(opts: { anonymized: boolean; nfc: string | null }) {
    const suffix = crypto.randomBytes(4).toString("hex");
    const user = await app.prisma.user.create({
      data: {
        email: opts.anonymized
          ? `deleted-${suffix}@anonymized.local`
          : `real-${suffix}@example.com`,
        passwordHash: opts.anonymized ? "ANONYMIZED" : "not-a-real-hash",
        isActive: !opts.anonymized,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        employeeNumber: `P805-${suffix}`,
        firstName: opts.anonymized ? "Gelöscht" : "Echtvorname",
        lastName: opts.anonymized ? `GELÖSCHT-P805-${suffix}` : "Echtnachname",
        nfcCardId: opts.nfc,
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  it("an anonymized person stays anonymized, every other person gets a fantasy name", async () => {
    const anon = await makePerson({ anonymized: true, nfc: null });
    const normal = await makePerson({ anonymized: false, nfc: `nfc-${crypto.randomUUID()}` });
    const targets = [anon.employee, normal.employee].sort((a, b) => a.id.localeCompare(b.id));

    const result = await pseudonymizeEmployees(app.prisma, targets);

    expect(result).toEqual({ processed: 1, preserved: 1 });

    const anonAfter = await app.prisma.employee.findUniqueOrThrow({
      where: { id: anon.employee.id },
    });
    expect(isAnonymizedEmployee(anonAfter)).toBe(true);
    expect(anonAfter.firstName).toBe(anon.employee.firstName);
    expect(anonAfter.lastName).toBe(anon.employee.lastName);
    expect(anonAfter.employeeNumber).toBe(anon.employee.employeeNumber);
    // The user is not re-personalized either.
    const anonUser = await app.prisma.user.findUniqueOrThrow({ where: { id: anon.user.id } });
    expect(anonUser.email).toBe(anon.user.email);
    expect(anonUser.passwordHash).toBe("ANONYMIZED");
    expect(anonUser.isActive).toBe(false);

    const normalAfter = await app.prisma.employee.findUniqueOrThrow({
      where: { id: normal.employee.id },
    });
    expect(isAnonymizedEmployee(normalAfter)).toBe(false);
    expect(normalAfter.firstName).not.toBe("Echtvorname");
    expect(normalAfter.lastName).not.toBe("Echtnachname");
    expect(normalAfter.nfcCardId).toBeNull();
    expect(normalAfter.employeeNumber).toBe(normal.employee.employeeNumber);
    const normalUser = await app.prisma.user.findUniqueOrThrow({ where: { id: normal.user.id } });
    expect(normalUser.email.endsWith("@example.invalid")).toBe(true);
    expect(normalUser.passwordHash).toBe("ANONYMIZED");

    // The DB form and the in-memory form of the app's rule agree on both rows.
    const dbMatches = await app.prisma.employee.findMany({
      where: { AND: [{ id: { in: targets.map((t) => t.id) } }, ANONYMIZED_EMPLOYEE_WHERE] },
      select: { id: true },
    });
    expect(dbMatches.map((r) => r.id)).toEqual([anon.employee.id]);
  });

  it("a legacy anonymized user that still carries a real address is brought to the anonymized form", async () => {
    const anon = await makePerson({ anonymized: true, nfc: null });
    await app.prisma.user.update({
      where: { id: anon.user.id },
      data: { email: `leak-${crypto.randomBytes(4).toString("hex")}@example.com` },
    });

    await pseudonymizeEmployees(app.prisma, [anon.employee]);

    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: anon.user.id } });
    expect(user.email.endsWith("@anonymized.local")).toBe(true);
  });

  it("the script spells no name check of its own and takes the rule from the app module", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "pseudonymize-dump.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).toContain("employee-anonymization-filter");
    expect(code).toContain("isAnonymizedEmployee(");
    expect(code).toContain("ANONYMIZED_EMPLOYEE_WHERE");
    expect(code).not.toMatch(/GELÖSCHT-|["']Gelöscht["']/);
  });
});
