/**
 * Phase 88 Plan 04 - tests for lint-tenant-scoping-nullish-tenant.ts (GitHub Issue #88, D-08/D-08a).
 *
 * DB-free: fixtures are parsed in memory with `ts.createSourceFile`, never executed or
 * type-checked. The integration cases drive `runLint` against a throwaway mini repo in a temp dir
 * and against the real tree.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";
import {
  findNullishTenantValues,
  scanNullishTenantSource,
  listNullishScanFiles,
} from "../lint-tenant-scoping-nullish-tenant";
import { runLint } from "../lint-tenant-scoping";
import { SCOPED_DIRS } from "../lint-tenant-scoping-types";

const REPO_ROOT = path.resolve(process.cwd(), "../..");

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
}

function findings(text: string) {
  return findNullishTenantValues(parse(text), "apps/api/src/fixture.ts");
}

describe("nullish-tenant rules", () => {
  it("R1: a literal undefined tenantId inside a findMany is a finding", () => {
    const f = findings(`
      export async function list(prisma: any) {
        return prisma.employee.findMany({ where: { tenantId: undefined } });
      }
    `);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "R1", model: "employee", method: "findMany" });
  });

  it("R1: void 0 is a finding too", () => {
    const f = findings(`
      export async function list(prisma: any) {
        return prisma.employee.findMany({ where: { tenantId: void 0 } });
      }
    `);
    expect(f.map((x) => x.rule)).toEqual(["R1"]);
  });

  it("R2: an optional chain without a fallback is a finding", () => {
    const f = findings(`
      export async function list(prisma: any, user: any) {
        return prisma.salon.findMany({ where: { tenantId: user.employee?.tenantId } });
      }
    `);
    expect(f.map((x) => x.rule)).toEqual(["R2"]);
  });

  it("R2: the fail-closed idiom '?? \"\"' is legal", () => {
    const f = findings(`
      export async function list(prisma: any, user: any) {
        return prisma.salon.findMany({ where: { tenantId: user.employee?.tenantId ?? "" } });
      }
    `);
    expect(f).toEqual([]);
  });

  it("R2: '?? undefined' is still a finding", () => {
    const f = findings(`
      export async function list(prisma: any, user: any) {
        return prisma.salon.findMany({ where: { tenantId: user.employee?.tenantId ?? undefined } });
      }
    `);
    expect(f).toHaveLength(1);
  });

  it("R3: a conditional with an undefined branch is a finding", () => {
    const f = findings(`
      export async function list(prisma: any, cond: boolean, id: string) {
        return prisma.salon.findMany({ where: { tenantId: cond ? id : undefined } });
      }
    `);
    expect(f.map((x) => x.rule)).toEqual(["R3"]);
  });

  it("R3: a short-circuit '&&' value is a finding", () => {
    const f = findings(`
      export async function list(prisma: any, cond: boolean, id: string) {
        return prisma.salon.findMany({ where: { tenantId: cond && id } });
      }
    `);
    expect(f.map((x) => x.rule)).toEqual(["R3"]);
  });

  it("R4: a shorthand bound to an optional parameter is a finding", () => {
    const f = findings(`
      export async function list(db: any, tenantId?: string) {
        return db.salon.findMany({ where: { tenantId } });
      }
    `);
    expect(f.map((x) => x.rule)).toEqual(["R4"]);
  });

  it("R4: a parameter annotated 'string | undefined' is a finding", () => {
    const f = findings(`
      export async function list(db: any, tid: string | undefined) {
        return db.salon.findMany({ where: { tenantId: tid } });
      }
    `);
    expect(f.map((x) => x.rule)).toEqual(["R4"]);
  });

  it("R4: a destructured parameter whose inline type makes tenantId optional is a finding", () => {
    const f = findings(`
      export async function list(db: any, { tenantId }: { tenantId?: string }) {
        return db.salon.findMany({ where: { tenantId } });
      }
    `);
    expect(f.map((x) => x.rule)).toEqual(["R4"]);
  });

  it("R4: a required string parameter is legal", () => {
    const f = findings(`
      export async function list(db: any, tenantId: string) {
        return db.salon.findMany({ where: { tenantId } });
      }
    `);
    expect(f).toEqual([]);
  });

  it("R4: an optional parameter narrowed by an early return is legal", () => {
    const f = findings(`
      export async function list(db: any, tenantId?: string) {
        if (!tenantId) return [];
        return db.salon.findMany({ where: { tenantId } });
      }
    `);
    expect(f).toEqual([]);
  });

  it("legal: req.user.tenantId and string literals", () => {
    const f = findings(`
      export async function list(app: any, req: any) {
        await app.prisma.salon.findMany({ where: { tenantId: req.user.tenantId } });
        await app.prisma.salon.findMany({ where: { tenantId: "t-1" } });
        await app.prisma.salon.findMany({ where: { tenantId: null } });
      }
    `);
    expect(f).toEqual([]);
  });

  it("nesting: relation filters and data payloads are checked at any depth", () => {
    const f = findings(`
      export async function run(prisma: any) {
        await prisma.timeEntry.findMany({ where: { employee: { tenantId: undefined } } });
        await prisma.salon.create({ data: { tenantId: undefined, name: "x" } });
      }
    `);
    expect(f).toHaveLength(2);
  });

  it("every Prisma method counts, not only the lookup methods", () => {
    const methods = [
      "count",
      "aggregate",
      "groupBy",
      "create",
      "createMany",
      "upsert",
      "updateMany",
      "deleteMany",
    ];
    for (const m of methods) {
      const f = findings(`export async function f(prisma: any) {
        return prisma.salon.${m}({ where: { tenantId: undefined } });
      }`);
      expect(f, m).toHaveLength(1);
    }
  });

  it("a where object bound to a local const is followed", () => {
    const f = findings(`
      export async function list(prisma: any, user: any) {
        const where = { tenantId: user.employee?.tenantId };
        return prisma.salon.findMany({ where });
      }
    `);
    expect(f.map((x) => x.rule)).toEqual(["R2"]);
  });

  it("non-Prisma calls are not scanned", () => {
    const f = findings(`
      export async function f(app: any, user: any) {
        app.notify({ tenantId: user.employee?.tenantId });
        somethingElse.employee.helper({ tenantId: undefined });
      }
    `);
    expect(f).toEqual([]);
  });

  it("scanNullishTenantSource counts the Prisma calls it saw", () => {
    const r = scanNullishTenantSource(
      parse(`
        export async function f(prisma: any) {
          await prisma.salon.findMany({ where: {} });
          await prisma.salon.count({ where: {} });
          other.thing();
        }
      `),
      "apps/api/src/x.ts",
    );
    expect(r.calls).toBe(2);
    expect(r.findings).toEqual([]);
  });
});

// ── runLint integration ─────────────────────────────────────────────────────────────────────────

function makeMiniRepo(extra: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nullish-tenant-"));
  for (const dir of SCOPED_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });
  // One clean in-scope call keeps the existing zero-in-scope guard satisfied.
  fs.writeFileSync(
    path.join(root, "apps/api/src/services/ok.ts"),
    `export async function ok(prisma: any) {
       return prisma.employee.findFirst({ where: { id: "x", tenantId: "t" } });
     }\n`,
  );
  for (const [rel, text] of Object.entries(extra)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

describe("runLint integration", () => {
  it("a fixture with an undefined tenantId makes the gate exit 1 with a finding", () => {
    const root = makeMiniRepo({
      "apps/api/src/plugins/bad.ts": `export async function bad(prisma: any) {
        return prisma.employee.findMany({ where: { tenantId: undefined } });
      }\n`,
    });
    try {
      const r = runLint({ repoRoot: root });
      expect(r.exitCode).toBe(1);
      const hit = r.findings.find((f) => f.rule === "nullish-tenant");
      expect(hit).toBeDefined();
      expect(hit!.call.file).toBe("apps/api/src/plugins/bad.ts");
      expect(hit!.detail).toContain("nullish-tenant");
      expect(r.counts.nullishFindings).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a clean mini repo exits 0 and counts the scanned calls", () => {
    const root = makeMiniRepo({});
    try {
      const r = runLint({ repoRoot: root });
      expect(r.errors).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(r.counts.nullishScanned).toBeGreaterThan(0);
      expect(r.counts.nullishFindings).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("zero scanned Prisma calls is an error, never 'all clean'", () => {
    const root = makeMiniRepo({});
    // Remove the only Prisma call so both the old guard and the new one have nothing to scan.
    fs.writeFileSync(path.join(root, "apps/api/src/services/ok.ts"), "export const a = 1;\n");
    try {
      const r = runLint({ repoRoot: root });
      expect(r.exitCode).toBe(1);
      expect(r.errors.some((e) => e.includes("nullish-tenant"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("listNullishScanFiles throws on an empty or missing walk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nullish-empty-"));
    try {
      expect(() => listNullishScanFiles(root)).toThrow();
      fs.mkdirSync(path.join(root, "apps/api/src"), { recursive: true });
      expect(() => listNullishScanFiles(root)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("listNullishScanFiles skips __tests__ and *.test.ts", () => {
    const root = makeMiniRepo({
      "apps/api/src/contexts/x/__tests__/a.ts": "export {};\n",
      "apps/api/src/contexts/x/b.test.ts": "export {};\n",
      "apps/api/src/plugins/c.ts": "export {};\n",
    });
    try {
      const files = listNullishScanFiles(root);
      expect(files).toContain("apps/api/src/plugins/c.ts");
      expect(files.some((f) => f.includes("__tests__"))).toBe(false);
      expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the real tree: scanned calls > 0 and zero nullish findings", () => {
    const r = runLint({ repoRoot: REPO_ROOT });
    expect(r.counts.nullishScanned).toBeGreaterThan(100);
    const nullish = r.findings.filter((f) => f.rule === "nullish-tenant");
    expect(
      nullish.map((f) => `${f.call.file}:${f.call.line} ${f.detail}`),
      "a nullish-tenant hit on the clean tree is a finding - fix it at the source",
    ).toEqual([]);
  });
});
