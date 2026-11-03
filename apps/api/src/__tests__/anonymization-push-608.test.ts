/**
 * Issue #608 (D-04, D-22): every path that erases or copies person data forgets push devices.
 *  - the DSGVO anonymization hard-deletes the person's devices inside its transaction (others stay);
 *  - the int data refresh (pseudonymize-dump.ts) deletes every device;
 *  - the anonymization validator reports a leftover device;
 *  - the test cleanup removes devices before the tenant (tenant FK is onDelete: Restrict).
 * The two scripts run on module load (DATABASE_URL, process.exit), so they are pinned by source.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { anonymizeEmployeeData } from "../contexts/platform/anonymize";
import { fakeDeviceSubscription } from "./push-fixtures-608";

const API_ROOT = join(__dirname, "..", "..");
const read = (relative: string) => readFileSync(join(API_ROOT, relative), "utf8");

describe("anonymization and data paths forget push devices (#608)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let personId: string;
  let personUserId: string;
  let otherUserId: string;

  async function makePerson(label: string) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Max",
        lastName: label,
        employeeNumber: `${label}-${suffix}`,
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  async function addDevice(tenantId: string, userId: string) {
    const sub = fakeDeviceSubscription();
    await app.prisma.pushSubscription.create({
      data: {
        tenantId,
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        deviceLabel: "Chrome auf Android",
        consentedAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, `-anon608-${randomBytes(3).toString("hex")}`);
    const person = await makePerson("target");
    const other = await makePerson("other");
    personId = person.employee.id;
    personUserId = person.user.id;
    otherUserId = other.user.id;
    await addDevice(data.tenant.id, personUserId);
    await addDevice(data.tenant.id, personUserId);
    await addDevice(data.tenant.id, otherUserId);
  });

  afterAll(async () => {
    // No manual push cleanup on purpose: cleanupTestData must cope with remaining devices.
    await cleanupTestData(app, data.tenant.id);
  });

  it("deletes the anonymized person's devices, leaves another person's and writes no push audit", async () => {
    expect(await app.prisma.pushSubscription.count({ where: { userId: personUserId } })).toBe(2);
    const auditsBefore = await app.prisma.auditLog.count({ where: { entity: "PushSubscription" } });

    await app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId: personId,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );

    expect(await app.prisma.pushSubscription.count({ where: { userId: personUserId } })).toBe(0);
    expect(await app.prisma.pushSubscription.count({ where: { userId: otherUserId } })).toBe(1);
    expect(await app.prisma.auditLog.count({ where: { entity: "PushSubscription" } })).toBe(
      auditsBefore,
    );
  });

  it("the int refresh script deletes every push device once per run", () => {
    const source = read("scripts/pseudonymize-dump.ts");
    expect(source).toMatch(/prisma\.pushSubscription\.deleteMany\(\{\}\)/);
    // Once per run, not inside the per-employee transaction.
    const loopStart = source.indexOf("for (let i = 0; i < employees.length; i++)");
    const loopEnd = source.indexOf("processed++;");
    expect(loopStart).toBeGreaterThan(-1);
    expect(source.slice(loopStart, loopEnd)).not.toContain("pushSubscription");
    // The inline verification fails the run on a leftover device.
    expect(source).toMatch(/residualPushDevices > 0/);
  });

  it("the anonymization validator counts devices of anonymized users as a blocking finding and runs the check", () => {
    const source = read("scripts/validate-anonymization.ts");
    expect(source).toMatch(
      /prisma\.pushSubscription\.count\(\{\s*where: \{ user: \{ passwordHash: "ANONYMIZED" \} \},?\s*\}\)/,
    );
    expect(source).toMatch(/rule: "push-subscriptions-not-cleared",\s*severity: "blocking"/);
    expect(source).toMatch(/checkPushSubscriptions\],/);
  });

  it("test cleanup and the e2e bootstrap delete devices by tenant before the users and the tenant", () => {
    for (const file of ["src/__tests__/setup.ts", "src/contexts/platform/api/test-bootstrap.ts"]) {
      const source = read(file);
      const push = source.search(
        /pushSubscription\.deleteMany\(\{ where: \{ tenantId(: id)? \} \}\)/,
      );
      const users = source.indexOf("prisma.user.deleteMany", push);
      expect(push, file).toBeGreaterThan(-1);
      expect(users, file).toBeGreaterThan(push);
    }
  });

  it("cleanupTestData removes a tenant that still has a device (no foreign-key error)", async () => {
    const throwaway = await seedTestData(app, `-anon608c-${randomBytes(3).toString("hex")}`);
    await addDevice(throwaway.tenant.id, throwaway.empUser.id);
    await expect(cleanupTestData(app, throwaway.tenant.id)).resolves.not.toThrow();
    expect(await app.prisma.tenant.findUnique({ where: { id: throwaway.tenant.id } })).toBeNull();
  });
});
