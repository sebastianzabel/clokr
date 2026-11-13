/**
 * Issue #215 — `Absence.type` has ONE typed write path, `absenceTypeFields()`.
 *
 * What is compiler-enforced and what is guarded (stated honestly):
 *
 *  - COMPILER: `absenceTypeFields(code: AbsenceCode)` rejects every code outside ABSENCE_CODES.
 *    The negative test below carries `@ts-expect-error`. Vitest does not type-check, so the proof is
 *    `pnpm --filter @clokr/api build` (`tsc`, whose `include` is `src/**` and therefore reaches this
 *    file): if the function ever accepted "VACATION", the directive would be unused and tsc would
 *    fail with TS2578.
 *  - GUARD, not compiler: Prisma's generated `Absence.type` is the full `LeaveTypeCode` and cannot be
 *    narrowed by us, so a hand-written `type: "VACATION"` in a Prisma call still compiles. The source
 *    guard below fails when any write on the `absence` delegate in `apps/api/src` sets `type`
 *    other than by spreading `absenceTypeFields(...)`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  ABSENCE_CODES,
  IMPOSED_ONLY_CODES,
  REQUESTABLE_CODES,
  absenceTypeFields,
} from "../contexts/absence/leave-type";

describe("absenceTypeFields — type level", () => {
  it("accepts every Absence-valid code and returns the data fragment", () => {
    for (const code of ABSENCE_CODES) expect(absenceTypeFields(code)).toEqual({ type: code });
  });

  it("does not compile for a requestable-only code (checked by tsc via the build, not by vitest)", () => {
    const attempt = () => {
      // @ts-expect-error — VACATION is a LeaveRequest code, never an Absence code
      absenceTypeFields("VACATION");
      // @ts-expect-error — SICK belongs to LeaveRequest as well
      absenceTypeFields("SICK");
    };
    expect(typeof attempt).toBe("function"); // never called: the proof is the compiler
  });

  it("ABSENCE_CODES is the explicit Absence-valid set: both imposed codes plus MATERNITY and PARENTAL", () => {
    expect([...ABSENCE_CODES].sort()).toEqual(
      ["MATERNITY", "OTHER", "PARENTAL", "VOCATIONAL_SCHOOL"].sort(),
    );
    for (const code of IMPOSED_ONLY_CODES) expect(ABSENCE_CODES).toContain(code);
    // Not derived from IMPOSED_ONLY_CODES: MATERNITY/PARENTAL are requestable AND Absence-valid.
    expect(ABSENCE_CODES.filter((c) => REQUESTABLE_CODES.includes(c as never))).toEqual([
      "MATERNITY",
      "PARENTAL",
    ]);
  });
});

describe("absence writes in apps/api/src — source guard", () => {
  const SRC = join(__dirname, "..");
  const WRITE_METHODS = new Set([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "upsert",
  ]);
  const DATA_KEYS = new Set(["data", "create", "update"]);

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) out.push(...files(abs));
      else if (entry.endsWith(".ts")) out.push(abs);
    }
    return out;
  }

  function scan(source: string, name: string): { writes: number; violations: string[] } {
    const sf = ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true);
    let writes = 0;
    const violations: string[] = [];
    const where = (n: ts.Node) =>
      `${name}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

    function checkData(node: ts.Node) {
      ts.forEachChild(node, function visit(n) {
        if (
          (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
          n.name.getText(sf) === "type"
        ) {
          violations.push(`${where(n)}: Absence write sets type: outside absenceTypeFields()`);
        }
        ts.forEachChild(n, visit);
      });
    }

    function visit(n: ts.Node) {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        WRITE_METHODS.has(n.expression.name.text) &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        n.expression.expression.name.text === "absence"
      ) {
        writes += 1;
        const arg = n.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) {
          violations.push(`${where(n)}: Absence write argument is not an object literal`);
        } else {
          for (const prop of arg.properties) {
            if (ts.isPropertyAssignment(prop) && DATA_KEYS.has(prop.name.getText(sf))) {
              checkData(
                prop.initializer.kind === ts.SyntaxKind.ObjectLiteralExpression
                  ? prop.initializer
                  : prop,
              );
              if (
                !ts.isObjectLiteralExpression(prop.initializer) &&
                !ts.isArrayLiteralExpression(prop.initializer)
              ) {
                violations.push(
                  `${where(prop)}: Absence write ${prop.name.getText(sf)} is not a literal`,
                );
              }
            } else if (ts.isShorthandPropertyAssignment(prop) && DATA_KEYS.has(prop.name.text)) {
              violations.push(`${where(prop)}: Absence write data is not a literal`);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    return { writes, violations };
  }

  const sourceFiles = files(SRC);

  it("the scan reaches the two production create sites (a gate that looks at nothing passes anyway)", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    const writes = sourceFiles
      .map((abs) => scan(readFileSync(abs, "utf-8"), relative(SRC, abs)).writes)
      .reduce((a, b) => a + b, 0);
    expect(writes).toBeGreaterThanOrEqual(2);
  });

  it("no absence create/createMany/update/upsert sets type: except through absenceTypeFields()", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const abs of sourceFiles) {
      violations.push(...scan(readFileSync(abs, "utf-8"), relative(SRC, abs)).violations);
    }
    expect(violations.join("\n")).toBe("");
  });

  it("the scanner itself flags a literal type: and accepts the spread (self-check)", () => {
    const bad = scan(
      `await db.absence.create({ data: { employeeId, type: "VACATION" } });`,
      "bad.ts",
    );
    expect(bad.writes).toBe(1);
    expect(bad.violations).toHaveLength(1);
    const good = scan(
      `await tx.absence.create({ data: { employeeId, ...absenceTypeFields("OTHER") } });`,
      "good.ts",
    );
    expect(good.writes).toBe(1);
    expect(good.violations).toEqual([]);
    const upsert = scan(
      `await db.absence.upsert({ where: { id }, create: { type: "SICK" }, update: {} });`,
      "u.ts",
    );
    expect(upsert.violations).toHaveLength(1);
  });
});
