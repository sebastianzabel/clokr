// Issue #854 (D-854-03) — the settings registry `lib/settings/settings-pages.ts` against the sources.
//
// The registry pins every writable tenant setting to ONE section of ONE page. This test reads the registry,
// the web files that send a settings PUT and the Zod schemas of the API (as text, like
// permission-labels-one-place-83.test.ts) and fails on:
//   - a key in two sections                                  (a setting living at two places)
//   - a key the API schema of its endpoint does not declare  (Zod strips it: the save returns 200 and nothing
//                                                             persists — `vocationalSchoolAutoCleanupShifts`,
//                                                             D-854-20)
//   - a save that sends a field its section does not own, a spread, or an unregistered save   (#878)
//   - a section whose rendering file is not its page, or a stale rendering file
//   - a section gate that differs from the pre-#844 page it came from, a page gate that is not the union of its
//     sections                                                                             (D-854-05)
// The extractors have controls below: a checker that cannot fail proves nothing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { APP_ROUTES } from "$lib/nav/routes";
import {
  SETTINGS_SECTIONS,
  mayOpenSection,
  pageAlternatives,
  sectionsOfPage,
  settingsSection,
  type SettingsSection,
} from "$lib/settings/settings-pages";
import pre844 from "$lib/nav/__tests__/fixtures/pre-844-route-permissions.json";

import { SRC_ROOT, walkFiles, type SourceFile } from "./design-source-files";

// ── text scanning ────────────────────────────────────────────────────────────────────────────────

/** If a string or comment starts at `i`, the index after it; else `i`. */
function skipNonCode(text: string, i: number): number {
  const c = text[i];
  if (c === "/" && text[i + 1] === "/") {
    const nl = text.indexOf("\n", i);
    return nl === -1 ? text.length : nl;
  }
  if (c === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === c) return j + 1;
      else if (c === "`" && text[j] === "$" && text[j + 1] === "{") j = findClose(text, j + 1);
    }
    return text.length;
  }
  return i;
}

/** Index of the bracket closing the one at `open`. */
function findClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i]) && --depth === 0) return i;
  }
  throw new Error("unbalanced brackets");
}

