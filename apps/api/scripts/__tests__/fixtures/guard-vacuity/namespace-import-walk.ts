/**
 * Guard-vacuity fixture — the receiver-variant form (D-05 class f): the walk primitive is
 * reached via a namespace-import receiver (`fs.readdirSync`), not a named import. Binding
 * resolution must handle both forms. Classification: walks=true, asserts=true,
 * inputProof="length".
 */
import * as fs from "node:fs";

export function checkFiles(dir: string): void {
  const files = fs.readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
}
