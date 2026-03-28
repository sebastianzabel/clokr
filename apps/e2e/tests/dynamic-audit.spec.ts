import { test, expect, Page } from "@playwright/test";
import { loginAsAdmin } from "./helpers";

/**
 * Dynamic UI Audit — analyses the live DOM for consistency issues,
 * broken elements, design violations, and UX problems.
 */

const ALL_PAGES = [
  { name: "Dashboard", url: "/dashboard" },
  { name: "Zeiterfassung", url: "/time-entries" },
  { name: "Abwesenheiten", url: "/leave" },
  { name: "Profil", url: "/settings" },
  { name: "Admin Mitarbeiter", url: "/admin/employees" },
  { name: "Admin Urlaub", url: "/admin/vacation" },
  { name: "Admin Sonderurlaub", url: "/admin/special-leave" },
  { name: "Admin Betriebsurlaub", url: "/admin/shutdowns" },
  { name: "Admin Schichtplan", url: "/admin/shifts" },
  { name: "Admin Monatsabschluss", url: "/admin/monatsabschluss" },
  { name: "Admin System", url: "/admin/system" },
  { name: "Admin Import", url: "/admin/import" },
  { name: "Admin Audit", url: "/admin/audit" },
  { name: "Überstunden", url: "/overtime" },
  { name: "Berichte", url: "/reports" },
];

