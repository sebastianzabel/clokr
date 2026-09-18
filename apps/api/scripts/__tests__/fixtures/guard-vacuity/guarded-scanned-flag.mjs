// Guard-vacuity fixture (.mjs) — pins ScriptKind.JS parsing AND the `scannedAtLeastOne` idiom
// from apps/api/src/__tests__/section9-credit.test.ts in one fixture: the flag is set in the
// INNERMOST walk-derived loop (over files), with no other walk-derived loop nested inside it.
// Classification: walks=true, asserts=true, inputProof="flag-inner".
import { readdirSync } from "node:fs";

export function scanPlugins(contextsDir) {
  const contextNames = readdirSync(contextsDir);
  let scannedAtLeastOne = false;
  for (const contextName of contextNames) {
    const files = readdirSync(contextsDir + "/" + contextName);
    for (const file of files) {
      scannedAtLeastOne = true;
      expect(file).not.toContain("forbidden");
    }
  }
  expect(scannedAtLeastOne).toBe(true);
}
