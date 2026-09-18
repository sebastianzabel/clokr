/**
 * Guard-vacuity fixture — chained method call on a DIRECT CALL to a walk-containing function
 * (Plan 235-02, baseline-verification finding, `section9-model.test.ts`'s real idiom:
 * `walk(srcRoot).filter(...)`). Before this fixture's fix, `isWalkDerivedExpr`'s chain-method
 * branch only recursed into a receiver that was itself EITHER a raw walk-primitive call OR
 * another chain — a receiver that is a plain call to a walk-CONTAINING function (`walk(dir)`,
 * not `readdirSync(dir)` directly) fell through to `return false`, so `files` below was never
 * recognised as derived and the genuine `.length > 0` proof one line later was misclassified as
 * absent. Classification: walks=true, asserts=true, inputProof="length".
 */
import { readdirSync } from "node:fs";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    out.push(entry);
  }
  return out;
}

export function checkTsFilesExist(dir: string): void {
  const files = walk(dir).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
}