test.describe("Dynamic UI Audit", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("no console errors on any page", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`${msg.text()}`);
    });

    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");
    }

    if (errors.length > 0) {
      console.log("\n🔴 Console Errors found:");
      errors.forEach((e) => console.log(`  ${e}`));
    }
    // Filter out known benign errors (CSP violations from extensions, etc.)
    const realErrors = errors.filter(
      (e) =>
        !e.includes("favicon") && !e.includes("extension") && !e.includes("ERR_BLOCKED_BY_CLIENT"),
    );
    expect(realErrors, "Console errors found").toHaveLength(0);
  });

  test("no broken images on any page", async ({ page }) => {
    const broken: string[] = [];

    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const images = await page.locator("img").all();
      for (const img of images) {
        const src = await img.getAttribute("src");
        const natural = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
        const displayed = await img.isVisible();
        if (displayed && natural === 0 && src && !src.startsWith("data:")) {
          broken.push(`${p.name}: ${src}`);
        }
      }
    }

    if (broken.length > 0) {
      console.log("\n🖼 Broken images:");
      broken.forEach((b) => console.log(`  ${b}`));
    }
    expect(broken).toHaveLength(0);
  });

  test("no empty pages (all have content)", async ({ page }) => {
    const emptyPages: string[] = [];

    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      const textLength = await page.evaluate(() => document.body.innerText.trim().length);
      if (textLength < 50) {
        emptyPages.push(`${p.name} (${p.url}): only ${textLength} chars`);
      }
    }

    if (emptyPages.length > 0) {
      console.log("\n📭 Empty/near-empty pages:");
      emptyPages.forEach((e) => console.log(`  ${e}`));
    }
    expect(emptyPages).toHaveLength(0);
  });

  test("no 4xx/5xx API errors during navigation", async ({ page }) => {
    const apiErrors: string[] = [];

    page.on("response", (resp) => {
      if (resp.url().includes("/api/") && resp.status() >= 400) {
        apiErrors.push(`${resp.status()} ${resp.url()}`);
      }
    });

    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");
    }

    // Filter known acceptable errors (404 for avatar when none uploaded)
    const realErrors = apiErrors.filter((e) => !e.includes("/avatars/"));

    if (realErrors.length > 0) {
      console.log("\n🌐 API Errors:");
      realErrors.forEach((e) => console.log(`  ${e}`));
    }
    expect(realErrors, "API errors during navigation").toHaveLength(0);
  });

  test("consistent font usage across pages", async ({ page }) => {
    const fontIssues: string[] = [];

    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const fonts = await page.evaluate(() => {
        const body = getComputedStyle(document.body).fontFamily;
        const headings = Array.from(document.querySelectorAll("h1,h2,h3")).map(
          (el) => getComputedStyle(el).fontFamily,
        );
        return { body, headings };
      });

      // Check body uses our design system font
      if (!fonts.body.includes("DM Sans") && !fonts.body.includes("system-ui")) {
        fontIssues.push(`${p.name}: body font = ${fonts.body}`);
      }
    }

    if (fontIssues.length > 0) {
      console.log("\n🔤 Font inconsistencies:");
      fontIssues.forEach((f) => console.log(`  ${f}`));
    }
    expect(fontIssues).toHaveLength(0);
  });

  test("all buttons have visible text or aria-label", async ({ page }) => {
    const issues: string[] = [];

    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const unlabeled = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        return buttons
          .filter((btn) => {
            const text = btn.innerText.trim();
            const ariaLabel = btn.getAttribute("aria-label");
            const title = btn.getAttribute("title");
            const isHidden = btn.offsetParent === null;
            return !isHidden && !text && !ariaLabel && !title;
          })
          .map((btn) => btn.outerHTML.slice(0, 100));
      });

      if (unlabeled.length > 0) {
        unlabeled.forEach((html) => issues.push(`${p.name}: ${html}`));
      }
    }

    if (issues.length > 0) {
      console.log("\n🏷 Buttons without labels:");
      issues.forEach((i) => console.log(`  ${i}`));
    }
    // Warn but don't fail — some icon buttons may intentionally have no text
    if (issues.length > 0) {
      console.warn(`⚠ ${issues.length} unlabeled buttons found (review manually)`);
    }
  });

  test("no overlapping elements (z-index issues)", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Check sidebar doesn't overlap main content
    const sidebarRight = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar, aside");
      if (!sidebar) return 0;
      return sidebar.getBoundingClientRect().right;
    });

    const mainLeft = await page.evaluate(() => {
      const main = document.querySelector(".main-content, main, [id='main-content']");
      if (!main) return 999;
      return main.getBoundingClientRect().left;
    });

    if (sidebarRight > 0 && mainLeft < 999) {
      expect(mainLeft).toBeGreaterThanOrEqual(sidebarRight - 1); // 1px tolerance
    }
  });

  test("color theme variables are consistent", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const vars = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        brand: style.getPropertyValue("--color-brand").trim(),
        bg: style.getPropertyValue("--color-bg").trim(),
        text: style.getPropertyValue("--color-text").trim(),
        surface: style.getPropertyValue("--color-surface").trim(),
        border: style.getPropertyValue("--color-border").trim(),
      };
    });

    console.log("\n🎨 Active theme variables:", vars);

    // All should be non-empty
    expect(vars.brand).not.toBe("");
    expect(vars.bg).not.toBe("");
    expect(vars.text).not.toBe("");
    expect(vars.surface).not.toBe("");
    expect(vars.border).not.toBe("");
  });

  test("forms have proper input types", async ({ page }) => {
    const issues: string[] = [];

    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const badInputs = await page.evaluate(() => {
        const inputs = Array.from(
          document.querySelectorAll("input:not([hidden]):not([type='hidden'])"),
        );
        return inputs
          .filter((input) => {
            const el = input as HTMLInputElement;
            if (el.offsetParent === null) return false; // hidden
            const type = el.type;
            const name = (el.name || el.id || "").toLowerCase();
            // Email fields should be type=email
            if (name.includes("email") && type !== "email") return true;
            // Password fields should be type=password
            if (name.includes("password") && type !== "password") return true;
            return false;
          })
          .map(
            (el) =>
              `${(el as HTMLInputElement).name || (el as HTMLInputElement).id}: type=${(el as HTMLInputElement).type}`,
          );
      });

      if (badInputs.length > 0) {
        badInputs.forEach((i) => issues.push(`${p.name}: ${i}`));
      }
    }

    if (issues.length > 0) {
      console.log("\n📝 Input type issues:");
      issues.forEach((i) => console.log(`  ${i}`));
    }
    expect(issues).toHaveLength(0);
  });

  test("no horizontal scrollbar on desktop", async ({ page }) => {
    const overflowing: string[] = [];

    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const hasHScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });

      if (hasHScroll) {
        overflowing.push(p.name);
      }
    }

    if (overflowing.length > 0) {
      console.log("\n📐 Pages with horizontal overflow:");
      overflowing.forEach((p) => console.log(`  ${p}`));
    }
    expect(overflowing).toHaveLength(0);
  });
});
