/**
 * Issue #561 — fixture test for `lint-unordered-test-reads.ts`.
 *
 * Every shape the gate must flag and tolerate is driven against fixture TEXT through the pure
 * `findUnorderedReads()` — on a clean tree the gate reports nothing, and "nothing found" proves
 * nothing about a detector. The live-tree suite pins that the real walk is non-empty and clean.
 *
 * DB-free, disk-write-free.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverTestFiles,
  findUnorderedReads,
  isTestFile,
  type UnorderedReadShape,
} from "../lint-unordered-test-reads";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function shapes(source: string): UnorderedReadShape[] {
  return findUnorderedReads("fixture.test.ts", source).map((f) => f.shape);
}

describe("flagged shapes", () => {
  it("flags an unordered auditLog.findFirst", () => {
    expect(
      shapes(`await app.prisma.auditLog.findFirst({ where: { entity: "X", entityId: id } });`),
    ).toEqual(["bare-find-first"]);
  });

  it("flags findFirstOrThrow, findFirst without arguments and a non-literal argument", () => {
    expect(shapes(`await prisma.auditLog.findFirstOrThrow({ where: { id } });`)).toEqual([
      "bare-find-first",
    ]);
    expect(shapes(`await prisma.auditLog.findFirst();`)).toEqual(["bare-find-first"]);
    expect(shapes(`await prisma.auditLog.findFirst(args);`)).toEqual(["bare-find-first"]);
    expect(shapes(`await prisma.auditLog.findFirst({ ...base });`)).toEqual(["bare-find-first"]);
  });

  it("flags an unordered notification.findFirst (also on a transaction client)", () => {
    expect(shapes(`await tx.notification.findFirst({ where: { userId } });`)).toEqual([
      "bare-find-first",
    ]);
  });

  it("flags an unordered findMany that is indexed directly, via .at() or via a bound name", () => {
    expect(shapes(`const a = (await prisma.auditLog.findMany({ where: w }))[0];`)).toEqual([
      "unordered-find-many-indexed",
    ]);
    expect(shapes(`const a = (await prisma.auditLog.findMany({ where: w })).at(0);`)).toEqual([
      "unordered-find-many-indexed",
    ]);
    expect(
      shapes(`const logs = await prisma.auditLog.findMany({ where: w });\nlogs[0]!.action;`),
    ).toEqual(["unordered-find-many-indexed"]);
    expect(
      shapes(`const rows = await prisma.notification.findMany({ where: w });\nrows.at(-1);`),
    ).toEqual(["unordered-find-many-indexed"]);
    expect(shapes(`const [first] = await prisma.auditLog.findMany({ where: w });`)).toEqual([
      "unordered-find-many-indexed",
    ]);
  });
});

describe("tolerated shapes", () => {
  it("flags even an ordered findFirst - ordering does not prove uniqueness", () => {
    expect(
      shapes(
        `await prisma.auditLog.findFirst({ where: w, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });`,
      ),
    ).toEqual(["bare-find-first"]);
    expect(
      shapes(`await prisma.notification.findFirst({ where: w, orderBy: { createdAt: "desc" } });`),
    ).toEqual(["bare-find-first"]);
  });

  it("accepts the sole-row helpers", () => {
    expect(shapes(`await soleAuditRow(app.prisma, { where: w });`)).toEqual([]);
    expect(shapes(`await soleNotificationOrNull(app.prisma, { where: w });`)).toEqual([]);
  });

  it("accepts an unordered findMany that is only counted, filtered or iterated", () => {
    expect(
      shapes(`const logs = await prisma.auditLog.findMany({ where: w });\nlogs.length;`),
    ).toEqual([]);
    expect(
      shapes(`const logs = await prisma.auditLog.findMany({ where: w });\nlogs.filter(f);`),
    ).toEqual([]);
  });

  it("accepts an ordered findMany that is indexed", () => {
    expect(
      shapes(
        `const logs = await prisma.auditLog.findMany({ where: w, orderBy: { id: "asc" } });\nlogs[0];`,
      ),
    ).toEqual([]);
  });

  it("ignores other models and a mention in a comment or a string", () => {
    expect(shapes(`await prisma.timeEntry.findFirst({ where: w });`)).toEqual([]);
    expect(
      shapes(`// prisma.auditLog.findFirst({ where: w })\nconst s = "auditLog.findFirst(";`),
    ).toEqual([]);
  });
});

describe("file selection", () => {
  it("gates test files under apps/api/src only", () => {
    expect(isTestFile("apps/api/src/__tests__/setup.ts")).toBe(true);
    expect(isTestFile("apps/api/src/contexts/absence/__tests__/x.test.ts")).toBe(true);
    expect(isTestFile("apps/api/src/contexts/absence/plugins/carryover-warning.ts")).toBe(false);
    expect(isTestFile("apps/api/scripts/lint-unordered-test-reads.ts")).toBe(false);
  });
});

describe("live tree", () => {
  it("the walk is non-empty and the real tree has no unordered audit/notification read", () => {
    const files = discoverTestFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("apps/api/src/__tests__/next-year-vacation-entitlement.test.ts");
    const findings = files.flatMap((f) =>
      findUnorderedReads(f, readFileSync(join(REPO_ROOT, f), "utf8")),
    );
    expect(findings).toEqual([]);
  });
});
