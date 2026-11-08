// Issue #840 review IN-08 - the token-name rewrite left a duplicated phrase in the Berufsschule CSS
// comment of the two time-entry calendars. A one-line source pin so it does not come back.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FILES = [
  "src/routes/(app)/time-entries/+page.svelte",
  "src/routes/(app)/team/time-entries/+page.svelte",
];

describe("Berufsschule calendar CSS comment (IN-08)", () => {
  for (const file of FILES) {
    it(`${file} says "a token-level leave type" once`, () => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source.length).toBeGreaterThan(10_000);
      expect(source).toContain("token-level\n     leave type for Berufsschule");
      expect(source).not.toMatch(/token-level\s+a token-level/);
    });
  }
});
