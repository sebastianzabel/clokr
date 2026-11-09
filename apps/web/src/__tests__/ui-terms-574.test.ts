// Issue #574 (D-574-05..07) — fixture proof for the shown-text gate
// (`apps/web/scripts/lint-ui-terms.mjs`). A gate whose extractor silently reads nothing reports
// OK forever, so every term is proved with a positive fixture, every non-shown position with a
// negative one, and the walk with an explicit floor.

import { describe, it, expect } from "vitest";

import {
  ALLOWED,
  FORBIDDEN_TERMS,
  listScannedFiles,
  scan,
  scanSource,
} from "../../scripts/lint-ui-terms.mjs";

type Finding = { file: string; line: number; term: string; text: string };

const ROUTE = "src/routes/(app)/dashboard/+page.svelte";
const LEAVE_COMPONENT = "src/lib/components/leave/Example.svelte";
const MODULE = "src/lib/example/labels.ts";

const termsOf = (file: string, source: string): string[] =>
  (scanSource(file, source) as Finding[]).map((f) => f.term);

/** One shown sentence per term id; each must be reported in an ordinary route file. */
const POSITIVE: Record<string, { file?: string; source: string }> = {
  tenant: { source: `<p>Gilt für den ganzen Tenant.</p>` },
  "code-value": { source: `<p>Nur für SHIFT_BASED-Verträge.</p>` },
  "danger-zone": { source: `<h2>Danger Zone</h2>` },
  coverage: { source: `<span>Coverage 1.00</span>` },
  sigma: { source: `<span>Σ 40 h</span>` },
  korrelation: { source: `<p>Soll-Korrelation für die Woche</p>` },
  entitaet: { source: `<label>Nach Entität filtern</label>` },
  schedule: { source: `<p>Alle Schedule-Versionen anzeigen</p>` },
  inbox: { source: `<h1>Inbox</h1>` },
  ma: { source: `<p>Für alle MA dieses Salons.</p>` },
  mandant: { source: `<p>Einstellungen des Mandanten</p>` },
  phorest: { file: LEAVE_COMPONENT, source: `<a href="/x">In Phorest öffnen</a>` },
  "sie-form": { source: `<p>Bitte prüfen Sie die Angaben.</p>` },
};

describe("lint-ui-terms: every forbidden term is detected", () => {
  it("has a positive fixture for every FORBIDDEN_TERMS id", () => {
    const ids = (FORBIDDEN_TERMS as { id: string }[]).map((t) => t.id).sort();
    expect(Object.keys(POSITIVE).sort()).toEqual(ids);
  });

  for (const [id, fixture] of Object.entries(POSITIVE)) {
    it(`reports ${id}`, () => {
      expect(termsOf(fixture.file ?? ROUTE, fixture.source)).toContain(id);
    });
  }
});

describe("lint-ui-terms: every shown-text shape is read", () => {
  it("a placeholder attribute", () => {
    expect(termsOf(ROUTE, `<input placeholder="Geben Sie Ihre E-Mail ein" />`)).toContain(
      "sie-form",
    );
  });
  it("a string inside a markup expression", () => {
    expect(termsOf(ROUTE, `<p>{ok ? "Alles gut" : "Tenant fehlt hier"}</p>`)).toContain("tenant");
  });
  it("a prose literal in a svelte script", () => {
    const source = `<script lang="ts">\n  const msg = "Bitte versuchen Sie es erneut.";\n</script>\n<p>{msg}</p>`;
    const findings = scanSource(ROUTE, source) as Finding[];
    expect(findings.map((f) => f.term)).toContain("sie-form");
    expect(findings.find((f) => f.term === "sie-form")?.line).toBe(2);
  });
  it("a prose literal and a template literal in a .ts module", () => {
    expect(termsOf(MODULE, `export const a = "Gilt für den Tenant";`)).toContain("tenant");
    expect(termsOf(MODULE, "export const b = (n: number) => `Σ ${n} Stunden gesamt`;")).toContain(
      "sigma",
    );
  });
  it("a capitalized single-word label in a .ts module", () => {
    expect(termsOf(MODULE, `export const NAV = [{ href: "/inbox", label: "Inbox" }];`)).toContain(
      "inbox",
    );
  });
});

