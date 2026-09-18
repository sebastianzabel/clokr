/**
 * Guard-vacuity fixture — the `"contains"` proof shape (Plan 235-02, baseline-verification
 * finding, `absence-vocabulary-guard.test.ts`'s real idiom): `expect([...walkDerivedSet]).
 * toContain(knownMember)`. A set that CONTAINS a specific known member cannot be empty — at
 * least as strong a non-emptiness proof as `.length > 0`. Classification: walks=true,
 * asserts=true, inputProof="contains".
 */
import { readdirSync } from "node:fs";

export function checkKnownFileIsScanned(dir: string, knownFile: string): void {
  const scanned = new Set(readdirSync(dir));
  expect([...scanned]).toContain(knownFile);
}
