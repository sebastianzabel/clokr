/**
 * Issue #576 (plan 04) — "a team view lists only persons with a contract" has exactly two readers:
 * the team week and today's attendance in `composition/dashboard.ts`. The rule lives in
 * `hasWorkScheduleInPeriodWhere()` (`contexts/platform/employed-in-period.ts`). The period
 * reports, DATEV, the month close and the trends keep the #613 population unchanged, so no other
 * production file may call the predicate.
 *
 * AST scan over the non-test `.ts` files of apps/api/src; comments and strings are never visited.
 * Anti-vacuity: the walked set has to exceed 250 files (330 measured on 2026-11-09).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";
import * as ts from "typescript";

const API_ROOT = join(__dirname, "..", "..");
const API_SRC = join(API_ROOT, "src");
const PREDICATE = "hasWorkScheduleInPeriodWhere";

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...collectSourceFiles(abs));
    else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/** Number of call expressions whose callee is the predicate. */
function callCount(text: string): number {
  const source = ts.createSourceFile("scanned.ts", text, ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === PREDICATE
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return count;
}

const WALKED = collectSourceFiles(API_SRC);

describe("Issue #576 — the contract population has two readers", () => {
  it("walks the API sources", () => {
    expect(WALKED.length, "the scan root moved or emptied").toBeGreaterThan(250);
  });

  it("only composition/dashboard.ts calls the predicate, exactly twice", () => {
    const calls: Record<string, number> = {};
    for (const abs of WALKED) {
      const n = callCount(readFileSync(abs, "utf8"));
      if (n > 0) calls[relative(API_SRC, abs)] = n;
    }
    expect(calls).toEqual({ "composition/dashboard.ts": 2 });
  });
});
