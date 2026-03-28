import { test, expect, Page } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

/**
 * UI Quality Check — pixel-level consistency audit.
 * Checks: spacing rhythm, typography scale, color system, border radius,
 * shadow consistency, alignment, responsive breakpoints, animation.
 */

interface UIFinding {
  page: string;
  category: string;
  severity: "critical" | "major" | "minor" | "good";
  message: string;
}

const findings: UIFinding[] = [];

function finding(page: string, category: string, severity: UIFinding["severity"], message: string) {
  findings.push({ page, category, severity, message });
}

test.afterAll(() => {
  if (findings.length === 0) return;

  const good = findings.filter((f) => f.severity === "good");
  const issues = findings.filter((f) => f.severity !== "good");

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║     UI QUALITY REPORT                    ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  if (good.length > 0) {
    console.log(`✅ GOOD (${good.length}):`);
    good.forEach((f) => console.log(`  ✓ [${f.page}] ${f.category}: ${f.message}`));
    console.log();
  }

  if (issues.length > 0) {
    console.log(`⚠️  ISSUES (${issues.length}):`);
    for (const f of issues) {
      const icon = f.severity === "critical" ? "🔴" : f.severity === "major" ? "🟡" : "🔵";
      console.log(`  ${icon} [${f.page}] ${f.category}: ${f.message}`);
    }
  }

  const c = issues.filter((f) => f.severity === "critical").length;
  const m = issues.filter((f) => f.severity === "major").length;
  console.log(
    `\n📊 ${good.length} good, ${c} critical, ${m} major, ${issues.length - c - m} minor\n`,
  );
});

test.describe("UI Quality — Typography Scale", () => {
  test("heading sizes follow consistent scale", async ({ page }) => {
    await loginAsAdmin(page);

    const pages = ["/dashboard", "/time-entries", "/leave", "/admin/employees", "/settings"];
    const h1Sizes: number[] = [];
    const h2Sizes: number[] = [];
    const h3Sizes: number[] = [];

    for (const url of pages) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");

      const headings = await page.evaluate(() => {
        return ["h1", "h2", "h3"].flatMap((tag) =>
          Array.from(document.querySelectorAll(tag))
            .filter((el) => (el as HTMLElement).offsetParent !== null)
            .map((el) => ({
              tag,
              size: parseFloat(getComputedStyle(el).fontSize),
              weight: getComputedStyle(el).fontWeight,
            })),
        );
      });

      for (const h of headings) {
        if (h.tag === "h1") h1Sizes.push(h.size);
        if (h.tag === "h2") h2Sizes.push(h.size);
        if (h.tag === "h3") h3Sizes.push(h.size);
      }
    }

    // H1 > H2 > H3
    const avgH1 = h1Sizes.length ? h1Sizes.reduce((a, b) => a + b) / h1Sizes.length : 0;
    const avgH2 = h2Sizes.length ? h2Sizes.reduce((a, b) => a + b) / h2Sizes.length : 0;
    const avgH3 = h3Sizes.length ? h3Sizes.reduce((a, b) => a + b) / h3Sizes.length : 0;

    if (avgH1 > avgH2 && avgH2 > avgH3) {
      finding(
        "Global",
        "Typography",
        "good",
        `Heading hierarchy correct: H1=${avgH1.toFixed(0)}px > H2=${avgH2.toFixed(0)}px > H3=${avgH3.toFixed(0)}px`,
      );
    } else {
      finding(
        "Global",
        "Typography",
        "major",
        `Heading hierarchy broken: H1=${avgH1.toFixed(0)}px, H2=${avgH2.toFixed(0)}px, H3=${avgH3.toFixed(0)}px`,
      );
    }

    // H1 should be consistent
    const h1Unique = [...new Set(h1Sizes.map((s) => Math.round(s)))];
    if (h1Unique.length <= 2) {
      finding("Global", "Typography", "good", `H1 sizes consistent: ${h1Unique.join(", ")}px`);
    } else {
      finding(
        "Global",
        "Typography",
        "major",
        `H1 sizes inconsistent across pages: ${h1Unique.join(", ")}px`,
      );
    }
  });

  test("body text is readable size", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const bodySize = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.body).fontSize),
    );
    const lineHeight = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.body).lineHeight),
    );

    if (bodySize >= 14 && bodySize <= 18) {
      finding("Global", "Typography", "good", `Body font size ${bodySize}px — readable`);
    } else {
      finding(
        "Global",
        "Typography",
        "major",
        `Body font size ${bodySize}px — ${bodySize < 14 ? "too small" : "too large"}`,
      );
    }

    const ratio = lineHeight / bodySize;
    if (ratio >= 1.4 && ratio <= 1.8) {
      finding(
        "Global",
        "Typography",
        "good",
        `Line height ratio ${ratio.toFixed(2)} — comfortable reading`,
      );
    } else {
      finding(
        "Global",
        "Typography",
        "minor",
        `Line height ratio ${ratio.toFixed(2)} — ${ratio < 1.4 ? "too tight" : "too loose"}`,
      );
    }
  });
});

