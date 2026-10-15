/**
 * Issue #539 (Release A), D-09 — the database seeds give every user they create its system role
 * as a stored assignment.
 *
 * `packages/db` cannot import `apps/api`, so the seeds use their own helper
 * (`packages/db/src/seed-role-assignments.ts`) with a pinned copy of the three system-role ids.
 * This file is the drift guard the helper's header names:
 *
 *  - the pinned ids equal `SYSTEM_ROLE_IDS` (a drift would map a seeded user to the wrong role);
 *  - each seed module calls the helper once per user-creation call site, right after it. The seed
 *    modules run a whole seed on import and are never loaded here — they are read as text;
 *  - the seed build (`tsconfig.seed.json`) compiles the helper, otherwise the container's
 *    `dist/src/seed.js` would fail on its first import;
 *  - on a real tenant the helper writes exactly the row employee creation writes, is idempotent
 *    and grants what `grantSystemRole` grants.
 *
 * Fixtures: synthetic `@example.invalid` addresses only, no person names.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, grantSystemRole } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { effectivePermissionKeysForUser } from "../contexts/platform/request-permissions";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

// The helper lives outside this package's `rootDir`, so a static import would fail `tsc`
// (TS6059); it has no side effects and is loaded by absolute path with a local shape.
interface SeedRoleAssignmentsModule {
  SEED_SYSTEM_ROLE_IDS: Record<string, string>;
  ensureSystemRoleAssignment(
    prisma: unknown,
    input: { tenantId: string; userId: string; role: "ADMIN" | "MANAGER" | "EMPLOYEE" },
  ): Promise<void>;
}
const HELPER_PATH = join(REPO_ROOT, "packages/db/src/seed-role-assignments.ts");
let SEED_SYSTEM_ROLE_IDS: SeedRoleAssignmentsModule["SEED_SYSTEM_ROLE_IDS"];
let ensureSystemRoleAssignment: SeedRoleAssignmentsModule["ensureSystemRoleAssignment"];

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ HELPER_PATH)) as SeedRoleAssignmentsModule;
  SEED_SYSTEM_ROLE_IDS = mod.SEED_SYSTEM_ROLE_IDS;
  ensureSystemRoleAssignment = mod.ensureSystemRoleAssignment;
});
const SEED_MODULES = [
  "packages/db/src/seed.ts",
  "packages/db/src/seed-demo.ts",
  "packages/db/src/reset-demo.ts",
] as const;

/** Every user-creation and helper call of a seed module, in source order. */
function callEvents(source: string): Array<"user" | "helper"> {
  const events: Array<{ at: number; kind: "user" | "helper" }> = [];
  for (const match of source.matchAll(/prisma\.user\.(?:create|upsert)\(/g)) {
    events.push({ at: match.index ?? 0, kind: "user" });
  }
  for (const match of source.matchAll(/ensureSystemRoleAssignment\(/g)) {
    events.push({ at: match.index ?? 0, kind: "helper" });
  }
  return events.sort((a, b) => a.at - b.at).map((e) => e.kind);
}

describe("seed role assignments (#539, D-09)", () => {
  describe("pinned copy", () => {
    it("SEED_SYSTEM_ROLE_IDS equals SYSTEM_ROLE_IDS for the three legacy system roles", () => {
      expect(Object.keys(SEED_SYSTEM_ROLE_IDS).sort()).toEqual(["ADMIN", "EMPLOYEE", "MANAGER"]);
      expect(SEED_SYSTEM_ROLE_IDS.ADMIN).toBe(SYSTEM_ROLE_IDS.ADMIN);
      expect(SEED_SYSTEM_ROLE_IDS.MANAGER).toBe(SYSTEM_ROLE_IDS.MANAGER);
      expect(SEED_SYSTEM_ROLE_IDS.EMPLOYEE).toBe(SYSTEM_ROLE_IDS.EMPLOYEE);
    });
  });

  describe("seed source parity", () => {
    for (const rel of SEED_MODULES) {
      it(`${rel}: every user-creation call is followed by a helper call before the next one`, () => {
        const source = readFileSync(join(REPO_ROOT, rel), "utf8");
        const events = callEvents(source);
        const users = events.filter((e) => e === "user").length;
        const helpers = events.filter((e) => e === "helper").length;
        // Non-vacuity: a seed without a user-creation call would pass everything below.
        expect(users, `${rel} has no prisma.user.create/upsert call`).toBeGreaterThan(0);
        expect(helpers, `${rel}: helper calls vs user-creation calls`).toBe(users);
        // Strict alternation: user, helper, user, helper ... — a helper never precedes its user
        // and no user is created twice in a row without its assignment.
        events.forEach((kind, index) => {
          expect(kind, `${rel}: event ${index} of ${events.join(",")}`).toBe(
            index % 2 === 0 ? "user" : "helper",
          );
        });
      });
    }
  });

  describe("seed build", () => {
    it("tsconfig.seed.json compiles the helper module", () => {
      const config = JSON.parse(
        readFileSync(join(REPO_ROOT, "packages/db/tsconfig.seed.json"), "utf8"),
      ) as {
        include: string[];
      };
      expect(config.include).toContain("src/seed-role-assignments.ts");
    });
  });

  describe("helper on a real tenant", () => {
    let app: FastifyInstance;
    let seed: Awaited<ReturnType<typeof seedTestData>>;

    async function plainUser(label: string, role: "ADMIN" | "MANAGER" | "EMPLOYEE") {
      const s = randomBytes(4).toString("hex");
      const user = await app.prisma.user.create({
        data: {
          email: `seed539-${label}-${s}@example.invalid`,
          passwordHash: "x",
          role,
          isActive: true,
        },
      });
      // The employee row is what `cleanupTestData` walks to find the user again.
      await app.prisma.employee.create({
        data: {
          tenantId: seed.tenant.id,
          userId: user.id,
          employeeNumber: `S5-${s}`,
          firstName: label,
          lastName: "Seed",
          hireDate: new Date("2024-01-01"),
        },
      });
      return user;
    }

    beforeAll(async () => {
      app = await getTestApp();
      seed = await seedTestData(app, "539-seedrole");
    });

    afterAll(async () => {
      try {
        await cleanupTestData(app, seed.tenant.id);
      } catch (error) {
        console.error("seed-role-assignments-539 cleanup failed", error);
      }
      await closeTestApp();
    });

    it("writes exactly one TENANT row on the system role, and a second call adds none", async () => {
      const user = await plainUser("row", "MANAGER");
      const input = { tenantId: seed.tenant.id, userId: user.id, role: "MANAGER" as const };
      await ensureSystemRoleAssignment(app.prisma, input);
      await ensureSystemRoleAssignment(app.prisma, input);
      const rows = await app.prisma.roleAssignment.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: seed.tenant.id,
        accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      });
    });

    for (const role of ["ADMIN", "MANAGER", "EMPLOYEE"] as const) {
      it(`${role}: grants the same permission keys as grantSystemRole`, async () => {
        const viaHelper = await plainUser(`h-${role}`, role);
        const viaFixture = await plainUser(`f-${role}`, role);
        await ensureSystemRoleAssignment(app.prisma, {
          tenantId: seed.tenant.id,
          userId: viaHelper.id,
          role,
        });
        await grantSystemRole(app.prisma, {
          tenantId: seed.tenant.id,
          userId: viaFixture.id,
          role,
        });
        const helperKeys = await effectivePermissionKeysForUser(
          app.prisma,
          viaHelper.id,
          seed.tenant.id,
        );
        const fixtureKeys = await effectivePermissionKeysForUser(
          app.prisma,
          viaFixture.id,
          seed.tenant.id,
        );
        expect(helperKeys.length).toBeGreaterThan(0);
        expect([...helperKeys].sort()).toEqual([...fixtureKeys].sort());
      });
    }
  });
});