describe("lint-ui-terms: what is never shown is never read", () => {
  const negatives: Array<[string, string, string]> = [
    ["an HTML comment", ROUTE, `<!-- Tenant, Sie, SHIFT_BASED --><p>Hallo</p>`],
    ["a // comment", MODULE, `// Sie sehen hier den Tenant\nexport const x = 1;`],
    ["a class attribute", ROUTE, `<div class="tenant-card danger zone">Hallo</div>`],
    ["an href attribute", ROUTE, `<a href="/inbox">Aufgaben</a>`],
    ["a value attribute", ROUTE, `<option value="SHIFT_BASED">Nach Schichtplan</option>`],
    ["an icon attribute", ROUTE, `<EmptyState icon="inbox" title="Nichts offen" />`],
    ["a data-* attribute", ROUTE, `<div data-testid="Tenant Danger Zone">Hallo</div>`],
    ["an aria-describedby attribute", ROUTE, `<p aria-describedby="phorest-hint inbox">Hallo</p>`],
    ["an import specifier", MODULE, `import { x } from "$lib/Tenant Inbox";\nexport const y = x;`],
    ["a console argument", MODULE, `console.warn("Tenant fehlt, bitte prüfen Sie das");`],
    [
      "an UPPER_SNAKE control value",
      MODULE,
      `export const isShift = (t: string) => t === "SHIFT_BASED";`,
    ],
    ["a string in a type position", MODULE, `export type Mode = "Danger Zone" | "Tenant Sie";`],
  ];
  for (const [label, file, source] of negatives) {
    it(`ignores ${label}`, () => {
      expect(scanSource(file, source)).toEqual([]);
    });
  }
});

describe("lint-ui-terms: area scoping", () => {
  const phorest = `<p>Abgleich mit Phorest läuft.</p>`;
  const mandant = `<p>Mandantennummer eintragen</p>`;
  it("allows Phorest in an admin route", () => {
    expect(termsOf("src/routes/(app)/admin/phorest/+page.svelte", phorest)).toEqual([]);
  });
  it("reports Phorest in a component Mitarbeitende see", () => {
    expect(termsOf(LEAVE_COMPONENT, phorest)).toContain("phorest");
  });
  it("reports Phorest in lib/phorest (shown in the leave-request flow)", () => {
    expect(termsOf("src/lib/phorest/CollisionWarnBody.svelte", phorest)).toContain("phorest");
  });
  it("allows Mandant in the operator console", () => {
    expect(termsOf("src/routes/(operator)/betreiber/+page.svelte", mandant)).toEqual([]);
  });
  it("allows Mandant on the DATEV export page", () => {
    expect(termsOf("src/routes/(app)/admin/export/+page.svelte", mandant)).toEqual([]);
  });
  it("reports Mandant in any other admin route", () => {
    expect(termsOf("src/routes/(app)/admin/system/+page.svelte", mandant)).toContain("mandant");
  });
});

describe("lint-ui-terms: fail closed", () => {
  it("reports a file that cannot be parsed", () => {
    expect(termsOf(ROUTE, `<div>{#if open}<p>unclosed</div>`)).toContain("parse-error");
  });
  it("has no exception register (D-574-02)", () => {
    expect(ALLOWED).toEqual([]);
  });
  it("walks the real tree (floor)", () => {
    const files = (listScannedFiles() as string[]).map((f) => f.split("\\").join("/"));
    expect(files.length).toBeGreaterThanOrEqual(300);
    expect(files.some((f) => f.endsWith("src/routes/(app)/dashboard/+page.svelte"))).toBe(true);
    expect(files.some((f) => f.endsWith("src/lib/nav/app-nav.ts"))).toBe(true);
  });
  it("finds no forbidden term in the real tree (AC-574-2)", () => {
    const findings = (scan() as Finding[]).map((f) => `${f.file}:${f.line} [${f.term}] ${f.text}`);
    expect(findings).toEqual([]);
  });
});