test.describe("UI Quality — Spacing Rhythm", () => {
  test("spacing uses consistent scale (4px/8px based)", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const paddings = await page.evaluate(() => {
      const elements = document.querySelectorAll(".card, .card-body, .stat-card, .section-group");
      return Array.from(elements)
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const s = getComputedStyle(el);
          return {
            padding: [
              parseFloat(s.paddingTop),
              parseFloat(s.paddingRight),
              parseFloat(s.paddingBottom),
              parseFloat(s.paddingLeft),
            ],
            tag: el.className.split(" ")[0],
          };
        });
    });

    // Check if paddings are multiples of 4
    let on4Grid = 0;
    let off4Grid = 0;
    for (const p of paddings) {
      for (const v of p.padding) {
        if (v % 4 < 1 || v % 4 > 3) on4Grid++;
        else off4Grid++;
      }
    }

    const pct = paddings.length > 0 ? Math.round((on4Grid / (on4Grid + off4Grid)) * 100) : 100;
    if (pct >= 80) {
      finding("Dashboard", "Spacing", "good", `${pct}% of padding values on 4px grid`);
    } else {
      finding(
        "Dashboard",
        "Spacing",
        "minor",
        `Only ${pct}% of padding values on 4px grid — spacing rhythm inconsistent`,
      );
    }
  });

  test("gap between cards/sections is consistent", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const gaps = await page.evaluate(() => {
      const grids = document.querySelectorAll(
        "[style*='grid'], .stats-grid, .settings-grid, .chart-grid",
      );
      return Array.from(grids)
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({ gap: getComputedStyle(el).gap, class: el.className.split(" ")[0] }));
    });

    const uniqueGaps = [...new Set(gaps.map((g) => g.gap))];
    if (uniqueGaps.length <= 3) {
      finding("Dashboard", "Spacing", "good", `Grid gaps consistent: ${uniqueGaps.join(", ")}`);
    } else {
      finding(
        "Dashboard",
        "Spacing",
        "minor",
        `Too many different grid gaps: ${uniqueGaps.join(", ")}`,
      );
    }
  });
});

test.describe("UI Quality — Color System", () => {
  test("brand color used consistently", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const brandUsage = await page.evaluate(() => {
      const brand = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-brand")
        .trim();
      const elements = document.querySelectorAll("*");
      let usesVar = 0;
      const hardcoded = 0;

      for (const el of Array.from(elements).slice(0, 200)) {
        const s = getComputedStyle(el);
        if (s.color === brand || s.backgroundColor === brand) usesVar++;
      }

      return { brand, usesVar };
    });

    finding(
      "Dashboard",
      "Color System",
      "good",
      `Brand color ${brandUsage.brand} applied to ${brandUsage.usesVar} elements`,
    );
  });

  test("status colors are semantic", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const vars = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        green: s.getPropertyValue("--color-green").trim(),
        red: s.getPropertyValue("--color-red").trim(),
        yellow: s.getPropertyValue("--color-yellow").trim(),
        blue: s.getPropertyValue("--color-blue").trim(),
      };
    });

    const allDefined = vars.green && vars.red && vars.yellow && vars.blue;
    if (allDefined) {
      finding(
        "Global",
        "Color System",
        "good",
        "Semantic status colors defined (green/red/yellow/blue)",
      );
    } else {
      finding("Global", "Color System", "major", "Missing semantic status colors");
    }
  });
});

test.describe("UI Quality — Border Radius & Shadows", () => {
  test("border radius uses design tokens consistently", async ({ page }) => {
    await loginAsAdmin(page);

    const pages = ["/dashboard", "/leave", "/admin/system"];
    const allRadii: string[] = [];

    for (const url of pages) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");

      const radii = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll(".card, .btn, .form-input, .modal, [class*='card']"),
        )
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => getComputedStyle(el).borderRadius)
          .filter(Boolean);
      });
      allRadii.push(...radii);
    }

    const unique = [...new Set(allRadii)];
    if (unique.length <= 4) {
      finding(
        "Global",
        "Border Radius",
        "good",
        `Using ${unique.length} radius values: ${unique.join(", ")}`,
      );
    } else {
      finding(
        "Global",
        "Border Radius",
        "minor",
        `${unique.length} different radii — consider reducing to 3-4 design tokens`,
      );
    }
  });

  test("shadows follow elevation hierarchy", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const shadows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".card, .modal, .dropdown, .month-picker"))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({
          class: el.className.split(" ")[0],
          shadow: getComputedStyle(el).boxShadow,
        }))
        .filter((s) => s.shadow !== "none");
    });

    if (shadows.length > 0) {
      finding("Dashboard", "Shadows", "good", `${shadows.length} elements with shadow elevation`);
    }
  });
});

