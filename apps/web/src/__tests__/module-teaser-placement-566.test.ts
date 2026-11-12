// Phase 566 (D-12, AC-566-06) — the module hint is shown only where a feature is SET UP, never in
// clock, calendar or dashboard views, and never as a popup. Source-read pins (a route page cannot
// be mounted, see admin-system-save-wiring.test.ts for the precedent).
//
// (a)/(b): the NFC-Terminals panel of System > Integrationen (moved there from /admin/system, plan 854-14)
// holds exactly one hint for HARDWARE_CLOCK and still holds its create action (the hint replaces the action at
// runtime, never in the source).
// (c): no file outside the admin set-up areas mentions the hint, "Zusatzmodul" or "Anbieter
// schaltet".
// (d)-(g) (Plan 566-10): the other three spots — API-Schlüssel and Präsenz-Quellen (panels of System >
// Integrationen) and the Branch-ID field (/admin/phorest) — plus the total.
// (i) (Issue #563, D-18): the fifth spot — the salon create action on /admin/salons.
// (j) (Issue #624): the sixth spot — the create action of /admin/roles.
// Total: exactly six hint usages in the web source, all in an admin set-up area: routes/(app)/admin/ or, since
// plan 854-14 (the integrations panels moved out of the pages), lib/components/admin/integrationen/.
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
const TERMINALS_PANEL = join(COMPONENTS, "admin", "integrationen", "TerminalsPanel.svelte");
const API_KEYS_PANEL = join(COMPONENTS, "admin", "integrationen", "ApiKeysPanel.svelte");
const PRESENCE_PANEL = join(COMPONENTS, "admin", "integrationen", "PresenceSourcesPanel.svelte");
const ADMIN_PHOREST = join(ROUTES_APP, "admin", "phorest", "+page.svelte");
const ADMIN_SALONS = join(ROUTES_APP, "admin", "salons", "+page.svelte");
const ADMIN_ROLES = join(ROUTES_APP, "admin", "roles", "+page.svelte");

/** The admin set-up areas that may render the hint (paths relative to `src/`). */
function inSetupArea(rel: string): boolean {
  return (
    rel.startsWith(join("routes", "(app)", "admin") + "/") ||
    rel.startsWith(join("lib", "components", "admin", "integrationen") + "/")
  );
}

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

