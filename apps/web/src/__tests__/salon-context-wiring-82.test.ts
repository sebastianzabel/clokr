// Issue #82 (D-05, D-07, D-09, D-10, D-11) — source-level wiring of the salon context, plus a
// guard that keeps the #64 rule, the storage key and the context fetch in ONE module.
//
// Why source reads: routes are not mountable in this workspace (no `$app` alias in
// apps/web/vitest.config.ts) — layout-boundaries.test.ts is the precedent.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

function readSource(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const LAYOUT = readSource("../routes/(app)/+layout.svelte", "src/routes/(app)/+layout.svelte");
const AUTH = readSource("../lib/stores/auth.ts", "src/lib/stores/auth.ts");

function srcRoot(): string {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    if (existsSync(join(root, "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd(), "src");
}

describe("Issue #82 — salon context wiring", () => {
  it("the layout imports the store and forces one load in onMount, after tenantFeatures.fetch()", () => {
    expect(LAYOUT).toContain('import { salonContext } from "$stores/salon-context";');
    const mount = LAYOUT.indexOf("onMount(() => {");
    const features = LAYOUT.indexOf("void tenantFeatures.fetch();", mount);
    const load = LAYOUT.indexOf(
      "void salonContext.load($authStore.user?.id ?? null, { force: true });",
      mount,
    );
    expect(mount).toBeGreaterThan(-1);
    expect(features).toBeGreaterThan(mount);
    expect(load).toBeGreaterThan(features);
    expect(load).toBeLessThan(LAYOUT.indexOf("onDestroy(", mount));
  });

  it("the layout re-validates after navigation, never on the initial mount and never without a token", () => {
    expect(LAYOUT).toMatch(
      /import \{ afterNavigate, beforeNavigate, goto \} from "\$app\/navigation";/,
    );
    const start = LAYOUT.indexOf("afterNavigate((navigation) => {");
    expect(start).toBeGreaterThan(-1);
    const body = LAYOUT.slice(start, LAYOUT.indexOf("});", start));
    expect(body).toContain("if (navigation.from === null || !$authStore.accessToken) return;");
    expect(body).toContain("void salonContext.load($authStore.user?.id ?? null);");
  });

  it("logout() resets the salon context; AuthUser stays without a tenant field (D-11)", () => {
    const logout = AUTH.slice(AUTH.indexOf("logout() {"));
    expect(logout.slice(0, logout.indexOf("\n    },"))).toContain("salonContext.reset();");
    const authUser = AUTH.slice(
      AUTH.indexOf("export interface AuthUser"),
      AUTH.indexOf("}", AUTH.indexOf("export interface AuthUser")),
    );
    const fields = authUser
      .split("\n")
      .filter((line) => /^\s+\w+\??:/.test(line))
      .map((line) => line.trim().split(/\??:/)[0]);
    // Issue #539 (D-05): the session carries no role either - the exact field set is the pin.
    expect(fields).toEqual(["id", "email", "employeeId", "firstName", "permissions"]);
  });
});

describe("Issue #82 — SalonSwitcher in the Topbar", () => {
  const TOPBAR = readSource(
    "../lib/components/layout/Topbar.svelte",
    "src/lib/components/layout/Topbar.svelte",
  );
  const SWITCHER = readSource(
    "../lib/components/layout/SalonSwitcher.svelte",
    "src/lib/components/layout/SalonSwitcher.svelte",
  );

  it("the Topbar renders the switcher before its actions", () => {
    expect(TOPBAR).toContain('import SalonSwitcher from "./SalonSwitcher.svelte";');
    const header = TOPBAR.indexOf('<header class="topbar">');
    const switcher = TOPBAR.indexOf("<SalonSwitcher />", header);
    expect(header).toBeGreaterThan(-1);
    expect(switcher).toBeGreaterThan(header);
    expect(switcher).toBeLessThan(TOPBAR.indexOf('<div class="topbar-actions">', header));
  });

  it("the switcher stays mountable: no $app import, no fetch, no own rule", () => {
    expect(SWITCHER).not.toMatch(/from "\$app\//);
    expect(SWITCHER).not.toMatch(/\bapi\.|fetch\(/);
    expect(SWITCHER).toContain("showSalonOptions(");
  });
});

describe("Issue #82 — one module owns the context (guard)", () => {
  /**
   * Protects: the #64 rule (`isMultiSalon`), the storage key prefix and the context fetch living in
   * lib/stores/salon-context.ts only, and the context never being sent as a request header (D-05).
   * Comment lines are skipped. Floor: 161 non-test files were measured at 47cfcfbf; 150 keeps a
   * margin and still turns red when the walk covers a fraction of the tree. Blind spot: a renamed
   * intermediate (a constant holding the path) is not seen — the guard stops re-growth, it does not
   * prove absence.
   */
  const OWNER = join("lib", "stores", "salon-context.ts");
  const PATTERNS = [/\bisMultiSalon\b/, /clokr\.salonContext/, /\/me\/context/];

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path);
      const source = /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name);
      return source ? [path] : [];
    });
  }

  const codeLines = (text: string) =>
    text.split("\n").filter((line) => {
      const t = line.trim();
      return !(
        t.startsWith("//") ||
        t.startsWith("/*") ||
        t.startsWith("*") ||
        t.startsWith("<!--")
      );
    });

  const root = srcRoot();
  const files = walk(root);

  it("walks the web source tree", () => {
    expect(files).toContain(join(root, OWNER));
    expect(files.length).toBeGreaterThanOrEqual(150);
  });

  it("isMultiSalon, the storage key and /me/context occur only in salon-context.ts", () => {
    const offenders = files.flatMap((file) =>
      codeLines(readFileSync(file, "utf8")).some((line) => PATTERNS.some((p) => p.test(line))) &&
      !file.endsWith(OWNER)
        ? [file]
        : [],
    );
    expect(offenders).toEqual([]);
    // Positive control: the owner itself is found by each pattern.
    const owner = codeLines(readFileSync(join(root, OWNER), "utf8"));
    for (const p of PATTERNS)
      expect(
        owner.some((line) => p.test(line)),
        String(p),
      ).toBe(true);
  });

  it("no web code puts a salon into a request header (D-05)", () => {
    const hits = files.flatMap((file) =>
      codeLines(readFileSync(file, "utf8"))
        .filter((line) => /\bheaders\b/i.test(line) && /salon/i.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });
});
