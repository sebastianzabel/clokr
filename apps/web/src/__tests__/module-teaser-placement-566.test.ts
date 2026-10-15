// Phase 566 (D-12, AC-566-06) — the module hint is shown only where a feature is SET UP, never in
// clock, calendar or dashboard views, and never as a popup. Source-read pins (a route page cannot
// be mounted, see admin-system-save-wiring.test.ts for the precedent).
//
// (a)/(b): the NFC-Terminals section of /admin/system holds exactly one hint for HARDWARE_CLOCK and
// still holds its create markup (the hint replaces the row at runtime, never in the source).
// (c): no file outside the admin set-up areas mentions the hint, "Zusatzmodul" or "Ihr Anbieter
// schaltet".
// (d)-(g) (Plan 566-10): the other three spots — API-Keys (/admin/system), Presence-Quellen
// (/admin/integrations) and the Branch-ID field (/admin/phorest) — plus the total: exactly four
// hint usages in the web source, all under routes/(app)/admin/.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function webSrcRoot(): string {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    if (existsSync(join(root, "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd(), "src");
}

const WEB_SRC = webSrcRoot();
const ROUTES_APP = join(WEB_SRC, "routes", "(app)");
const COMPONENTS = join(WEB_SRC, "lib", "components");
const ADMIN_SYSTEM = join(ROUTES_APP, "admin", "system", "+page.svelte");
const ADMIN_INTEGRATIONS = join(ROUTES_APP, "admin", "integrations", "+page.svelte");
const ADMIN_PHOREST = join(ROUTES_APP, "admin", "phorest", "+page.svelte");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path);
    return /\.(ts|svelte|js)$/.test(name) ? [path] : [];
  });
}

/** Drops HTML, block and line comments so prose in a comment can never trip or hide a pin. */
function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN = ["ModuleHint", "Zusatzmodul", "Ihr Anbieter schaltet"];

/** The markup of one `<Section title="…">` up to the next section. */
function sectionOf(source: string, title: string): string {
  const open = source.indexOf(`<Section title="${title}"`);
  expect(open, `section ${title}`).toBeGreaterThan(-1);
  const next = source.indexOf("<Section", open + 1);
  return source.slice(open, next === -1 ? undefined : next);
}

/** Opening tags of the hint component in comment-stripped source. */
function hintTags(source: string): string[] {
  return source.match(/<ModuleHint[\s/>][^>]*>/g) ?? [];
}

describe("module teaser placement (Phase 566, D-12)", () => {
  const page = stripComments(readFileSync(ADMIN_SYSTEM, "utf8"));

  function sectionBody(title: string): string {
    const open = page.indexOf(`<Section title="${title}"`);
    expect(open, `section ${title}`).toBeGreaterThan(-1);
    const next = page.indexOf("<Section", open + 1);
    return page.slice(open, next === -1 ? undefined : next);
  }

  it("(a) /admin/system holds exactly one HARDWARE_CLOCK hint, inside the NFC-Terminals section", () => {
    expect(page.match(/<ModuleHint\s+module="HARDWARE_CLOCK"/g)).toHaveLength(1);
    expect(sectionBody("NFC-Terminals")).toMatch(/<ModuleHint\s+module="HARDWARE_CLOCK"/);
  });

  it("(b) the NFC create markup is still in the same section, in the {:else} of the hint", () => {
    const nfc = sectionBody("NFC-Terminals");
    expect(nfc).toContain("{#if hardwareBooked === false}");
    const branches = nfc.split("{:else}");
    expect(branches[0]).toContain("<ModuleHint");
    expect(branches[0]).not.toContain("inline-create");
    expect(branches[1]).toContain('class="inline-create"');
    expect(branches[1]).toContain("createTerminalKey");
    // Existing keys stay listed and revocable outside the branch.
    expect(nfc).toContain("revokeTerminalKey");
    expect(nfc.indexOf("revokeTerminalKey")).toBeGreaterThan(nfc.indexOf('class="inline-create"'));
  });

  it("(c) clock, calendar, dashboard and every other non-admin view never show the hint", () => {
    const routeFiles = walk(ROUTES_APP).filter(
      (file) => !relative(ROUTES_APP, file).startsWith("admin/"),
    );
    const componentFiles = walk(COMPONENTS).filter((file) => {
      const top = relative(COMPONENTS, file).split("/")[0];
      return top !== "admin" && top !== "operator";
    });
    const layout = join(ROUTES_APP, "+layout.svelte");

    // Anti-vacuity: the walk must have seen the forbidden places, above a measured floor.
    const seen = (files: string[]) => files.map((file) => relative(WEB_SRC, file));
    expect(seen(routeFiles)).toContain(join("routes", "(app)", "dashboard", "+page.svelte"));
    expect(seen(routeFiles)).toContain(join("routes", "(app)", "+layout.svelte"));
    expect(seen(componentFiles).some((f) => f.includes(join("components", "calendar")))).toBe(true);
    expect(seen(componentFiles).some((f) => f.includes(join("components", "dashboard")))).toBe(
      true,
    );
    expect(routeFiles.length).toBeGreaterThanOrEqual(ROUTE_FLOOR);
    expect(componentFiles.length).toBeGreaterThanOrEqual(COMPONENT_FLOOR);
    expect(routeFiles).toContain(layout);

    const hits = [...routeFiles, ...componentFiles].flatMap((file) => {
      const text = stripComments(readFileSync(file, "utf8"));
      return FORBIDDEN.filter((needle) => text.includes(needle)).map(
        (needle) => `${relative(WEB_SRC, file)}: ${needle}`,
      );
    });
    expect(hits).toEqual([]);
  });
});

