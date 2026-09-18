/**
 * Guard-vacuity fixture — the `scannedAtLeastOne` idiom, but the flag is set in the DIRECTORY
 * (outer) loop while an inner FILE loop, also walk-derived, is nested inside it. Accepted, but
 * reported distinctly (D-05 class e concern: an outer loop can run while every inner set is
 * empty). Classification: walks=true, asserts=true, inputProof="flag-outer".
 */
import { readdirSync } from "node:fs";

export function scanDirectories(root: string): void {
  const dirs = readdirSync(root);
  let scannedAtLeastOne = false;
  for (const dir of dirs) {
    scannedAtLeastOne = true;
    const files = readdirSync(dir);
    for (const file of files) {
      expect(file).not.toContain("forbidden");
    }
  }
  expect(scannedAtLeastOne).toBe(true);
}
