// Issue #390: the tenant Bundesland is only a default for newly created salons; statutory
// holidays follow Salon.federalState. Source pin (route pages cannot be mounted here, see
// admin-system-save-wiring.test.ts); since Issue #854 (plan 854-15) the hint is a `Note` of the company section
// and `allgemein-854.test.ts` also mounts it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/lib/components/admin/allgemein/CompanySection.svelte"),
  "utf8",
);
const flat = source.replace(/\s+/g, " ");

describe("System › Allgemein Bundesland hint (#390)", () => {
  it("states the field is a default for new salons and holidays follow the salon", () => {
    expect(flat).toContain(
      "Vorgabe für neu angelegte Salons. Feiertage richten sich nach dem Bundesland des jeweiligen Salons (",
    );
    // #854 (owner review): the pointer names the navigation path and links the page.
    expect(flat).toContain('<a href="/verwalten/salons">Verwalten › Salons</a>');
    expect(flat).not.toContain("Admin →");
  });

  it("is shown as an info Note, not a one-off paragraph", () => {
    expect(flat).toContain('<Note tone="info"> Vorgabe für neu angelegte Salons.');
  });

  it("no longer claims the tenant Bundesland determines holidays", () => {
    expect(flat).not.toContain("Bestimmt gesetzliche Feiertage");
  });
});
