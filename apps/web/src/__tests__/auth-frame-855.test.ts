// Issue #855 (D-855-01…05, D-855-09) - every signed-out page is built from the one sign-in frame and the
// design-system blocks, never from a page-own layout.
//
// Source test, anchor-first: the walked set is asserted non-empty and equal to the five known pages, so a
// moved or renamed page turns this red instead of letting it pass having checked nothing.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function srcRoot(): string {
  try {
    return fileURLToPath(new URL("..", import.meta.url));
  } catch {
    return resolve(process.cwd(), "src");
  }
}

const AUTH_DIR = resolve(srcRoot(), "routes/(auth)");
const EXPECTED = ["forgot-password", "invitation", "login", "otp", "reset-password"];

const pages = readdirSync(AUTH_DIR)
  .filter((name) => statSync(resolve(AUTH_DIR, name)).isDirectory())
  .sort()
  .map((name) => ({
    name,
    source: readFileSync(resolve(AUTH_DIR, name, "+page.svelte"), "utf8"),
  }));

function markup(source: string): string {
  return source.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
}

function style(source: string): string {
  return /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? "";
}

describe("signed-out pages on the sign-in frame (#855)", () => {
  it("walks exactly the five sign-in pages", () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((p) => p.name)).toEqual(EXPECTED);
  });

  it.each(EXPECTED)("%s renders AuthFrame and no layout of its own", (name) => {
    const page = pages.find((p) => p.name === name);
    expect(page, `${name} found`).toBeDefined();
    const src = String(page?.source);
    expect(src).toContain('import AuthFrame from "$lib/components/auth/AuthFrame.svelte"');
    expect(markup(src)).toMatch(/<AuthFrame\b/);
    // The former page-own frames, decorations and alert recipes are gone.
    for (const retired of [".login-page", ".login-card", "gradient", "@keyframes", ".alert"]) {
      expect(style(src), `${name}: ${retired}`).not.toContain(retired);
    }
    expect(markup(src)).not.toMatch(/class="alert\b/);
    expect(markup(src)).not.toMatch(/<h1\b/);
  });

  it.each(EXPECTED)("%s states messages through Note and fields through FormField", (name) => {
    const src = String(pages.find((p) => p.name === name)?.source);
    expect(markup(src)).toMatch(/<Note\b/);
    if (/<input\b/.test(markup(src))) expect(markup(src)).toMatch(/<FormField\b/);
  });

  it.each(EXPECTED)("%s carries no glyph or emoji as a symbol", (name) => {
    const text = markup(String(pages.find((p) => p.name === name)?.source));
    expect(text).not.toMatch(/[⚠✓⏰⏱]/u);
  });

  it.each(EXPECTED)("%s keeps the action label while busy (no ellipsis label)", (name) => {
    const text = markup(String(pages.find((p) => p.name === name)?.source));
    expect(text).not.toMatch(/\w…/u);
  });
});
