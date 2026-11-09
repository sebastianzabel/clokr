/**
 * Issue #861 — fixture test for `lint-api-terms.ts`, the API sibling of `lint:ui-terms`.
 *
 * Every shape the gate must flag and every shape it must leave alone is driven against fixture
 * TEXT through the pure `scanSource(file, source)` — on a clean tree the gate reports nothing, and
 * "nothing found" proves nothing about a detector. A live-tree suite at the bottom pins that the
 * real walk is non-empty and the real tree is clean.
 *
 * DB-free, disk-write-free.
 */
import { describe, expect, it } from "vitest";
import { FORBIDDEN_TERMS as WEB_TERMS } from "../../../web/scripts/lint-ui-terms.mjs";
import {
  FORBIDDEN_TERMS,
  isGermanProse,
  listScannedFiles,
  scan,
  scanSource,
} from "../lint-api-terms";

const FILE = "src/contexts/platform/api/example.ts";
const terms = (source: string, file = FILE) => scanSource(file, source).map((f) => f.term);

describe("lint:api-terms — the term list", () => {
  it("is the web gate's list plus the API-only permission-key term, never a copy", () => {
    expect(FORBIDDEN_TERMS.map((t) => t.id)).toEqual([
      ...WEB_TERMS.map((t) => t.id),
      "permission-key",
    ]);
    for (const web of WEB_TERMS.filter((t) => t.id !== "mandant")) {
      expect(FORBIDDEN_TERMS.find((t) => t.id === web.id)?.re).toBe(web.re);
    }
  });
});

describe("lint:api-terms — what is a German text", () => {
  it.each([
    "Bitte versuch es noch einmal.",
    "Mandanteneinstellungen lesen",
    "Mandanteneinstellungen",
    "Übersicht",
  ])("reads %j", (text) => expect(isGermanProse(text)).toBe(true));

  it.each([
    "employee not found in tenant",
    "An operational Schichtplanung conflict for managers",
    "Tenant",
    "tenantId",
    "SHIFT_BASED",
  ])("leaves %j alone", (text) => expect(isGermanProse(text)).toBe(false));
});

describe("lint:api-terms — flagged shapes", () => {
  it("flags the Sie-form in an error message, a notification and a template", () => {
    expect(
      terms(`reply.code(403).send({ error: "Bitte wenden Sie sich an die Administration." });`),
    ).toEqual(["sie-form"]);
    expect(terms("const m = `Ihr Urlaub vom ${a} bis ${b} wurde genehmigt.`;")).toEqual([
      "sie-form",
    ]);
    expect(terms('const MSG = "Eine Ihnen zugewiesene Rolle";')).toEqual(["sie-form"]);
  });

  it("flags Mandant, an enum value and a permission key in a German text", () => {
    expect(terms('const e = "Der Mandant hat mehrere aktive Salons.";')).toEqual(["mandant"]);
    expect(
      terms('const e = "Mitarbeiter ist nicht im Schichtsystem (SHIFT_BASED erforderlich).";'),
    ).toEqual(["code-value"]);
    expect(terms('const e = "Dafür fehlt die Berechtigung role-assignment:manage.";')).toEqual([
      "permission-key",
    ]);
  });

  it("flags a one-word German label", () => {
    expect(terms('const LABELS = { "tenant-settings": "Mandanteneinstellungen" };')).toEqual([
      "mandant",
    ]);
  });
});

describe("lint:api-terms — tolerated shapes", () => {
  it("never reads Swagger description/summary, log calls, raw SQL or comments", () => {
    expect(
      terms(
        'const s = { description: "Bitte geben Sie den Mandanten an.", summary: "Ihr Konto" };',
      ),
    ).toEqual([]);
    expect(terms('app.log.warn({ id }, "Sie wurden abgemeldet, der Mandant fehlt");')).toEqual([]);
    expect(terms('console.error("Ihr Fehler");')).toEqual([]);
    expect(terms('await db.$queryRaw`SELECT "tenantId" FROM "Employee" WHERE die = 1`;')).toEqual(
      [],
    );
    expect(terms("// Bitte wenden Sie sich an den Mandanten\nconst x = 1;")).toEqual([]);
  });

  it("reads no HTML attribute of an e-mail template", () => {
    expect(
      terms('const html = `<p style="font-family:sans-serif">Hallo ${n}, dein Code lautet:</p>`;'),
    ).toEqual([]);
  });

  it("keeps DATEV's own field name „Mandantennummer“", () => {
    expect(terms('const e = "Berater- und Mandantennummer sind nicht hinterlegt.";')).toEqual([]);
  });

  it("allows „Mandant“ in operator-console texts and „Phorest“ in Schichtplanung", () => {
    const text = 'const e = "Der Mandant hat mehrere Phorest-Kopplungen.";';
    expect(terms(text, "src/contexts/platform/api/operator/tenants.ts")).toEqual([]);
    expect(terms(text, "src/contexts/scheduling/api/integrations.ts")).toEqual(["mandant"]);
    expect(terms(text, "src/contexts/time-tracking/api/time-entries.ts")).toEqual([
      "mandant",
      "phorest",
    ]);
  });
});

describe("lint:api-terms — live tree", () => {
  it("walks a non-empty set of API source files and no test file", () => {
    const files = listScannedFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => /__tests__|\.test\.ts$/.test(f))).toBe(false);
  });

  it("finds no forbidden term in the real tree", () => {
    expect(scan()).toEqual([]);
  });
});
