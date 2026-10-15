/**
 * Issue #551 — fixture test for audit-551-users-without-employee.ts.
 *
 * The script is a read-only survey of users without an Employee (they can no longer sign in since
 * #551). It prints ids, flags and counts only. The worker test database may hold bare users
 * left behind by other files, so the assertions look for the fixture's own line and never for
 * exact totals.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { main, EXIT_OK, EXIT_ERROR, EXIT_FINDINGS } from "../audit-551-users-without-employee";

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    spy.mockRestore();
  }
}

describe("audit-551-users-without-employee (Issue #551)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let bareUserId: string;
  let bareEmail: string;
  let run: { code: number; lines: string[] };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "audit551");
    bareEmail = `bare-audit551-${randomBytes(4).toString("hex")}@test.invalid`;
    const bare = await app.prisma.user.create({
      data: { email: bareEmail, passwordHash: "x", role: "ADMIN", isActive: true },
    });
    bareUserId = bare.id;
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    await app.prisma.refreshToken.createMany({
      data: [
        // open: not revoked, not expired
        {
          token: `audit551-open-${randomBytes(6).toString("hex")}`,
          userId: bareUserId,
          expiresAt: new Date(now + 24 * hour),
        },
        // revoked
        {
          token: `audit551-revoked-${randomBytes(6).toString("hex")}`,
          userId: bareUserId,
          expiresAt: new Date(now + 24 * hour),
          revokedAt: new Date(now - hour),
        },
        // expired
        {
          token: `audit551-expired-${randomBytes(6).toString("hex")}`,
          userId: bareUserId,
          expiresAt: new Date(now - hour),
        },
      ],
    });
    run = await capture(() => main([], app.prisma));
  });

  afterAll(async () => {
    try {
      await app.prisma.refreshToken.deleteMany({ where: { userId: bareUserId } });
      await app.prisma.user.deleteMany({ where: { id: bareUserId } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("audit-551 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("lists the user without an Employee with open refresh tokens and role assignments, and exits 2", () => {
    expect(run.code).toBe(EXIT_FINDINGS);
    const own = run.lines.filter((l) => l.includes(`userId=${bareUserId}`));
    expect(own).toHaveLength(1);
    // #539 (D-12): the compat role is not part of the output any more.
    expect(own[0]).not.toContain("role=ADMIN");
    expect(own[0]).not.toMatch(/\brole=/);
    expect(own[0]).toContain("isActive=true");
    expect(own[0]).toContain("openRefreshTokens=1");
    expect(own[0]).toContain("roleAssignments=0");
  });

  it("does not list a user that has an Employee, and prints a totals line", () => {
    const output = run.lines.join("\n");
    expect(output).not.toContain(data.adminUser.id);
    expect(output).not.toContain(data.empUser.id);
    expect(run.lines.some((l) => /^Totals: users=\d+ activeUsers=\d+ /.test(l))).toBe(true);
  });

  it("prints ids only: no mail address and no name appears in any output line", () => {
    for (const line of run.lines) expect(line).not.toContain("@");
    expect(run.lines.join("\n")).not.toContain(bareEmail);
  });

  it("--help exits 0 and an unknown flag is rejected", async () => {
    const help = await capture(() => main(["--help"], app.prisma));
    expect(help.code).toBe(EXIT_OK);
    expect(help.lines.join("\n")).toContain("READ-ONLY");
    await expect(main(["--apply"], app.prisma)).rejects.toThrow();
    await expect(main(["--confirm"], app.prisma)).rejects.toThrow();
  });

  it("without DATABASE_URL and without an injected client it exits 1 and connects to nothing", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main([])).toBe(EXIT_ERROR);
    } finally {
      errSpy.mockRestore();
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("is read-only: the fixture rows are unchanged by the runs and the source has no write call", async () => {
    const tokens = await app.prisma.refreshToken.count({ where: { userId: bareUserId } });
    expect(tokens).toBe(3);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: bareUserId } });
    expect(user.passwordHash).toBe("x");

    const source = readFileSync(
      fileURLToPath(new URL("../audit-551-users-without-employee.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000); // anti-vacuity: the scan read a real file
    expect(source).not.toMatch(
      /\.(update|create|delete|updateMany|deleteMany|upsert|createMany)\(/,
    );
    expect(source).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it("importing the module is side-effect-free (the entrypoint guard keeps it from running)", () => {
    // This file imported the module at the top: had main() run on import, the run above would not be
    // the only one and a missing DATABASE_URL would have set a failing exit code.
    expect(process.exitCode ?? 0).toBe(0);
  });
});
