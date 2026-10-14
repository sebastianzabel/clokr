// Phase 566 (D-12, AC-566-06) — the module hint is shown only where a feature is SET UP, never in
// clock, calendar or dashboard views, and never as a popup. Source-read pins (a route page cannot
// be mounted, see admin-system-save-wiring.test.ts for the precedent).
//
// (a)/(b): the NFC-Terminals section of /admin/system holds exactly one hint for HARDWARE_CLOCK and
// still holds its create markup (the hint replaces the row at runtime, never in the source).
// (c): no file outside the admin set-up areas mentions the hint, "Zusatzmodul" or "Ihr Anbieter
// schaltet". Plan 566-10 extends (a)/(b) to the other three spots.
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

// Measured at Phase 566-07: 16 route files under routes/(app) outside admin/, 55 files under
// lib/components outside admin/ and operator/ (tests excluded). Floors sit a little below.
const ROUTE_FLOOR = 14;
const COMPONENT_FLOOR = 45;
