// Guard-vacuity fixture (.mjs) — the apps/web `.mjs` guard shape: shelling out to `find` counts
// as a tree-walk primitive. Classification: walks=true, asserts=true, inputProof="none" (`files`
// is derived through `.toString().trim()`, methods outside the accepted chain-derivation set, so
// it is not tracked as walk-derived, and `toBeDefined` is not one of the accepted proof shapes
// regardless).
import { execSync } from "node:child_process";

export function listSvelteFiles() {
  const output = execSync("find src -name '*.svelte'");
  const files = output.toString().trim().split("\n");
  expect(files).toBeDefined();
  return files;
}