const FORBIDDEN = ["ModuleHint", "Zusatzmodul", "Anbieter schaltet"];

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
  // Plan 854-14: the NFC terminals moved from /admin/system to the panel of System > Integrationen.
  const terminals = stripComments(readFileSync(TERMINALS_PANEL, "utf8"));

  it("(a) the terminals panel holds exactly one HARDWARE_CLOCK hint and /admin/system none", () => {
    expect(terminals.match(/<ModuleHint\s+module="HARDWARE_CLOCK"/g)).toHaveLength(1);
    expect(stripComments(readFileSync(ADMIN_SYSTEM, "utf8"))).not.toContain("HARDWARE_CLOCK");
  });

  it("(b) the NFC create action is still in the panel, in the {:else} of the hint", () => {
    const open = terminals.indexOf("{#if hardwareBooked === false}");
    expect(open).toBeGreaterThan(-1);
    const branches = terminals.slice(open, terminals.indexOf("{/if}", open)).split("{:else}");
    expect(branches[0]).toContain("<ModuleHint");
    expect(branches[0]).not.toContain("openCreate");
    expect(branches[1]).toContain("openCreate");
    expect(terminals).toContain("createTerminalKey");
    // Existing keys stay listed and revocable outside the branch.
    expect(terminals).toContain("askRevoke");
    expect(terminals.indexOf("askRevoke(row)")).toBeGreaterThan(terminals.indexOf("{/if}", open));
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
  // Plan 854-14: the API keys and the presence sources live in panels of System > Integrationen.
  const system = stripComments(readFileSync(ADMIN_SYSTEM, "utf8"));
  const apiKeys = stripComments(readFileSync(API_KEYS_PANEL, "utf8"));
  const presence = stripComments(readFileSync(PRESENCE_PANEL, "utf8"));
  const phorest = stripComments(readFileSync(ADMIN_PHOREST, "utf8"));

  /** The two branches of the first `{#if <condition>} … {:else} … {/if}` of a panel. */
  function branchesOf(source: string, condition: string): [string, string] {
    const open = source.indexOf(`{#if ${condition}}`);
    expect(open, condition).toBeGreaterThan(-1);
    const [hintBranch, createBranch] = source
      .slice(open, source.indexOf("{/if}", open))
      .split("{:else}");
    return [hintBranch, createBranch];
  }

  it("(d) API-Keys: one INTEGRATIONS hint in the panel, the create action only in the {:else}, /admin/system has none", () => {
    expect(system).not.toContain("INTEGRATIONS");
    expect(apiKeys.match(/<ModuleHint\s+module="INTEGRATIONS"/g)).toHaveLength(1);
    const [hintBranch, createBranch] = branchesOf(apiKeys, "integrationsBooked === false");
    expect(hintBranch).toContain("<ModuleHint");
    expect(hintBranch).not.toContain("openCreate");
    expect(createBranch).toContain("openCreate");
    expect(apiKeys).toContain("createApiKey");
    // Existing keys stay listed and revocable.
    expect(apiKeys).toContain("askRevoke");
    expect(apiKeys.indexOf("askRevoke(row)")).toBeGreaterThan(apiKeys.indexOf("{/if}"));
  });

  it("(d2) createApiKey surfaces a refusal inside the dialog, a revoke failure as a toast, never as a browser popup", () => {
    const start = apiKeys.indexOf("async function createApiKey");
    const end = apiKeys.indexOf("let revokeConfirm");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = apiKeys.slice(start, end);
    expect(body).toContain("createError =");
    expect(body).not.toMatch(/\balert\(/);
    expect(apiKeys).toContain("toasts.error(");
  });

  it("(e) Präsenz-Quellen: one HARDWARE_CLOCK hint, the create action only in the {:else}, list and revoke stay", () => {
    expect(presence.match(/<ModuleHint\s+module="HARDWARE_CLOCK"/g)).toHaveLength(1);
    const [hintBranch, createBranch] = branchesOf(presence, "hardwareBooked === false");
    expect(hintBranch).toContain("<ModuleHint");
    expect(hintBranch).not.toContain("openCreateSource");
    expect(createBranch).toContain("openCreateSource");
    expect(presence).toContain("handleCreateSource");
    expect(presence).toContain("askRevokeSource");
    expect(presence.indexOf("askRevokeSource(row)")).toBeGreaterThan(presence.indexOf("{/if}"));
    expect(presence).toContain("pagedSources");
  });

  it("(e2) a refused source creation shows the server message for 409 only", () => {
    const start = presence.indexOf("async function handleCreateSource");
    const end = presence.indexOf("let revokeConfirm");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = presence.slice(start, end);
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

  it("(g) exactly six hint usages in the web source, one per spot, all in an admin set-up area", () => {
    const files = walk(WEB_SRC);
    // Anti-vacuity: the walk saw the five pages and a floor of source files.
    expect(files).toEqual(
      expect.arrayContaining([
        ADMIN_SYSTEM,
        PRESENCE_PANEL,
        API_KEYS_PANEL,
        ADMIN_PHOREST,
        ADMIN_SALONS,
        ADMIN_ROLES,
      ]),
    );
    expect(files.length).toBeGreaterThanOrEqual(WEB_SRC_FLOOR);

    const usages = files.flatMap((file) =>
      hintTags(stripComments(readFileSync(file, "utf8"))).map((tag) => ({
        file: relative(WEB_SRC, file),
        tag,
      })),
    );
    expect(usages).toHaveLength(6);
    for (const { file } of usages) {
      expect(inSetupArea(file), file).toBe(true);
    }
    const bySpot = usages.map(({ file, tag }) => `${file}|${tag.match(/module="(\w+)"/)?.[1]}`);
    expect(bySpot.sort((a, b) => a.localeCompare(b))).toEqual(
      [
        join("lib", "components", "admin", "integrationen", "ApiKeysPanel.svelte") +
          "|INTEGRATIONS",
        join("lib", "components", "admin", "integrationen", "PresenceSourcesPanel.svelte") +
          "|HARDWARE_CLOCK",
        join("routes", "(app)", "admin", "phorest", "+page.svelte") + "|INTEGRATIONS",
        join("routes", "(app)", "admin", "roles", "+page.svelte") + "|CHAIN",
        join("routes", "(app)", "admin", "salons", "+page.svelte") + "|CHAIN",
        join("lib", "components", "admin", "integrationen", "TerminalsPanel.svelte") +
          "|HARDWARE_CLOCK",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("(i) the salons list holds exactly one CHAIN hint and offers 'Salon anlegen' only in the {:else} of its condition", () => {
    const code = stripComments(readFileSync(ADMIN_SALONS, "utf8"));
    expect(code.match(/<ModuleHint\s+module="CHAIN"/g)).toHaveLength(1);
    expect(code).toMatch(
      /chainHint\s*=\s*\$derived\(\s*moduleBooked\(\$salonContext,\s*"CHAIN"\)\s*===\s*false\s*&&\s*activeCount\s*>=\s*\(\$salonContext\.packages\?\.salonLimit\s*\?\?\s*Number\.POSITIVE_INFINITY\)/,
    );
    const open = code.indexOf("{#if chainHint}");
    expect(open).toBeGreaterThan(-1);
    const close = code.indexOf("{/if}", open);
    const [hintBranch, createBranch] = code.slice(open, close).split("{:else}");
    expect(hintBranch).toContain("<ModuleHint");
    expect(hintBranch).not.toContain("Salon anlegen");
    expect(createBranch).toContain('href="/admin/salons/neu"');
    expect(createBranch).toContain("Salon anlegen");
    // The link exists nowhere else on the page.
    expect(code.match(/href="\/admin\/salons\/neu"/g)).toHaveLength(1);
  });

  it("(j) the roles page holds one CHAIN hint, reads the booked state without treating unknown as missing, and hands it to the tab as the replacement of 'Neue Rolle'", () => {
    const code = stripComments(readFileSync(ADMIN_ROLES, "utf8"));
    expect(code.match(/<ModuleHint\s+module="CHAIN"/g)).toHaveLength(1);
    expect(code).toMatch(/moduleBooked\(\$salonContext,\s*"CHAIN"\)\s*===\s*false/);
    expect(code).toContain("createHint={chainHint ? chainHintSnippet : undefined}");
    const tab = stripComments(
      readFileSync(join(WEB_SRC, "lib", "components", "admin", "roles", "RolesTab.svelte"), "utf8"),
    );
    const open = tab.indexOf("{#if createHint}");
    expect(open).toBeGreaterThan(-1);
    const [hintBranch, createBranch] = tab.slice(open, tab.indexOf("{/if}", open)).split("{:else}");
    expect(hintBranch).toContain("@render createHint()");
    expect(hintBranch).not.toContain("Neue Rolle");
    expect(createBranch).toContain("Neue Rolle");
  });

  it("(h) no file outside the admin set-up areas renders the hint (operator console and shared layout included)", () => {
    const outside = walk(WEB_SRC).filter((file) => !inSetupArea(relative(WEB_SRC, file)));
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
