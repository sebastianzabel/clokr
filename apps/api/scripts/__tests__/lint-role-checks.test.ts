/**
 * Phase 75b Plan 12 (Issue #75, D-19) — fixture test for `lint-role-checks.ts`.
 *
 * Every shape the gate must flag and every shape it must tolerate gets its own case, driven
 * against fixture TEXT through the pure `findRoleChecks(fileName, sourceText)` — never against
 * the live tree alone: on a clean tree the gate reports nothing, and "nothing found" proves nothing
 * about a detector (the same reasoning as `lint-facade-signatures.test.ts`). The file selection
 * (`isGatedFile`: allowlist, test files) is tested separately, because it is a property of the
 * PATH, not of the text. A small live-tree suite at the bottom pins that the real walk is
 * non-empty and the real tree is clean.
 *
 * DB-free, disk-write-free.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_FILE,
  discoverGatedFiles,
  findRoleChecks,
  isGatedFile,
  scanRepository,
  type RoleCheckShape,
} from "../lint-role-checks";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function shapes(source: string): RoleCheckShape[] {
  return findRoleChecks("fixture.ts", source).map((f) => f.shape);
}

// ── Flagged: one case per shape (75b-12-PLAN.md Task 1 <behavior>) ─────────────────────────────

describe("findRoleChecks — flagged shapes", () => {
  it("a call of the removed role guard (as a preHandler)", () => {
    const src = `
      app.get("/x", { preHandler: requireRole("ADMIN", "MANAGER"), handler: async () => {} });
    `;
    expect(shapes(src)).toEqual(["removed-role-guard-call"]);
  });

  it("a call of the removed role guard through a member access", () => {
    expect(shapes(`app.addHook("preHandler", auth.requireRole("ADMIN"));`)).toEqual([
      "removed-role-guard-call",
    ]);
  });

  it('req.user.role === "ADMIN"', () => {
    expect(shapes(`if (req.user.role === "ADMIN") { allow(); }`)).toEqual(["role-comparison"]);
  });

  it('user.role !== "EMPLOYEE"', () => {
    expect(shapes(`const isStaff = user.role !== "EMPLOYEE";`)).toEqual(["role-comparison"]);
  });

  it("the literal on the left-hand side is flagged the same way", () => {
    expect(shapes(`if ("MANAGER" === req.user.role) { allow(); }`)).toEqual(["role-comparison"]);
  });

  it('const role = req.user.role; if (role === "MANAGER")', () => {
    const src = `
      async function handler(req) {
        const role = req.user.role;
        if (role === "MANAGER") return 1;
      }
    `;
    expect(shapes(src)).toEqual(["role-comparison"]);
  });

  it("an identifier initialised through an `as` cast and a second alias is still role-valued", () => {
    const src = `
      const r1 = req.user.role as Role;
      const r2 = r1;
      if (r2 === "ADMIN") allow();
    `;
    expect(shapes(src)).toEqual(["role-comparison"]);
  });

  it('const { role } = req.user; role == "ADMIN"', () => {
    const src = `
      function h(req) {
        const { role } = req.user;
        return role == "ADMIN";
      }
    `;
    expect(shapes(src)).toEqual(["role-comparison"]);
  });

  it("a renamed destructuring out of a bare `user` binding", () => {
    const src = `
      function h(user) {
        const { role: r } = user;
        return r != "EMPLOYEE";
      }
    `;
    expect(shapes(src)).toEqual(["role-comparison"]);
  });

  it("a parameter typed Role compared against a role literal", () => {
    expect(shapes(`function isAdmin(role: Role) { return role === "ADMIN"; }`)).toEqual([
      "role-comparison",
    ]);
  });

  it('["ADMIN", "MANAGER"].includes(user.role)', () => {
    expect(shapes(`if (["ADMIN", "MANAGER"].includes(user.role)) allow();`)).toEqual([
      "role-membership",
    ]);
  });

  it('["ADMIN","MANAGER"].includes(x) — a role-literal array is flagged whatever the argument', () => {
    expect(shapes(`if (["ADMIN","MANAGER"].includes(x)) allow();`)).toEqual(["role-membership"]);
  });

  it("allowedRoles.includes(req.user.role) — a role-valued argument is flagged whatever the receiver", () => {
    expect(shapes(`if (allowedRoles.includes(req.user.role)) allow();`)).toEqual([
      "role-membership",
    ]);
  });

  it('switch (req.user.role) { case "ADMIN": }', () => {
    const src = `
      switch (req.user.role) {
        case "ADMIN":
          allow();
          break;
        default:
          deny();
      }
    `;
    expect(shapes(src)).toEqual(["role-switch"]);
  });

  it('where: { role: { in: ["ADMIN", "MANAGER"] } }', () => {
    const src = `
      await prisma.user.findMany({ where: { tenantId, role: { in: ["ADMIN", "MANAGER"] } } });
    `;
    expect(shapes(src)).toEqual(["role-where-predicate"]);
  });

  it('where: { user: { role: "ADMIN" } } — a nested relation filter', () => {
    const src = `
      await prisma.employee.findMany({ where: { tenantId, user: { role: "ADMIN" } } });
    `;
    expect(shapes(src)).toEqual(["role-where-predicate"]);
  });

  it("a where object built in a variable typed as a Prisma WhereInput", () => {
    const src = `
      const userWhere: Prisma.UserWhereInput = { tenantId, role: "MANAGER" };
      await prisma.user.findMany({ where: userWhere });
    `;
    expect(shapes(src)).toEqual(["role-where-predicate"]);
  });

  it('e.user.role === "MANAGER" inside a filter callback', () => {
    const src = `
      const managers = employees.filter((e) => e.user.role === "MANAGER");
    `;
    expect(shapes(src)).toEqual(["role-comparison"]);
  });

  it("reports the 1-based line of the flagged node", () => {
    const src = `const a = 1;\nconst b = 2;\nif (req.user.role === "ADMIN") allow();\n`;
    expect(findRoleChecks("fixture.ts", src)).toEqual([
      { line: 3, shape: "role-comparison", text: 'req.user.role === "ADMIN"' },
    ]);
  });
});

// ── Tolerated: none of these is an access decision about the caller ────────────────────────────

describe("findRoleChecks — tolerated shapes", () => {
  it('data: { role: "ADMIN" } — a creation payload, not a predicate', () => {
    const src = `
      await tx.user.create({ data: { email, passwordHash, role: "ADMIN" } });
    `;
    expect(shapes(src)).toEqual([]);
  });

  it('z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]) — input validation', () => {
    expect(
      shapes(`const s = z.object({ role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]) });`),
    ).toEqual([]);
  });

  it("a type literal union — types are not expressions", () => {
    const src = `
      type Row = { user: { role: "ADMIN" | "MANAGER" | "EMPLOYEE" } };
      interface Data { role: "ADMIN" | "MANAGER" | "EMPLOYEE"; roleFilter: "all" | "EMPLOYEE" }
    `;
    expect(shapes(src)).toEqual([]);
  });

  it('data.roleFilter === "EMPLOYEE" — a property named roleFilter, not role', () => {
    expect(shapes(`const label = data.roleFilter === "EMPLOYEE" ? "a" : "b";`)).toEqual([]);
  });

  it('const { role } = req.query; role === "MANAGER" — a query parameter, not a user', () => {
    const src = `
      async function handler(req) {
        const { role } = req.query as { role?: string };
        const f = role === "MANAGER" ? "MANAGER" : undefined;
      }
    `;
    expect(shapes(src)).toEqual([]);
  });

  it("a query-parameter `role` is not confused with a user `role` in another function", () => {
    const src = `
      function a(req) {
        const { role } = req.user;
        log(role);
      }
      function b(req) {
        const { role } = req.query as { role?: string };
        return role === "MANAGER";
      }
    `;
    expect(shapes(src)).toEqual([]);
  });

  it("role: emp.user.role — report data", () => {
    expect(shapes(`rows.push({ name, role: emp.user.role });`)).toEqual([]);
  });

  it("actorRole: req.user.role — an audit value", () => {
    expect(shapes(`await app.audit({ newValue: { actorRole: req.user.role } });`)).toEqual([]);
  });

  it('role: isAdmin ? "ADMIN" : "MANAGER" — the API-key compat assignment', () => {
    const src = `
      const isAdmin = apiKey.scopes.includes("admin");
      req.user = { sub, role: isAdmin ? "ADMIN" : ("MANAGER" as Role), tenantId };
    `;
    expect(shapes(src)).toEqual([]);
  });

  it("body.role !== undefined — a presence test, not a role literal", () => {
    expect(shapes(`if (body.role !== undefined) { replace(); }`)).toEqual([]);
  });

  it("role literals in comments and strings never count (AST, not regex)", () => {
    const src = `
      // if (req.user.role === "ADMIN") — the old shape
      /* requireRole("ADMIN") */
      const doc = 'req.user.role === "ADMIN"';
      const tpl = \`requireRole("ADMIN")\`;
    `;
    expect(shapes(src)).toEqual([]);
  });
});

