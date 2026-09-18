/**
 * Guard-vacuity fixture — D-03 direction 2: a string literal containing "//" sits on the line
 * before a REAL `readdirSync` call. A naive `//`-stripper would blank the rest of this line and
 * risks misparsing the next one; an AST parser is unaffected because string-literal text is
 * never trivia. Classification: walks=true, asserts=true, inputProof="none" (`files` is a bare
 * identifier checked with `toBeDefined`, not one of the four accepted proof shapes).
 */
import { readdirSync } from "node:fs";

export function listFiles(dir: string): string[] {
  const marker = "// readdirSync(";
  const files = readdirSync(dir);
  expect(files).toBeDefined();
  return files.length > 0 ? files : [marker];
}
