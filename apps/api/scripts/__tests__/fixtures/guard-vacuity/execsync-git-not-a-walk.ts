/**
 * Guard-vacuity fixture — `execSync` shelling out to `git` is not a tree walk. Only a
 * find/grep/ls/rg command counts as a walk primitive. Classification: walks=false, asserts=true,
 * inputProof="none".
 */
import { execSync } from "node:child_process";

export function currentCommit(): void {
  const sha = execSync("git rev-parse HEAD").toString().trim();
  expect(sha.length).toBeGreaterThan(0);
}
