/**
 * Guard-vacuity fixture — the accepted `.length` proof shape (D-02):
 * `expect(files.length).toBeGreaterThan(0)`. Classification: walks=true, asserts=true,
 * inputProof="length".
 */
import { readdirSync } from "node:fs";

export function checkFilesExist(dir: string): void {
  const files = readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
}