/** `text` split on commas at bracket depth 0; comments dropped, strings kept, empty segments removed. */
function topLevelSegments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      const piece = text.slice(i, skipped);
      if (!piece.startsWith("//") && !piece.startsWith("/*")) current += piece;
      i = skipped - 1;
      continue;
    }
    const c = text[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

const KEY = /^(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?::|$)/;

/** The text of the `{ … }` that follows the declaration `const <name> =` in `source`. */
function declaredObjectBody(source: string, name: string): string {
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\b[^=\\n]*=`).exec(source);
  if (decl === null) throw new Error(`no declaration of ${name}`);
  const open = source.indexOf("{", decl.index + decl[0].length);
  return source.slice(open + 1, findClose(source, open));
}

/** Top-level keys of the Zod object (or shape) declared as `const <name>` in `source`, spreads of shapes
 *  declared in the same file included. */
export function zodKeys(source: string, name: string): string[] {
  const keys: string[] = [];
  for (const segment of topLevelSegments(declaredObjectBody(source, name))) {
    const spread = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(segment);
    if (spread !== null) {
      keys.push(...zodKeys(source, spread[1]));
      continue;
    }
    const key = KEY.exec(segment);
    if (key !== null) keys.push(key[1] ?? key[2]);
  }
  return keys;
}

interface Payload {
  keys: string[];
  computed: boolean;
  spread: boolean;
}

/** Keys of an object literal `{ … }`. A conditional spread `...(cond ? { a } : {})` contributes its keys;
 *  any other spread is reported (the #878 rule: a save sends only its own fields). */
export function objectPayload(literal: string): Payload {
  const payload: Payload = { keys: [], computed: false, spread: false };
  for (const segment of topLevelSegments(literal.trim().slice(1, -1))) {
    if (segment.startsWith("...")) {
      const conditional = /^\.\.\.\(\s*[^?]*\?\s*(\{[\s\S]*\})\s*:\s*\{\s*\}\s*\)$/.exec(segment);
      if (conditional === null) {
        payload.spread = true;
        continue;
      }
      const inner = objectPayload(conditional[1]);
      payload.keys.push(...inner.keys);
      payload.computed ||= inner.computed;
      payload.spread ||= inner.spread;
    } else if (segment.startsWith("[")) {
      payload.computed = true;
    } else {
      const key = KEY.exec(segment);
      if (key !== null) payload.keys.push(key[1] ?? key[2]);
    }
  }
  return payload;
}

interface WebPut {
  file: string;
  endpoint: string;
  keys: string[];
  computed: boolean;
  spread: boolean;
  /** Set when the body is `pickSection(…, settingsSection("<id>").keys)`. */
  sectionId?: string;
  /** The body is neither an object literal, a resolvable local object nor a `pickSection` call. */
  unresolved: boolean;
}

const ENDPOINTS = [
  "/settings/work",
  "/settings/security",
  "/settings/smtp",
  "/integrations/phorest/config",
];

/** Every `api.put("<settings endpoint>", …)` of a file with the keys of its body. */
export function settingsPuts(file: { rel: string; text: string }): WebPut[] {
  const puts: WebPut[] = [];
  for (const match of file.text.matchAll(/\bapi\s*\.\s*put\s*(?:<[^()]*>)?\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const [pathArg, bodyArg] = topLevelSegments(
      file.text.slice(open + 1, findClose(file.text, open)),
    );
    const endpoint = /^"([^"]+)"$/.exec(pathArg ?? "")?.[1];
    if (endpoint === undefined || !ENDPOINTS.includes(endpoint)) continue;
    const put: WebPut = {
      file: file.rel,
      endpoint,
      keys: [],
      computed: false,
      spread: false,
      unresolved: false,
    };
    const body = (bodyArg ?? "").trim();
    const picked = /settingsSection\(\s*"([^"]+)"\s*\)\.keys/.exec(body);
    if (body.startsWith("{")) {
      Object.assign(put, objectPayload(body));
    } else if (body.startsWith("pickSection(") && picked !== null) {
      put.sectionId = picked[1];
    } else if (/^[A-Za-z_$][\w$]*$/.test(body)) {
      // A local object built before the call: `const body = { … }` plus `body.key = …` additions.
      const before = file.text.slice(0, match.index);
      const decl = [
        ...before.matchAll(new RegExp(`(?:const|let)\\s+${body}\\b[^=\\n]*=\\s*\\{`, "g")),
      ].at(-1);
      if (decl === undefined) {
        put.unresolved = true;
      } else {
        const literalOpen = (decl.index ?? 0) + decl[0].length - 1;
        Object.assign(
          put,
          objectPayload(before.slice(literalOpen, findClose(before, literalOpen) + 1)),
        );
        const added = before.slice(literalOpen);
        for (const m of added.matchAll(
          new RegExp(`\\b${body}\\.([A-Za-z_$][\\w$]*)\\s*=(?!=)`, "g"),
        ))
          put.keys.push(m[1]);
      }
    } else {
      put.unresolved = true;
    }
    puts.push(put);
  }
  return puts;
}

// ── sources ─────────────────────────────────────────────────────────────────────────────────────

const API_SRC = join(SRC_ROOT, "..", "..", "api", "src", "contexts");
const SETTINGS_API = readFileSync(join(API_SRC, "platform", "api", "settings.ts"), "utf8");
const PHOREST_API = readFileSync(join(API_SRC, "scheduling", "api", "integrations.ts"), "utf8");

const SCHEMAS: Record<string, { source: string; name: string }> = {
  "/settings/work": { source: SETTINGS_API, name: "tenantConfigSchema" },
  "/settings/security": { source: SETTINGS_API, name: "securitySettingsSchema" },
  "/settings/smtp": { source: SETTINGS_API, name: "smtpSchema" },
  "/integrations/phorest/config": { source: PHOREST_API, name: "configSchema" },
};

const SCANNED_PREFIXES = [
  "routes/(app)/admin/",
  "routes/(app)/verwalten/",
  "lib/components/admin/",
  "lib/components/employees/",
];
const scannedFiles: SourceFile[] = walkFiles(SRC_ROOT, [".svelte", ".ts"], {
  includeTests: false,
}).filter((f) => SCANNED_PREFIXES.some((prefix) => f.rel.startsWith(prefix)));
const allPuts = scannedFiles.flatMap(settingsPuts);

const PINNED = { ...pre844.admin, ...pre844.team } as Record<string, string[][]>;

/** The route file of the page that shows a section (`file ?? href` of the route table). */
function pageFile(section: SettingsSection): string {
  const route = APP_ROUTES.find((entry) => entry.href === section.page);
  if (route === undefined)
    throw new Error(`${section.id}: ${section.page} is not in the route table`);
  return `routes/(app)${route.file ?? route.href}/+page.svelte`;
}

/** Every problem of `sections` against the Zod schemas, the web files and the pinned permissions. */
export function registryProblems(sections: readonly SettingsSection[]): string[] {
  const problems: string[] = [];

  // (1) one place per key
  const owners = new Map<string, string[]>();
  for (const section of sections)
    for (const key of section.keys) owners.set(key, [...(owners.get(key) ?? []), section.id]);
  for (const [key, ids] of owners)
    if (ids.length > 1) problems.push(`${key}: in ${ids.length} sections (${ids.join(", ")})`);

  // (2) every key is accepted by the API schema of its endpoint
  const accepted = new Map<string, Set<string>>();
  for (const section of sections) {
    if (section.endpoint === null) continue;
    const schema = SCHEMAS[section.endpoint];
    if (schema === undefined) {
      problems.push(`${section.id}: no schema known for ${section.endpoint}`);
      continue;
    }
    if (!accepted.has(section.endpoint))
      accepted.set(section.endpoint, new Set(zodKeys(schema.source, schema.name)));
    for (const key of section.keys)
      if (!accepted.get(section.endpoint)!.has(key))
        problems.push(
          `${section.id}: ${key} is not a key of ${schema.name} (the API would strip it)`,
        );
  }

  // (3) every settings save of the scanned web files sends its own section's keys only; every section key is sent
  const sent = new Map<string, Set<string>>(); // `${file}::${endpoint}` -> keys the saves of that file send
  for (const put of allPuts) {
    const candidates = sections.filter(
      (s) => s.renderedBy === put.file && s.endpoint === put.endpoint,
    );
    const where = `${put.file} PUT ${put.endpoint}`;
    if (candidates.length === 0) {
      problems.push(`${where}: no registered section`);
      continue;
    }
    const covered = sent.get(`${put.file}::${put.endpoint}`) ?? new Set<string>();
    sent.set(`${put.file}::${put.endpoint}`, covered);
    if (put.sectionId !== undefined) {
      const section = sections.find((s) => s.id === put.sectionId);
      if (section === undefined || section.renderedBy !== put.file)
        problems.push(`${where}: pickSection names ${put.sectionId}, not a section of this file`);
      else section.keys.forEach((k) => covered.add(k));
      continue;
    }
    if (put.unresolved) {
      problems.push(`${where}: the body is not an object literal the scan can read`);
      continue;
    }
    if (put.spread) {
      problems.push(`${where}: spread in the body (a save sends only its own fields, #878)`);
      continue;
    }
    if (put.computed) {
      const dynamic = candidates.filter((s) => s.dynamicPayload === true);
      const text = scannedFiles.find((f) => f.rel === put.file)!.text;
      if (dynamic.length === 0)
        problems.push(`${where}: computed key without a dynamicPayload section`);
      for (const section of dynamic)
        for (const key of section.keys) {
          if (new RegExp(`\\b${key}\\b`).test(text)) covered.add(key);
        }
    }
    put.keys.forEach((k) => covered.add(k));
    if (put.keys.length > 0 && !candidates.some((s) => put.keys.every((k) => s.keys.includes(k))))
      problems.push(
        `${where}: sends ${put.keys.join(", ")} — not the keys of one registered section of this file`,
      );
  }
  for (const section of sections) {
    if (section.endpoint === null) continue;
    const covered = sent.get(`${section.renderedBy}::${section.endpoint}`) ?? new Set<string>();
    for (const key of section.keys)
      if (!covered.has(key))
        problems.push(`${section.id}: ${key} is not sent by ${section.renderedBy}`);
  }

  // (4) the rendering file is the page's route file or imported by it
  for (const section of sections) {
    const file = scannedFiles.find((f) => f.rel === section.renderedBy);
    if (file === undefined) {
      problems.push(`${section.id}: renderedBy ${section.renderedBy} does not exist`);
      continue;
    }
    const page = pageFile(section);
    if (section.renderedBy === page) continue;
    const pageSource = walkFiles(SRC_ROOT, [".svelte"], { includeTests: false }).find(
      (f) => f.rel === page,
    );
    const base = section.renderedBy
      .split("/")
      .at(-1)!
      .replace(/\.(svelte|ts)$/, "");
    if (pageSource === undefined || !pageSource.text.includes(base))
      problems.push(`${section.id}: ${section.renderedBy} is neither ${page} nor imported by it`);
  }

  // (5) a section opens under the pinned pre-#844 alternatives of its source page
  for (const section of sections) {
    if (JSON.stringify(section.requires) !== JSON.stringify(PINNED[section.source] ?? null))
      problems.push(
        `${section.id}: requires differ from the pinned alternatives of ${section.source}`,
      );
  }
  return problems;
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────────

describe("settings registry against the sources (#854, D-854-03)", () => {
  it("has no problem: one place per key, keys accepted by the API, own fields only, sound gates", () => {
    expect(registryProblems(SETTINGS_SECTIONS)).toEqual([]);
  });

  it("every page with sections opens under exactly the union of its sections (D-854-05)", () => {
    const pages = [...new Set(SETTINGS_SECTIONS.map((s) => s.page))];
    expect(pages.length).toBeGreaterThanOrEqual(5);
    for (const page of pages) {
      const route = APP_ROUTES.find((entry) => entry.href === page);
      expect(route, page).toBeDefined();
      expect(route!.requires, page).toEqual(pageAlternatives(page));
    }
  });

  it("a section id is unique and every section names a page of the route table", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of SETTINGS_SECTIONS)
      expect(
        APP_ROUTES.some((route) => route.href === section.page),
        section.id,
      ).toBe(true);
  });

  it("is not vacuous: at least 20 sections, 90 keys and 5 files with a settings save", () => {
    expect(SETTINGS_SECTIONS.length).toBeGreaterThanOrEqual(20);
    expect(SETTINGS_SECTIONS.flatMap((s) => s.keys).length).toBeGreaterThanOrEqual(90);
    expect(new Set(allPuts.map((p) => p.file)).size).toBeGreaterThanOrEqual(5);
    expect(scannedFiles.length).toBeGreaterThan(50);
  });

  it("the toggle that used to be stripped (D-854-20) is declared by the schema and registered once", () => {
    expect(zodKeys(SETTINGS_API, "tenantConfigSchema")).toContain(
      "vocationalSchoolAutoCleanupShifts",
    );
    expect(
      SETTINGS_SECTIONS.filter((s) => s.keys.includes("vocationalSchoolAutoCleanupShifts")).map(
        (s) => s.id,
      ),
    ).toEqual(["dienstplan-berufsschule"]);
  });
});

