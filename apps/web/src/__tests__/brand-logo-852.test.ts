// Issue #852 — the brand mark has ONE source file (static/brand/mark.svg); every logo in the web app
// goes through BrandLogo or the generated /brand/ files, and no old PNG logo is referenced anywhere.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import BrandLogo from "$lib/components/brand/BrandLogo.svelte";

function webRoot(): string {
  try {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    if (existsSync(join(root, "src", "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd());
}

const WEB = webRoot();
const STATIC = join(WEB, "static");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path);
    return /\.(ts|svelte|html|json|webmanifest)$/.test(name) && !name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

/** PNG width and height from the IHDR chunk. */
function pngSize(file: string): [number, number] {
  const buf = readFileSync(file);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const FILES = walk(join(WEB, "src"));
const files = [...FILES, join(STATIC, "manifest.json")];

describe("Issue #852 — one brand source", () => {
  it("walks the web source (non-vacuity)", () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it("references no retired PNG logo", () => {
    const hits = files
      .filter((f) => /clokr-(logo|icon|wordmark)\.png/.test(readFileSync(f, "utf8")))
      .map((f) => relative(WEB, f));
    expect(hits).toEqual([]);
    for (const old of ["clokr-logo.png", "clokr-icon.png", "clokr-wordmark.png"]) {
      expect(existsSync(join(STATIC, old)), old).toBe(false);
    }
  });

  it("keeps the mark as one single-colour SVG source", () => {
    const mark = readFileSync(join(STATIC, "brand", "mark.svg"), "utf8");
    expect(mark).toContain("currentColor");
    expect(mark).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("links the generated favicons and touch icon", () => {
    const html = readFileSync(join(WEB, "src", "app.html"), "utf8");
    expect(html).toContain('href="/brand/favicon.svg"');
    expect(html).toContain('href="/brand/favicon-32.png"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(existsSync(join(STATIC, "brand", "favicon.svg"))).toBe(true);
  });

  it("generated every raster in its declared size", () => {
    expect(pngSize(join(STATIC, "brand", "favicon-32.png"))).toEqual([32, 32]);
    expect(pngSize(join(STATIC, "apple-touch-icon.png"))).toEqual([180, 180]);
    expect(pngSize(join(STATIC, "icon-192.png"))).toEqual([192, 192]);
    expect(pngSize(join(STATIC, "icon-512.png"))).toEqual([512, 512]);
    expect(pngSize(join(STATIC, "icon-maskable-512.png"))).toEqual([512, 512]);
  });

  it("every former logo place renders BrandLogo", () => {
    for (const rel of [
      "src/lib/components/layout/Sidebar.svelte",
      // #855: the sign-in pages draw the logo through their one frame (each page renders AuthFrame,
      // pinned below and in auth-frame-855.test.ts).
      "src/lib/components/auth/AuthFrame.svelte",
      "src/lib/components/operator/OperatorBar.svelte",
      "src/routes/(operator)/betreiber/anmelden/+page.svelte",
    ]) {
      expect(readFileSync(join(WEB, rel), "utf8"), rel).toContain("<BrandLogo");
    }
    for (const page of ["login", "invitation", "otp", "forgot-password", "reset-password"]) {
      const rel = `src/routes/(auth)/${page}/+page.svelte`;
      expect(readFileSync(join(WEB, rel), "utf8"), rel).toContain("<AuthFrame");
    }
  });
});

describe("BrandLogo", () => {
  it("is one image with an accessible name, mark plus wordmark", () => {
    const { container } = render(BrandLogo, { size: 24 });
    expect(screen.getByRole("img", { name: "Clokr" })).toBeInTheDocument();
    expect(container.querySelector(".brand-logo-mark")).not.toBeNull();
    expect(container.textContent).toContain("clokr");
  });

  it("can show the mark alone with its own name and colour", () => {
    const { container } = render(BrandLogo, {
      wordmark: false,
      label: "Clokr Zeiterfassung",
      color: "#ffffff",
    });
    const logo = screen.getByRole("img", { name: "Clokr Zeiterfassung" });
    expect(container.textContent).not.toContain("clokr");
    expect(logo.getAttribute("style")).toContain("--brand-logo-color: #ffffff");
  });
});