describe("module teaser placement — the other three set-up spots (Phase 566-10, D-05, D-12)", () => {
  const system = stripComments(readFileSync(ADMIN_SYSTEM, "utf8"));
  const integrations = stripComments(readFileSync(ADMIN_INTEGRATIONS, "utf8"));
  const phorest = stripComments(readFileSync(ADMIN_PHOREST, "utf8"));

  it("(d) API-Keys: one INTEGRATIONS hint inside its section, the create block only in the {:else}", () => {
    expect(system.match(/<ModuleHint\s+module="INTEGRATIONS"/g)).toHaveLength(1);
    const keys = sectionOf(system, "API Keys");
    expect(keys).toMatch(/<ModuleHint\s+module="INTEGRATIONS"/);
    expect(keys).toContain("{#if integrationsBooked === false}");
    const branches = keys.split("{:else}");
    expect(branches[0]).toContain("<ModuleHint");
    expect(branches[0]).not.toContain("api-key-create");
    expect(branches[1]).toContain('class="api-key-create"');
    expect(branches[1]).toContain("createApiKey");
    // Existing keys stay listed and revocable.
    expect(keys).toContain("revokeApiKey");
    expect(keys.indexOf("revokeApiKey")).toBeGreaterThan(keys.indexOf('class="api-key-create"'));
    expect(keys).toContain("pagedApiKeys");
  });

  it("(d2) createApiKey surfaces a refusal as a toast and never as a browser popup", () => {
    const start = system.indexOf("async function createApiKey");
    const end = system.indexOf("async function revokeApiKey");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = system.slice(start, end);
    expect(body).toContain("toasts.error(");
    expect(body).not.toMatch(/\balert\(/);
  });

  it("(e) Presence-Quellen: one HARDWARE_CLOCK hint, the create row only in the {:else}, list and revoke stay", () => {
    expect(integrations.match(/<ModuleHint\s+module="HARDWARE_CLOCK"/g)).toHaveLength(1);
    const sources = sectionOf(integrations, "Presence-Quellen");
    expect(sources).toContain("{#if hardwareBooked === false}");
    const branches = sources.split("{:else}");
    expect(branches[0]).toContain("<ModuleHint");
    expect(branches[0]).not.toContain("source-create-row");
    expect(branches[1]).toContain('class="source-create-row"');
    expect(branches[1]).toContain("handleCreateSource");
    expect(sources).toContain("askRevokeSource");
    expect(sources.indexOf("askRevokeSource")).toBeGreaterThan(
      sources.indexOf('class="source-create-row"'),
    );
    expect(sources).toContain("pagedSources");
  });

  it("(e2) a refused source creation shows the server message for 409 only", () => {
    const start = integrations.indexOf("async function handleCreateSource");
    const end = integrations.indexOf("function askRevokeSource");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = integrations.slice(start, end);
    expect(body).toMatch(/err instanceof ApiError\s*&&\s*err\.status === 409/);
    expect(body).toContain("err.message");
    expect(body).toContain("Schlüssel konnte nicht erstellt werden.");
  });

  it("(f) Phorest: one INTEGRATIONS hint next to the Branch-ID input, under phCouplingBlocked only", () => {
    expect(phorest.match(/<ModuleHint\s+module="INTEGRATIONS"/g)).toHaveLength(1);
    const input = phorest.indexOf('id="ph-branch"');
    expect(input).toBeGreaterThan(-1);
    const nearby = phorest.slice(input, input + 900);
    expect(nearby).toContain("disabled={!phBranchIdEditable}");
    expect(nearby).toMatch(/\{#if phCouplingBlocked\}\s*<ModuleHint\s+module="INTEGRATIONS"/);
    // The multi-salon sentence is shown for the multi-salon case only.
    expect(nearby).toMatch(
      /\{#if phMultiSalon\}\s*<p[^>]*>\s*Mehrere aktive Salons — die Phorest-Filiale wird je Salon gekoppelt\./,
    );
    // The pinned request contract is untouched; credentials, sync, mapping and runs stay on the page.
    expect(phorest).toContain("...(phBranchIdEditable ? { branchId: phBranchId } : {})");
    for (const kept of ["testPhorest", "loadPhMapping", "loadPhSyncRuns", "ph-pass"]) {
      expect(phorest, kept).toContain(kept);
    }
  });

  it("(f2) the coupling is blocked only when Integrationen is NOT booked and no coupling exists yet, read reactively", () => {
    const code = phorest;
    expect(code).toMatch(
      /phCouplingBlocked\s*=\s*\$derived\(\s*phConfigLoaded\s*&&\s*moduleBooked\(\$salonContext,\s*"INTEGRATIONS"\)\s*===\s*false\s*&&\s*phServerBranchId\s*===\s*null/,
    );
    expect(code).toMatch(
      /phBranchIdEditable\s*=\s*\$derived\(\s*phSoleSalon\s*&&\s*!phCouplingBlocked\s*\)/,
    );
    // A one-shot `get(salonContext)` right after `await salonContext.load(...)` raced the layout's
    // own forced load on a hard reload (found by the 566-12 walkthrough): never read it that way.
    expect(code).not.toMatch(/get\(\s*salonContext\s*\)/);
  });

  it("(g) exactly four hint usages in the web source, one per spot, all under routes/(app)/admin/", () => {
    const files = walk(WEB_SRC);
    // Anti-vacuity: the walk saw the four pages and a floor of source files.
    expect(files).toEqual(
      expect.arrayContaining([ADMIN_SYSTEM, ADMIN_INTEGRATIONS, ADMIN_PHOREST]),
    );
    expect(files.length).toBeGreaterThanOrEqual(WEB_SRC_FLOOR);

    const usages = files.flatMap((file) =>
      hintTags(stripComments(readFileSync(file, "utf8"))).map((tag) => ({
        file: relative(WEB_SRC, file),
        tag,
      })),
    );
    expect(usages).toHaveLength(4);
    for (const { file } of usages) {
      expect(file.startsWith(join("routes", "(app)", "admin") + "/"), file).toBe(true);
    }
    const bySpot = usages.map(({ file, tag }) => `${file}|${tag.match(/module="(\w+)"/)?.[1]}`);
    expect(bySpot.sort((a, b) => a.localeCompare(b))).toEqual(
      [
        join("routes", "(app)", "admin", "integrations", "+page.svelte") + "|HARDWARE_CLOCK",
        join("routes", "(app)", "admin", "phorest", "+page.svelte") + "|INTEGRATIONS",
        join("routes", "(app)", "admin", "system", "+page.svelte") + "|HARDWARE_CLOCK",
        join("routes", "(app)", "admin", "system", "+page.svelte") + "|INTEGRATIONS",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("(h) no file outside routes/(app)/admin/ renders the hint (operator console and shared layout included)", () => {
    const outside = walk(WEB_SRC).filter(
      (file) => !relative(WEB_SRC, file).startsWith(join("routes", "(app)", "admin") + "/"),
    );
    expect(outside.length).toBeGreaterThanOrEqual(WEB_SRC_FLOOR / 2);
    const hits = outside.filter(
      (file) => hintTags(stripComments(readFileSync(file, "utf8"))).length > 0,
    );
    expect(hits.map((file) => relative(WEB_SRC, file))).toEqual([]);
  });
});

// Measured at Phase 566-10: the web source walk (tests excluded) sees 211 files; the floor sits a little below.
const WEB_SRC_FLOOR = 150;

// Measured at Phase 566-07: 16 route files under routes/(app) outside admin/, 55 files under
// lib/components outside admin/ and operator/ (tests excluded). Floors sit a little below.
const ROUTE_FLOOR = 14;
const COMPONENT_FLOOR = 45;
