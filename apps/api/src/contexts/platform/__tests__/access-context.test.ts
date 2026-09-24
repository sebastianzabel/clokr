/**
 * Phase 77b (Issue #77, D-02/D-03/D-13) — unit tests for the access context's two constructors and
 * the one EmployeeScope factory, plus a structural purity check.
 *
 * DB-free: every case works on plain objects. The purity check parses both module files with the
 * TypeScript AST (not a regex) and asserts `access-context.ts` imports nothing but two type-only
 * modules and the zero-import leaf — which is what makes "the tenant is checked before any DB
 * query" structural rather than a matter of call order.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { FastifyRequest } from "fastify";
import {
  accessContextFromRequest,
  accessContextForJob,
  employeeScopeFor,
  AccessContextError,
  type AccessContext,
} from "../access-context";

function fakeRequest(user: unknown): FastifyRequest {
  return { user } as unknown as FastifyRequest;
}

const VALID_USER = {
  sub: "user-1",
  role: "EMPLOYEE",
  tenantId: "tenant-a",
  employeeId: "emp-1",
};

describe("accessContextFromRequest (Phase 77b, D-02/D-13)", () => {
  it("throws AccessContextError when the request carries no user", () => {
    expect(() => accessContextFromRequest(fakeRequest(undefined))).toThrow(AccessContextError);
    expect(() => accessContextFromRequest(fakeRequest(null))).toThrow(AccessContextError);
  });

  const badTenants: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["a number", 42],
  ];
  for (const [label, tenantId] of badTenants) {
    it(`throws AccessContextError for a ${label} tenant`, () => {
      expect(() => accessContextFromRequest(fakeRequest({ ...VALID_USER, tenantId }))).toThrow(
        AccessContextError,
      );
    });
  }

  it("throws for a user object without the tenantId key", () => {
    const withoutTenant = { sub: VALID_USER.sub, role: VALID_USER.role, employeeId: "emp-1" };
    expect("tenantId" in withoutTenant).toBe(false);
    expect(() => accessContextFromRequest(fakeRequest(withoutTenant))).toThrow(AccessContextError);
  });

  it("builds a user actor with userId and employeeId from a JWT user", () => {
    const ctx = accessContextFromRequest(fakeRequest(VALID_USER));
    expect(ctx).toEqual({
      tenantId: "tenant-a",
      actor: { kind: "user", userId: "user-1", employeeId: "emp-1" },
      reach: { kind: "wholeTenant" },
    });
  });

  it("omits employeeId for a user without an employee record", () => {
    const ctx = accessContextFromRequest(fakeRequest({ ...VALID_USER, employeeId: undefined }));
    expect(ctx.actor).toEqual({ kind: "user", userId: "user-1" });
  });

  it("builds an apiKey actor from an apikey:<id> subject", () => {
    const ctx = accessContextFromRequest(
      fakeRequest({ sub: "apikey:key-123", role: "MANAGER", tenantId: "tenant-a" }),
    );
    expect(ctx.actor).toEqual({ kind: "apiKey", apiKeyId: "key-123" });
    expect(ctx.tenantId).toBe("tenant-a");
    expect(ctx.reach).toEqual({ kind: "wholeTenant" });
  });
});

describe("accessContextForJob (Phase 77b, D-02/D-13)", () => {
  const badTenants: Array<[string, string | null | undefined]> = [
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace-only", "   "],
  ];
  for (const [label, tenantId] of badTenants) {
    it(`throws AccessContextError for a ${label} tenant`, () => {
      expect(() => accessContextForJob(tenantId, "auto-close-month")).toThrow(AccessContextError);
    });
  }

  it("builds a system actor carrying the job name", () => {
    expect(accessContextForJob("tenant-b", "auto-close-month")).toEqual({
      tenantId: "tenant-b",
      actor: { kind: "system", job: "auto-close-month" },
      reach: { kind: "wholeTenant" },
    });
  });
});

describe("employeeScopeFor (Phase 77b, D-03)", () => {
  const ctx = accessContextForJob("tenant-c", "test");

  it("maps no target to the tenant-kind scope", () => {
    expect(employeeScopeFor(ctx)).toEqual({ kind: "tenant", tenantId: "tenant-c" });
  });

  it("maps { employeeId } to the employee-kind scope", () => {
    expect(employeeScopeFor(ctx, { employeeId: "emp-9" })).toEqual({
      kind: "employee",
      employeeId: "emp-9",
      tenantId: "tenant-c",
    });
  });

  it("maps { employeeIds } to the employees-kind scope", () => {
    expect(employeeScopeFor(ctx, { employeeIds: ["emp-1", "emp-2"] })).toEqual({
      kind: "employees",
      employeeIds: ["emp-1", "emp-2"],
      tenantId: "tenant-c",
    });
  });

  it("re-asserts the tenant of a hand-built context", () => {
    const handBuilt = {
      tenantId: "",
      actor: { kind: "system", job: "x" },
      reach: { kind: "wholeTenant" },
    } as AccessContext;
    expect(() => employeeScopeFor(handBuilt)).toThrow(AccessContextError);
    expect(() => employeeScopeFor(handBuilt, { employeeId: "emp-1" })).toThrow(AccessContextError);
  });
});

describe("access context purity (Phase 77b, D-01)", () => {
  const platformDir = join(__dirname, "..");

  function importsOf(fileName: string) {
    const path = join(platformDir, fileName);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    return source.statements.filter(ts.isImportDeclaration).map((decl) => ({
      specifier: (decl.moduleSpecifier as ts.StringLiteral).text,
      typeOnly: decl.importClause?.isTypeOnly === true,
    }));
  }

  it("access-context.ts imports only type-only modules and the zero-import leaf", () => {
    const imports = importsOf("access-context.ts");
    // Non-vacuity: the file really has its three imports, so the per-import check below ran.
    expect(imports.map((i) => i.specifier).sort()).toEqual([
      "./access-context-error",
      "./facade/employee-scope",
      "fastify",
    ]);
    for (const imp of imports) {
      expect(imp.typeOnly || imp.specifier === "./access-context-error").toBe(true);
    }
  });

  it("access-context-error.ts has no import at all", () => {
    expect(importsOf("access-context-error.ts")).toEqual([]);
  });
});
