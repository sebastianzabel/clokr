/**
 * Guard-vacuity fixture (WR-01, 235-REVIEW.md) — the default-import binding shape:
 * `import fs from "node:fs"` instead of `import * as fs from "node:fs"`. Node's CJS interop
 * (this repo's tsconfig sets `esModuleInterop`) makes the two behave identically for
 * property-access purposes, and a default import is at least as idiomatic as the namespace form
 * — but `registerNamedImport` used to bail out before ever inspecting `importClause.name`,
 * leaving this shape architecturally invisible (`walks: false`) despite the real
 * `fs.readdirSync` call and the real empty-abort. Reproduces the owner-approved repro transcript
 * in `235-REVIEW.md` WR-01 verbatim. Classification: walks=true, asserts=true,
 * inputProof="empty-abort".
 */
import fs from "node:fs";

export function walk(dir: string): string[] {
  const files = fs.readdirSync(dir);
  if (files.length === 0) {
    throw new Error("empty");
  }
  return files;
}
