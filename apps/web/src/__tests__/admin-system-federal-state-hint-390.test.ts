// Issue #390: the tenant Bundesland is only a default for newly created salons; statutory
// holidays follow Salon.federalState. Source pin (route pages cannot be mounted here, see
// admin-system-save-wiring.test.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/(app)/admin/system/+page.svelte"),
  "utf8",
);
const flat = source.replace(/\s+/g, " ");

describe("admin/system Bundesland hint (#390)", () => {
  it("states the field is a default for new salons and holidays follow the salon", () => {
    expect(flat).toContain(
      "Vorgabe für neu angelegte Salons. Feiertage richten sich nach dem Bundesland des jeweiligen Salons (Admin → Salons).",
    );
  });

  it("no longer claims the tenant Bundesland determines holidays", () => {
    expect(flat).not.toContain("Bestimmt gesetzliche Feiertage");
  });
});