describe("registry helpers", () => {
  it("settingsSection throws on an unknown id and sectionsOfPage lists a page in registry order", () => {
    expect(() => settingsSection("nope")).toThrow(/Unknown settings section/);
    expect(settingsSection("system-company").keys).toEqual([
      "tenantName",
      "federalState",
      "timezone",
    ]);
    const ids = sectionsOfPage("/verwalten/system/allgemein").map((s) => s.id);
    expect(ids[0]).toBe("system-company");
    expect(ids).toContain("system-api-keys");
    expect(sectionsOfPage("/nowhere")).toEqual([]);
    expect(pageAlternatives("/nowhere")).toEqual([]);
  });

  it("a page deduplicates the alternatives of its sections", () => {
    expect(pageAlternatives("/verwalten/regeln/abwesenheiten")).toEqual([
      ["tenant-settings:update:ZUGEWIESEN"],
      ["leave-config:manage:ZUGEWIESEN"],
    ]);
  });

  it("mayOpenSection follows the section's own alternatives", () => {
    const smtp = settingsSection("benachrichtigungen-smtp");
    expect(mayOpenSection({ permissions: ["terminal:manage:ZUGEWIESEN"] }, smtp)).toBe(true);
    expect(mayOpenSection({ permissions: ["report:read:ZUGEWIESEN"] }, smtp)).toBe(false);
    expect(mayOpenSection(null, smtp)).toBe(false);
    const datev = settingsSection("export-datev");
    expect(mayOpenSection({ permissions: ["tenant-settings:update:ZUGEWIESEN"] }, datev)).toBe(
      false,
    );
  });
});

