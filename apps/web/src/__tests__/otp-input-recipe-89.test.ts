// Issue #89 (UI-SPEC checker sign-off) - the .otp-input look is ONE shared recipe in app.css.
//
// It used to be a scoped rule inside the tenant /otp page; the operator code field needs the same
// look, and two copies would drift. The compound selector `.form-input.otp-input` keeps the
// specificity the scoped rule had (class + Svelte hash class), so /otp renders byte-identically.
//
// Source test, anchor-first: every assertion states first that it found the thing it is about.
import { readFileSync } from "node:fs";
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

function read(relative: string): string {
  return readFileSync(resolve(srcRoot(), relative), "utf8");
}

const APP_CSS = read("app.css");
const OTP_PAGE = read("routes/(auth)/otp/+page.svelte");
const SIGN_IN = read("lib/components/operator/SignInSteps.svelte");

/** The declaration block of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : null;
}

describe("shared .otp-input recipe in app.css", () => {
  it("defines the compound rule exactly once", () => {
    const occurrences = APP_CSS.split("\n").filter((line) =>
      line.startsWith(".form-input.otp-input"),
    );
    expect(occurrences).toHaveLength(1);
  });

  it("carries the five declarations of the former scoped rule", () => {
    const body = ruleBody(APP_CSS, ".form-input.otp-input");
    expect(body, "compound rule found").not.toBeNull();
    const declarations = String(body)
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    expect(declarations).toEqual(
      [
        "text-align: center",
        "font-size: 2rem",
        "font-weight: 700",
        "letter-spacing: 0.5rem",
        "font-variant-numeric: tabular-nums",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("comes after the first .form-input recipe", () => {
    const base = APP_CSS.indexOf("\n.form-input {");
    const compound = APP_CSS.indexOf("\n.form-input.otp-input");
    expect(base, ".form-input recipe found").toBeGreaterThan(-1);
    expect(compound, "compound rule found").toBeGreaterThan(-1);
    expect(compound).toBeGreaterThan(base);
  });
});

describe("consumers of the recipe", () => {
  it("the tenant /otp page still uses the class but no longer defines it", () => {
    expect(OTP_PAGE).toContain("form-input otp-input");
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(OTP_PAGE);
    expect(style, "otp page has a <style> block").not.toBeNull();
    expect(String(style?.[1])).not.toContain(".otp-input");
  });

  it("the operator code field uses the class and writes no font-size for it", () => {
    expect(SIGN_IN).toContain("form-input otp-input");
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(SIGN_IN);
    const css = style ? style[1] : "";
    expect(css).not.toContain(".otp-input");
    expect(css).not.toMatch(/letter-spacing/);
  });
});
