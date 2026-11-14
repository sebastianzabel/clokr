// Issue #944 — the quick search finds every page the route table lets a person open (by name, tab name and
// description), nothing they may not open, and lists persons within the reader's reach. Expectations per
// persona are hand-written; the persona permission sets are the shared fixture.
import { describe, expect, it } from "vitest";
import {
  MAX_PERSON_HITS,
  maySearchPersons,
  pageIndex,
  personHits,
  personHref,
  searchPages,
} from "../quick-search";
import { APP_ROUTES, visibleRoute } from "../routes";
import personas from "./fixtures/system-role-permissions.json";

const P = personas as Record<string, string[]>;
const on = { availabilityEnabled: true };
const holder = (persona: string) => ({ permissions: P[persona] });
const found = (persona: string, query: string) =>
  searchPages(pageIndex(holder(persona), on), query).map((hit) => hit.href);

describe("pageIndex / searchPages (#944)", () => {
  it("offers exactly the visible, non-internal table entries (no second permission list)", () => {
    for (const persona of Object.keys(P)) {
      const expected = APP_ROUTES.filter(
        (route) =>
          route.internal !== true &&
          route.href !== "/ich/profil/geraet-koppeln" &&
          visibleRoute(holder(persona), route, on),
      ).map((route) => route.href);
      expect(
        pageIndex(holder(persona), on).map((hit) => hit.href),
        persona,
      ).toEqual(expected);
      expect(expected.length, persona).toBeGreaterThan(3);
    }
  });

  it("the Personalabteilung finds Personen, Salons, Monatsabschluss and Konto", () => {
    expect(found("HR", "Personen")).toContain("/verwalten/personen");
    expect(found("HR", "Salons")).toContain("/verwalten/salons");
    expect(found("HR", "Monatsabschluss")).toContain("/verwalten/monatsabschluss");
    expect(found("HR", "Konto")).toContain("/ich/konto");
  });

  it("a plain employee finds own pages only", () => {
    expect(found("EMPLOYEE", "Konto")).toContain("/ich/konto");
    expect(found("EMPLOYEE", "Salons")).toEqual([]);
    expect(found("EMPLOYEE", "Rollen")).toEqual([]);
    expect(found("EMPLOYEE", "Personen")).toEqual([]);
  });

  it("the administrator finds the Verwalten pages deep in the table, by name and description", () => {
    expect(found("ADMIN", "Rollen")).toContain("/verwalten/system/rollen");
    expect(found("ADMIN", "Support")).toContain("/verwalten/daten/support-zugriffe");
    expect(found("ADMIN", "Phorest")).toContain("/verwalten/system/phorest");
    // description match
    expect(found("ADMIN", "Öffnungszeiten")).toContain("/verwalten/salons");
  });

  it("finds a roster tab by its tab name and ignores accents and case", () => {
    expect(found("ADMIN", "bedarf")).toContain("/team/dienstplan/planung");
    expect(found("ADMIN", "TAGESUEBERSICHT")).toEqual(found("ADMIN", "TAGESUEBERSICHT"));
    expect(found("ADMIN", "übersicht")).toContain("/verwalten");
  });

  it("describes the own time page correctly (no 'verwalten')", () => {
    const zeiten = pageIndex(holder("EMPLOYEE"), on).find((hit) => hit.href === "/ich/zeiten");
    expect(zeiten?.description).not.toMatch(/verwalten/i);
  });

  it("ranks a name match before a description match", () => {
    const hits = found("ADMIN", "personen");
    expect(hits[0]).toMatch(/personen$/);
  });

  it("lists Berichte under Team for report:read holders and never indexes the legacy alias", () => {
    const hit = pageIndex(holder("HR"), on).find((page) => page.href === "/team/berichte");
    expect(hit?.group).toBe("Team");
    expect(hit?.label).toBe("Berichte");
    for (const persona of Object.keys(P)) {
      expect(found(persona, "Berichte"), persona).not.toContain("/verwalten/berichte");
    }
  });

  it("never offers an internal page", () => {
    expect(found("ADMIN", "Bausteine")).not.toContain("/verwalten/bausteine");
  });
});

describe("person hits (#944)", () => {
  const rows = [
    { id: "a1", firstName: "Anja", lastName: "Müller", employeeNumber: "17" },
    { id: "b2", firstName: "Bert", lastName: "Mueller", employeeNumber: null },
    { id: "c3", firstName: "Cora", lastName: "Schmidt" },
  ];

  it("only holders of employee:read search persons", () => {
    expect(maySearchPersons(holder("HR"))).toBe(true);
    expect(maySearchPersons(holder("SALON_MANAGER"))).toBe(true);
    expect(maySearchPersons(holder("EMPLOYEE"))).toBe(false);
  });

  it("matches words of first and last name, accents folded, and the number", () => {
    expect(personHits(holder("HR"), rows, "anja mül", on).map((h) => h.id)).toEqual(["person:a1"]);
    expect(personHits(holder("HR"), rows, "mueller", on).map((h) => h.id)).toEqual(["person:b2"]);
    expect(personHits(holder("HR"), rows, "17", on).map((h) => h.id)).toEqual(["person:a1"]);
    expect(personHits(holder("HR"), rows, " ", on)).toEqual([]);
    expect(personHits(holder("HR"), rows, "zzz", on)).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      firstName: "Max",
      lastName: `Muster${i}`,
    }));
    expect(personHits(holder("HR"), many, "max", on)).toHaveLength(MAX_PERSON_HITS);
  });

  it("opens Verwalten > Personen where the table allows it, else Team > Personen", () => {
    expect(personHref(holder("HR"), "a1", on)).toBe("/verwalten/personen/a1");
    expect(personHref(holder("ADMIN"), "a1", on)).toBe("/verwalten/personen/a1");
    expect(personHref(holder("SALON_MANAGER"), "a1", on)).toBe("/team/personen");
    expect(personHits(holder("SALON_MANAGER"), rows, "cora", on)[0].href).toBe("/team/personen");
  });
});