describe("the checker can fail (controls)", () => {
  const base = (): SettingsSection[] => structuredClone([...SETTINGS_SECTIONS]);
  const edited = (id: string, patch: Partial<SettingsSection>): SettingsSection[] =>
    base().map((s) => (s.id === id ? { ...s, ...patch } : s));

  it("reports a key in two sections", () => {
    const sections = edited("arbeitszeit-rueckwirkend", {
      keys: ["retroEntryWindowDays", "closeMonthWithGapsAllowed"],
    });
    expect(
      registryProblems(sections).some((p) => p.startsWith("closeMonthWithGapsAllowed: in 2")),
    ).toBe(true);
  });

  it("reports a key the API schema would strip", () => {
    const sections = edited("dienstplan-berufsschule", {
      keys: ["vocationalSchoolAutoCleanupShifts", "vocationalSchoolAutoCleanupShiftsX"],
    });
    expect(
      registryProblems(sections).some((p) =>
        p.includes("vocationalSchoolAutoCleanupShiftsX is not a key of tenantConfigSchema"),
      ),
    ).toBe(true);
  });

  it("reports a save that sends a key of another section", () => {
    // saveRetention sends dataRetentionYears; moving that key elsewhere leaves the save without a home
    const sections = base().map((s) =>
      s.id === "audit-retention"
        ? { ...s, keys: [] }
        : s.id === "export-datev"
          ? { ...s, keys: [...s.keys, "dataRetentionYears"] }
          : s,
    );
    expect(registryProblems(sections).some((p) => p.includes("sends dataRetentionYears"))).toBe(
      true,
    );
  });

  it("reports a registry key that no save sends", () => {
    const sections = edited("audit-retention", {
      keys: ["dataRetentionYears", "dataRetentionDays"],
    });
    // a key the schema declares but nobody sends: borrow a real schema key
    const real = edited("audit-retention", {
      keys: ["dataRetentionYears", "reminderOffsetMinutes"],
    });
    expect(registryProblems(sections).some((p) => p.includes("dataRetentionDays"))).toBe(true);
    expect(
      registryProblems(real).some((p) => p.includes("reminderOffsetMinutes is not sent by")),
    ).toBe(true);
  });

  it("reports a stale rendering file and a gate that differs from the source page", () => {
    const stale = edited("audit-retention", { renderedBy: "routes/(app)/admin/gone/+page.svelte" });
    expect(registryProblems(stale).some((p) => p.includes("does not exist"))).toBe(true);
    const widened = edited("export-datev", { requires: [["tenant-settings:read:ZUGEWIESEN"]] });
    expect(registryProblems(widened).some((p) => p.includes("requires differ"))).toBe(true);
  });

  it("a save without a registered section is reported", () => {
    const sections = base().filter((s) => s.id !== "audit-retention");
    expect(registryProblems(sections).some((p) => p.includes("no registered section"))).toBe(true);
  });
});