// ── File selection: the single allowlist and the test-file skip ─────────────────────────────────

describe("isGatedFile — which files the gate reads", () => {
  it("any flagged shape inside compat-role.ts is allowlisted (the one compat derivation, D-14)", () => {
    expect(ALLOWLISTED_FILE).toBe("apps/api/src/contexts/platform/compat-role.ts");
    expect(isGatedFile("apps/api/src/contexts/platform/compat-role.ts")).toBe(false);
  });

  it("a file inside a __tests__ directory is not gated", () => {
    expect(isGatedFile("apps/api/src/__tests__/permission-neutrality-matrix.test.ts")).toBe(false);
    expect(isGatedFile("apps/api/src/contexts/platform/__tests__/helpers.ts")).toBe(false);
  });

  it("a *.test.ts file outside __tests__ is not gated", () => {
    expect(isGatedFile("apps/api/src/utils/foo.test.ts")).toBe(false);
  });

  it("every other .ts file under apps/api/src is gated — including another compat-role.ts elsewhere", () => {
    expect(isGatedFile("apps/api/src/middleware/auth.ts")).toBe(true);
    expect(isGatedFile("apps/api/src/composition/reports.ts")).toBe(true);
    expect(isGatedFile("apps/api/src/contexts/absence/compat-role.ts")).toBe(true);
  });

  it("files outside apps/api/src and non-.ts files are not gated", () => {
    expect(isGatedFile("apps/api/scripts/lint-role-checks.ts")).toBe(false);
    expect(isGatedFile("apps/api/src/contexts/platform/README.md")).toBe(false);
  });
});

// ── Live tree ────────────────────────────────────────────────────────────────────────────────────

describe("live tree", () => {
  it("the walk over apps/api/src is non-empty and excludes the allowlisted file", () => {
    const files = discoverGatedFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("apps/api/src/middleware/auth.ts");
    expect(files).not.toContain(ALLOWLISTED_FILE);
    expect(files.some((f) => f.includes("/__tests__/") || f.endsWith(".test.ts"))).toBe(false);
  });

  it("the real tree has no role check outside the allowlisted file", () => {
    const result = scanRepository(REPO_ROOT);
    expect(result.findings).toEqual([]);
  });
});
