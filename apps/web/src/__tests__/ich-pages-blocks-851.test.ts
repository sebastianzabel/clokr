// Issue #851 (D-851-01…06) - the pages of the area Ich are built from the design-system blocks: no
// page-own filter bar, period control, KPI card or data table, and no register entry left for #851.
//
// Anchor-first: the Ich routes come from the one route table, and the walked set is asserted
// non-empty before any page is judged.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { detectPagePatterns } from "../../scripts/lint-ui-classes.mjs";
import { APP_ROUTES } from "$lib/nav/routes";

function webRoot(): string {
  try {
    return fileURLToPath(new URL("../..", import.meta.url));
  } catch {
    return process.cwd();
  }
}

const ROOT = webRoot();
const ich = APP_ROUTES.filter((r) => r.area === "ich" && r.file !== "/dashboard");
// A page created after #844 has no `file`: it lives at its own URL.
const pages = ich.map((r) => ({
  href: r.href,
  file: `src/routes/(app)${r.file ?? r.href}/+page.svelte`,
}));

describe("Ich pages on the blocks (#851)", () => {
  it("finds the Ich pages in the route table", () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((p) => p.href)).toEqual(
      expect.arrayContaining([
        "/ich/zeiten",
        "/ich/abwesenheiten",
        "/ich/dienstplan",
        "/ich/profil",
      ]),
    );
  });

  it.each(pages)(
    "$href has no page-own filter bar, period control, KPI card or table",
    ({ file }) => {
      const counts = detectPagePatterns(readFileSync(resolve(ROOT, file), "utf8")) as Record<
        string,
        number
      >;
      expect(counts).toEqual({
        "own-filter-bar": 0,
        "own-period-control": 0,
        "own-kpi-card": 0,
        "own-data-table": 0,
        "raw-scrim-modal": 0,
      });
    },
  );

  it("the ratchet register names #851 nowhere any more", () => {
    const register = readFileSync(
      resolve(ROOT, "scripts/lint-ui-classes-route-ratchet.json"),
      "utf8",
    );
    expect(register).toContain('"ticket"');
    expect(register).not.toContain('"#851"');
  });

  it("Konto is in the rail of every signed-in person (#594, owner decision 09.11.2026)", () => {
    const konto = APP_ROUTES.find((r) => r.href === "/ich/konto");
    expect(konto).toMatchObject({ area: "ich", label: "Konto", requires: null, inNav: true });
  });
});
