/**
 * Guard-vacuity fixture — the tool-shape empty-abort: if the walked set is empty, print an
 * error and exit non-zero rather than silently declaring success. Classification: walks=true,
 * asserts=true (via the `process.exit` call), inputProof="empty-abort".
 */
import { readdirSync } from "node:fs";

export function assertFilesPresent(dir: string): void {
  const files = readdirSync(dir);
  if (files.length === 0) {
    console.error("no files found");
    process.exit(1);
  }
}