describe("the extractors read what they claim to", () => {
  it("zodKeys follows spreads of shapes and ignores nested objects and comments", () => {
    const source = `
      const shape = { a: z.number().optional(), // note, with a comma
        b: z.array(z.object({ nested: z.string() })).optional() };
      const schema = z.object({
        c: z.string().regex(/^\\d{2}:\\d{2}$/, "Format, HH:MM"),
        ...shape,
        /* d: removed */
        e: z.boolean(),
      });`;
    expect(zodKeys(source, "schema")).toEqual(["c", "a", "b", "e"]);
  });

  it("objectPayload reads shorthand, a computed key, a conditional spread and a foreign spread", () => {
    expect(objectPayload("{ a, b: f(1, 2), ...(x ? { c: 1 } : {}) }")).toEqual({
      keys: ["a", "b", "c"],
      computed: false,
      spread: false,
    });
    expect(objectPayload("{ [flag]: next }")).toMatchObject({ computed: true, keys: [] });
    expect(objectPayload("{ a, ...other }")).toMatchObject({ spread: true, keys: ["a"] });
  });

  it("settingsPuts finds the endpoint, resolves a local body and a pickSection call, skips other endpoints", () => {
    const text = `
      await api.put("/settings/work", { x: 1, y });
      await api.put<Foo>("/settings/security", { [flag]: next });
      await api.put("/other", { z: 1 });
      const body: Record<string, unknown> = { p, q };
      if (r) body.r = r;
      await api.put("/settings/smtp", body);
      await api.put("/settings/work", pickSection(draft, settingsSection("system-company").keys));
      await api.put(\`/settings/work/\${id}\`, { s: 1 });`;
    const puts = settingsPuts({ rel: "x.svelte", text });
    expect(puts.map((p) => p.endpoint)).toEqual([
      "/settings/work",
      "/settings/security",
      "/settings/smtp",
      "/settings/work",
    ]);
    expect(puts[0].keys).toEqual(["x", "y"]);
    expect(puts[1].computed).toBe(true);
    expect(puts[2].keys).toEqual(["p", "q", "r"]);
    expect(puts[3].sectionId).toBe("system-company");
  });
});
