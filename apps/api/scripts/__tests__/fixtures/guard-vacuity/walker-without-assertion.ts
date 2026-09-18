/**
 * Guard-vacuity fixture — walks and returns; asserts nothing. Outside D-02's set (a vacuous
 * guard needs BOTH halves), so this shape must never be reported by the future gate even though
 * `asserts` is false. Classification: walks=true, asserts=false, inputProof="none".
 */
import { readdirSync } from "node:fs";

export function listFiles(dir: string): string[] {
  return readdirSync(dir);
}
