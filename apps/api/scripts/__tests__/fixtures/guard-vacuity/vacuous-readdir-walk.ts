/**
 * Guard-vacuity fixture — the TARGET DEFECT itself (D-02): a real fs walk paired with an
 * assertion that never proves the walked set was non-empty. Classification: walks=true,
 * asserts=true, inputProof="none" (`content` is derived from `.join`, not a length/flag proof).
 */
import { readdirSync } from "node:fs";

export function checkNoForbiddenWord(dir: string): void {
  const files = readdirSync(dir);
  const content = files.join(",");
  expect(content).not.toContain("forbiddenWord");
}
