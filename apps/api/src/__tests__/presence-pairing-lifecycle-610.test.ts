/**
 * Issue #610 (Phase 610-02, Task 3, D-04, P-610-09): a pairing code names a device address, so it
 * leaves the system on every path:
 *  - the token cleanup hard-deletes codes older than a day (consumed or not);
 *  - the DSGVO anonymization deletes the codes the person consumed (others stay);
 *  - the int data refresh (pseudonymize-dump.ts) deletes every code;
 *  - the anonymization validator reports a leftover code of an anonymized user.
 * The two scripts run on module load (DATABASE_URL, process.exit), so they are pinned by source.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { cleanupTestData, closeTestApp, getTestApp, seedTestData } from "./setup";
import { anonymizeEmployeeData } from "../contexts/platform/anonymize";
import { hashPairingCode } from "../contexts/time-tracking/pairing-code";
import { createPresenceSourceWithKey, randomTestMac } from "./presence-pairing-fixtures-610";

const API_ROOT = join(__dirname, "..", "..");
const read = (relative: string) => readFileSync(join(API_ROOT, relative), "utf8");
const HOUR_MS = 3600 * 1000;

describe("pairing codes leave the system (Issue #610, D-04)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sourceId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, `-life610-${randomBytes(3).toString("hex")}`);
    ({ sourceId } = await createPresenceSourceWithKey(app, data.tenant.id));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("presence-pairing-lifecycle-610 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function makeCode(options: { ageHours: number; consumedByUserId?: string | null }) {
    const createdAt = new Date(Date.now() - options.ageHours * HOUR_MS);
    return app.prisma.presencePairingCode.create({
      data: {
        tenantId: data.tenant.id,
        presenceSourceId: sourceId,
        codeHash: hashPairingCode(randomBytes(32).toString("hex")),
        mac: randomTestMac(),
        expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
        createdAt,
        consumedAt: options.consumedByUserId ? createdAt : null,
        consumedByUserId: options.consumedByUserId ?? null,
      },
    });
  }

  async function makePerson(label: string) {
    const suffix = randomBytes(4).toString("hex");
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
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

  it("the token cleanup deletes codes older than 24 h (consumed or not) and keeps younger ones", async () => {
    const oldUnconsumed = await makeCode({ ageHours: 25 });
    const oldConsumed = await makeCode({ ageHours: 30, consumedByUserId: data.empUser.id });
    const nearlyOld = await makeCode({ ageHours: 23 });
    const fresh = await makeCode({ ageHours: 0 });
    const info = vi.spyOn(app.log, "info");

    await app.purgeExpiredTokens!();

    const alive = await app.prisma.presencePairingCode.findMany({
      where: { id: { in: [oldUnconsumed.id, oldConsumed.id, nearlyOld.id, fresh.id] } },
      select: { id: true },
    });
    expect(alive.map((r) => r.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [nearlyOld.id, fresh.id].sort((a, b) => a.localeCompare(b)),
    );
    // the log line names the pairing-code count
    const lines = info.mock.calls.map((call) => String(call[call.length - 1]));
    expect(lines.some((line) => /pairing code/i.test(line))).toBe(true);
    info.mockRestore();
  });

  it("the token cleanup still purges expired OTP and refresh tokens", async () => {
    const userId = data.adminUser.id;
    const past = new Date(Date.now() - HOUR_MS);
    const rt = await app.prisma.refreshToken.create({
      data: { token: `life610-rt-${randomBytes(6).toString("hex")}`, userId, expiresAt: past },
    });
    const otp = await app.prisma.otpToken.create({
      data: { code: "000000", userId, expiresAt: past },
    });

    await app.purgeExpiredTokens!();

    expect(await app.prisma.refreshToken.findUnique({ where: { id: rt.id } })).toBeNull();
    expect(await app.prisma.otpToken.findUnique({ where: { id: otp.id } })).toBeNull();
  });

  it("anonymizing a person deletes the codes they consumed and keeps everyone else's", async () => {
    const person = await makePerson("target");
    const other = await makePerson("other");
    const ownA = await makeCode({ ageHours: 1, consumedByUserId: person.user.id });
    const ownB = await makeCode({ ageHours: 2, consumedByUserId: person.user.id });
    const othersConsumed = await makeCode({ ageHours: 1, consumedByUserId: other.user.id });
    const unconsumed = await makeCode({ ageHours: 1 });

    await app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId: person.employee.id,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );

    const remaining = await app.prisma.presencePairingCode.findMany({
      where: { id: { in: [ownA.id, ownB.id, othersConsumed.id, unconsumed.id] } },
      select: { id: true },
    });
    expect(remaining.map((r) => r.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [othersConsumed.id, unconsumed.id].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("platform code reaches the table only through the facade", () => {
    for (const file of [
      "src/contexts/platform/plugins/token-cleanup.ts",
      "src/contexts/platform/anonymize.ts",
    ]) {
      const source = read(file);
      expect(source.length, file).toBeGreaterThan(0);
      expect(source, file).not.toMatch(/\.presencePairingCode\./);
    }
    expect(read("src/contexts/platform/plugins/token-cleanup.ts")).toMatch(
      /purgeStalePairingCodes\(/,
    );
    expect(read("src/contexts/platform/anonymize.ts")).toMatch(/deletePairingCodesOfUser\(/);
  });

  it("the int refresh script deletes every pairing code once per run and fails on a leftover", () => {
    const source = read("scripts/pseudonymize-dump.ts");
    expect(source).toMatch(/prisma\.presencePairingCode\.deleteMany\(\{\}\)/);
    // Once per run, not inside the per-employee transaction.
    const loopStart = source.indexOf("for (let i = 0; i < employees.length; i++)");
    const loopEnd = source.indexOf("processed++;");
    expect(loopStart).toBeGreaterThan(-1);
    expect(source.slice(loopStart, loopEnd)).not.toContain("presencePairingCode");
    expect(source).toMatch(/residualPairingCodes > 0/);
    // the file header lists the table
    expect(source.slice(0, source.indexOf("*/"))).toContain("PresencePairingCode");
  });

  it("the anonymization validator reports a code of an anonymized user as blocking and runs the check", () => {
    const source = read("scripts/validate-anonymization.ts");
    expect(source).toMatch(
      /passwordHash: "ANONYMIZED"[\s\S]*?prisma\.presencePairingCode\.count\(\{\s*where: \{ consumedByUserId: \{ in:/,
    );
    expect(source).toMatch(/rule: "pairing-codes-not-cleared",\s*severity: "blocking"/);
    expect(source).toMatch(/checkPairingCodes\],/);
  });
});
