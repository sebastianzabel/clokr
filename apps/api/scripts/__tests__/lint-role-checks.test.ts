/**
 * Phase 75b Plan 12 (Issue #75, D-19) — fixture test for `lint-role-checks.ts`.
 *
 * Every shape the gate must flag and every shape it must tolerate gets its own case, driven
 * against fixture TEXT through the pure `findRoleChecks(fileName, sourceText)` — never against
 * the live tree alone: on a clean tree the gate reports nothing, and "nothing found" proves nothing
 * about a detector (the same reasoning as `lint-facade-signatures.test.ts`). The file selection
 * (`isGatedFile`: which paths are read at all) is tested separately, because it is a property of the
 * PATH, not of the text. A small live-tree suite at the bottom pins that the real walk is
 * non-empty and the real tree is clean.
 *
 * DB-free, disk-write-free.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverGatedFiles,
  findRoleChecks,
  isGatedFile,
  ROLE_TYPED_EXEMPT_FILE,
  scanRepository,
  type RoleCheckShape,
} from "../lint-role-checks";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function shapes(source: string, fileName = "fixture.ts"): RoleCheckShape[] {
  return findRoleChecks(fileName, source).map((f) => f.shape);
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

  it("a parameter typed SystemRoleName compared against a role literal, outside the exempt file", () => {
    expect(
      shapes(`function isAdmin(r: SystemRoleName) { return r === "ADMIN"; }`, "route.ts"),
    ).toEqual(["role-comparison"]);
  });

  it("a parameter typed LegacySystemRoleName compared against a role literal", () => {
    expect(
      shapes(`function isAdmin(r: LegacySystemRoleName) { return "ADMIN" === r; }`, "route.ts"),
    ).toEqual(["role-comparison"]);
  });

  it("a nullable SystemRoleName parameter and a typed variable are role-valued too", () => {
    const src = `
      function a(r: SystemRoleName | null) { return r !== "EMPLOYEE"; }
      function b(r: string) { const typed: SystemRoleName = parse(r); return typed == "MANAGER"; }
    `;
    expect(shapes(src, "route.ts")).toEqual(["role-comparison", "role-comparison"]);
  });

  it("a switch and a membership test over a SystemRoleName parameter are flagged outside the exempt file", () => {
    const src = `
      function a(r: SystemRoleName) {
        switch (r) {
          case "ADMIN": return 1;
          default: return 0;
        }
      }
      function b(r: SystemRoleName) { return allowed.includes(r); }
    `;
    expect(shapes(src, "apps/api/src/contexts/platform/api/employees.ts")).toEqual([
      "role-switch",
      "role-membership",
    ]);
  });

  it("the Prisma Role type no longer exists, so a parameter typed Role is not a role vocabulary", () => {
    expect(shapes(`function f(role: Role) { return role === "ADMIN"; }`)).toEqual([]);
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

  // The one named exemption (#641, WR-02): the assignment logic of `system-role-assignment.ts`
  // compares a REQUESTED role carried by a `SystemRoleName` parameter, which decides nothing about
  // the caller. The same text is a finding in every other file (see the flagged shapes above).
  it("a parameter typed SystemRoleName compared against a literal is not a finding inside the exempt file", () => {
    expect(
      shapes(
        `function isDemotion(role: SystemRoleName) { return role === "EMPLOYEE"; }`,
        ROLE_TYPED_EXEMPT_FILE,
      ),
    ).toEqual([]);
  });

  it("the same text IS a finding when the file name is any other path", () => {
    const src = `function isDemotion(role: SystemRoleName) { return role === "EMPLOYEE"; }`;
    expect(shapes(src, ROLE_TYPED_EXEMPT_FILE)).toEqual([]);
    expect(shapes(src, "apps/api/src/contexts/absence/system-role-assignment.ts")).toEqual([
      "role-comparison",
    ]);
    expect(shapes(src, "apps/api/src/contexts/platform/api/employees.ts")).toEqual([
      "role-comparison",
    ]);
  });

  it("a switch over a SystemRoleName parameter is not a finding inside the exempt file", () => {
    const src = `
      function idFor(role: SystemRoleName): string {
        switch (role) {
          case "ADMIN": return "a";
          case "MANAGER": return "m";
          default: return "e";
        }
      }
    `;
    expect(shapes(src, ROLE_TYPED_EXEMPT_FILE)).toEqual([]);
  });

  it("the exemption covers typed identifiers only: a .role property read is still a finding inside the exempt file", () => {
    expect(
      shapes(`if (body.role !== "EMPLOYEE") { needManage(); }`, ROLE_TYPED_EXEMPT_FILE),
    ).toEqual(["role-comparison"]);
  });

  it('body.role !== "EMPLOYEE" — a property access on a request body is still a finding', () => {
    expect(shapes(`if (body.role !== "EMPLOYEE") { needManage(); }`)).toEqual(["role-comparison"]);
  });
});

// ── File selection: every non-test file, no allowlist ─────────────────────────────────────────

describe("isGatedFile — which files the gate reads", () => {
  it("the exempt system-role assignment module is still READ by the gate (it narrows findings, not the walk)", () => {
    expect(isGatedFile("apps/api/src/contexts/platform/system-role-assignment.ts")).toBe(true);
  });

  it("a file inside a __tests__ directory is not gated", () => {
    expect(isGatedFile("apps/api/src/__tests__/permission-neutrality-matrix.test.ts")).toBe(false);
    expect(isGatedFile("apps/api/src/contexts/platform/__tests__/helpers.ts")).toBe(false);
  });

  it("a *.test.ts file outside __tests__ is not gated", () => {
    expect(isGatedFile("apps/api/src/utils/foo.test.ts")).toBe(false);
  });

  it("every other .ts file under apps/api/src is gated — including another system-role-assignment.ts elsewhere", () => {
    expect(isGatedFile("apps/api/src/middleware/auth.ts")).toBe(true);
    expect(isGatedFile("apps/api/src/composition/reports.ts")).toBe(true);
    expect(isGatedFile("apps/api/src/contexts/absence/system-role-assignment.ts")).toBe(true);
  });

  it("files outside apps/api/src and non-.ts files are not gated", () => {
    expect(isGatedFile("apps/api/scripts/lint-role-checks.ts")).toBe(false);
    expect(isGatedFile("apps/api/src/contexts/platform/README.md")).toBe(false);
  });
});

// ── Live tree ────────────────────────────────────────────────────────────────────────────────────

describe("live tree", () => {
  it("the named exempt file exists, so the exemption cannot be stale", () => {
    expect(existsSync(join(REPO_ROOT, ROLE_TYPED_EXEMPT_FILE))).toBe(true);
  });

  it("the walk over apps/api/src is non-empty and includes the system-role assignment module", () => {
    const files = discoverGatedFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("apps/api/src/middleware/auth.ts");
    expect(files).toContain("apps/api/src/contexts/platform/system-role-assignment.ts");
    expect(files.some((f) => f.includes("/__tests__/") || f.endsWith(".test.ts"))).toBe(false);
  });

  it("the real tree has no role check in any gated file", () => {
    const result = scanRepository(REPO_ROOT);
    expect(result.findings).toEqual([]);
  });
});