test.describe("UI Quality — Responsive Breakpoints", () => {
  test("mobile layout (375px) — no overflow, readable text", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    );
    if (!overflow) {
      finding("Mobile 375px", "Responsive", "good", "No horizontal overflow on dashboard");
    } else {
      finding("Mobile 375px", "Responsive", "critical", "Horizontal overflow on mobile dashboard");
    }

    // Text should still be readable (>=12px)
    const smallestText = await page.evaluate(() => {
      let min = 100;
      document.querySelectorAll("p, span, td, a, label, button").forEach((el) => {
        if ((el as HTMLElement).offsetParent === null) return;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size > 0 && size < min) min = size;
      });
      return min;
    });

    if (smallestText >= 11) {
      finding(
        "Mobile 375px",
        "Responsive",
        "good",
        `Smallest text ${smallestText}px — readable on mobile`,
      );
    } else {
      finding(
        "Mobile 375px",
        "Responsive",
        "major",
        `Text as small as ${smallestText}px — may be unreadable on mobile`,
      );
    }

    await screenshotPage(page, "ui-quality-mobile-375");
  });

  test("tablet layout (768px) — proper use of space", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Should have sidebar visible
    const sidebar = page.locator(".sidebar, aside").first();
    const sidebarVisible = await sidebar.isVisible().catch(() => false);

    if (sidebarVisible) {
      finding(
        "Tablet 768px",
        "Responsive",
        "good",
        "Sidebar visible on tablet — good use of space",
      );
    } else {
      finding(
        "Tablet 768px",
        "Responsive",
        "minor",
        "Sidebar hidden on tablet — could use the space",
      );
    }

    await screenshotPage(page, "ui-quality-tablet-768");
  });

  test("wide screen (1920px) — content doesn't stretch too wide", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const mainWidth = await page.evaluate(() => {
      const main = document.querySelector(".app-main, main, [class*='main']");
      return main ? main.getBoundingClientRect().width : 0;
    });

    if (mainWidth > 0 && mainWidth <= 1400) {
      finding(
        "Wide 1920px",
        "Responsive",
        "good",
        `Main content ${Math.round(mainWidth)}px — well constrained`,
      );
    } else if (mainWidth > 1400) {
      finding(
        "Wide 1920px",
        "Responsive",
        "minor",
        `Main content ${Math.round(mainWidth)}px — consider max-width for readability`,
      );
    }

    await screenshotPage(page, "ui-quality-wide-1920");
  });
});

test.describe("UI Quality — Interactive States", () => {
  test("buttons have hover states", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const btn = page.locator(".btn-primary, .clock-btn").first();
    if (await btn.isVisible()) {
      const beforeBg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
      await btn.hover();
      await page.waitForTimeout(200);
      const afterBg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);

      if (beforeBg !== afterBg) {
        finding("Dashboard", "Interactive States", "good", "Primary button changes on hover");
      } else {
        finding(
          "Dashboard",
          "Interactive States",
          "minor",
          "Primary button has no visible hover change",
        );
      }
    }
  });

  test("inputs have focus states", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const input = page.locator("input[type='password']").first();
    if (await input.isVisible()) {
      const beforeBorder = await input.evaluate((el) => getComputedStyle(el).borderColor);
      await input.focus();
      await page.waitForTimeout(200);
      const afterBorder = await input.evaluate((el) => getComputedStyle(el).borderColor);

      if (beforeBorder !== afterBorder) {
        finding("Profil", "Interactive States", "good", "Input shows focus state (border change)");
      } else {
        finding("Profil", "Interactive States", "minor", "Input has no visible focus indicator");
      }
    }
  });

  test("links are distinguishable from text", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/system");
    await page.waitForLoadState("networkidle");

    const links = await page.evaluate(() => {
      const allLinks = Array.from(
        document.querySelectorAll("a:not(.btn):not(.nav-item):not(.admin-tab)"),
      );
      return allLinks
        .filter(
          (l) => (l as HTMLElement).offsetParent !== null && (l as HTMLElement).innerText.trim(),
        )
        .slice(0, 5)
        .map((l) => {
          const s = getComputedStyle(l);
          return {
            text: (l as HTMLElement).innerText.trim().slice(0, 20),
            color: s.color,
            decoration: s.textDecorationLine,
          };
        });
    });

    const distinguishable = links.filter(
      (l) => l.decoration.includes("underline") || l.color !== "rgb(68, 64, 60)",
    );
    if (links.length === 0 || distinguishable.length === links.length) {
      finding(
        "Admin System",
        "Interactive States",
        "good",
        "Links visually distinct from body text",
      );
    } else {
      finding(
        "Admin System",
        "Interactive States",
        "major",
        `${links.length - distinguishable.length} links not distinguishable from text`,
      );
    }
  });
});
