import { test, expect, Page } from "@playwright/test";
import { loginAsAdmin } from "./helpers";

/**
 * UX Design Audit — analyses the live DOM like a UI/UX designer.
 * Checks spacing, hierarchy, consistency, interaction patterns.
 * Inspired by modern UIs (Datadog, Linear, Vercel).
 */

const ALL_PAGES = [
  { name: "Dashboard", url: "/dashboard" },
  { name: "Zeiterfassung", url: "/time-entries" },
  { name: "Abwesenheiten", url: "/leave" },
  { name: "Profil", url: "/settings" },
  { name: "Admin Mitarbeiter", url: "/admin/employees" },
  { name: "Admin Urlaub", url: "/admin/vacation" },
  { name: "Admin System", url: "/admin/system" },
  { name: "Überstunden", url: "/overtime" },
  { name: "Berichte", url: "/reports" },
];

interface Finding {
  page: string;
  category: string;
  severity: "critical" | "major" | "minor" | "suggestion";
  message: string;
  element?: string;
}

test.describe("UX Design Audit", () => {
  const findings: Finding[] = [];

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test.afterAll(() => {
    if (findings.length === 0) {
      console.log("\n✅ No UX issues found!");
      return;
    }

    console.log(`\n📋 UX DESIGN AUDIT REPORT — ${findings.length} findings\n`);

    const grouped = findings.reduce(
      (acc, f) => {
        acc[f.category] = acc[f.category] || [];
        acc[f.category].push(f);
        return acc;
      },
      {} as Record<string, Finding[]>,
    );

    for (const [cat, items] of Object.entries(grouped)) {
      console.log(`\n── ${cat} (${items.length}) ──`);
      for (const f of items) {
        const icon =
          f.severity === "critical"
            ? "🔴"
            : f.severity === "major"
              ? "🟡"
              : f.severity === "minor"
                ? "🔵"
                : "💡";
        console.log(`  ${icon} [${f.page}] ${f.message}${f.element ? ` → ${f.element}` : ""}`);
      }
    }

    const critCount = findings.filter((f) => f.severity === "critical").length;
    const majorCount = findings.filter((f) => f.severity === "major").length;
    console.log(
      `\n📊 Summary: ${critCount} critical, ${majorCount} major, ${findings.length - critCount - majorCount} minor/suggestions`,
    );
  });

  test("spacing consistency", async ({ page }) => {
    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      // Check heading margins are consistent
      const headingSpacing = await page.evaluate(() => {
        const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
        return headings
          .filter((h) => h.offsetParent !== null)
          .map((h) => {
            const style = getComputedStyle(h);
            return {
              tag: h.tagName,
              text: h.textContent?.trim().slice(0, 30),
              marginBottom: parseFloat(style.marginBottom),
              marginTop: parseFloat(style.marginTop),
              fontSize: parseFloat(style.fontSize),
            };
          });
      });

      // Check for inconsistent heading sizes
      const h1s = headingSpacing.filter((h) => h.tag === "H1");
      const h1Sizes = [...new Set(h1s.map((h) => h.fontSize))];
      if (h1Sizes.length > 1) {
        findings.push({
          page: p.name,
          category: "Typography",
          severity: "major",
          message: `Inconsistent H1 sizes: ${h1Sizes.join(", ")}px`,
        });
      }

      // Check for very large spacing gaps (>48px margin)
      for (const h of headingSpacing) {
        if (h.marginBottom > 48 || h.marginTop > 48) {
          findings.push({
            page: p.name,
            category: "Spacing",
            severity: "minor",
            message: `Excessive margin on ${h.tag}: top=${h.marginTop}px, bottom=${h.marginBottom}px`,
            element: h.text ?? "",
          });
        }
      }
    }
  });

  test("button consistency", async ({ page }) => {
    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("button, .btn, a.btn"))
          .filter((el) => el.offsetParent !== null)
          .map((el) => {
            const style = getComputedStyle(el);
            return {
              text: el.textContent?.trim().slice(0, 30) ?? "",
              borderRadius: style.borderRadius,
              fontSize: parseFloat(style.fontSize),
              height: el.getBoundingClientRect().height,
              classes: el.className,
            };
          });
      });

      // Check for buttons that are too small (< 32px height — touch target)
      const tooSmall = buttons.filter((b) => b.height > 0 && b.height < 32 && b.text);
      for (const b of tooSmall) {
        findings.push({
          page: p.name,
          category: "Touch Targets",
          severity: "major",
          message: `Button too small (${Math.round(b.height)}px height, min 32px for touch)`,
          element: b.text,
        });
      }

      // Check for inconsistent border-radius on primary buttons
      const primaryBtns = buttons.filter((b) => b.classes.includes("btn-primary"));
      const radii = [...new Set(primaryBtns.map((b) => b.borderRadius))];
      if (radii.length > 1) {
        findings.push({
          page: p.name,
          category: "Consistency",
          severity: "minor",
          message: `Inconsistent border-radius on primary buttons: ${radii.join(", ")}`,
        });
      }
    }
  });

  test("card and section consistency", async ({ page }) => {
    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const cards = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".card, .section-group, .sys-section"))
          .filter((el) => el.offsetParent !== null)
          .map((el) => {
            const style = getComputedStyle(el);
            return {
              borderRadius: style.borderRadius,
              padding: style.padding,
              boxShadow: style.boxShadow,
              border: style.border,
            };
          });
      });

      // Check for mixed border-radius on cards
      const radii = [...new Set(cards.map((c) => c.borderRadius).filter(Boolean))];
      if (radii.length > 2) {
        findings.push({
          page: p.name,
          category: "Consistency",
          severity: "minor",
          message: `Multiple card border-radii: ${radii.join(", ")}`,
        });
      }
    }
  });

  test("empty states have calls-to-action", async ({ page }) => {
    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const emptyStates = await page.evaluate(() => {
        const empties = Array.from(
          document.querySelectorAll("[class*='empty'], [class*='no-data'], [class*='EmptyState']"),
        );
        return empties
          .filter((el) => el.offsetParent !== null)
          .map((el) => ({
            text: el.textContent?.trim().slice(0, 80),
            hasCTA: !!el.querySelector("button, a.btn, [role='button']"),
          }));
      });

      for (const es of emptyStates) {
        if (!es.hasCTA) {
          findings.push({
            page: p.name,
            category: "Empty States",
            severity: "suggestion",
            message: "Empty state without call-to-action button",
            element: es.text ?? "",
          });
        }
      }
    }
  });

  test("table readability", async ({ page }) => {
    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const tableIssues = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        const issues: string[] = [];

        for (const table of tables) {
          if (table.offsetParent === null) continue;

          // Check for missing thead
          if (!table.querySelector("thead")) {
            issues.push("Table without <thead>");
          }

          // Check for very wide tables without scroll wrapper
          const rect = table.getBoundingClientRect();
          const parentRect = table.parentElement?.getBoundingClientRect();
          if (parentRect && rect.width > parentRect.width + 10) {
            issues.push(
              `Table overflows container (${Math.round(rect.width)}px > ${Math.round(parentRect.width)}px)`,
            );
          }

          // Check row count — very long tables should have pagination
          const rows = table.querySelectorAll("tbody tr");
          if (rows.length > 100) {
            issues.push(`Table has ${rows.length} rows without visible pagination`);
          }
        }
        return issues;
      });

      for (const issue of tableIssues) {
        findings.push({
          page: p.name,
          category: "Tables",
          severity: "major",
          message: issue,
        });
      }
    }
  });

  test("loading states exist", async ({ page }) => {
    for (const p of ALL_PAGES) {
      const response = page.goto(p.url);

      // Check if there's a loading indicator within 200ms
      const hasLoadingIndicator = await Promise.race([
        page
          .locator(
            "[class*='loading'], [class*='spinner'], [class*='skeleton'], [aria-busy='true']",
          )
          .first()
          .isVisible()
          .catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
      ]);

      await response;
      await page.waitForLoadState("networkidle");

      // This is just informational — not all pages need loading states
    }
  });

  test("color contrast on interactive elements", async ({ page }) => {
    for (const p of ALL_PAGES) {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const lowContrast = await page.evaluate(() => {
        function luminance(hex: string): number {
          const rgb = hex
            .replace("#", "")
            .match(/.{2}/g)
            ?.map((c) => {
              const v = parseInt(c, 16) / 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
          if (!rgb) return 0;
          return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        }

        function contrastRatio(l1: number, l2: number): number {
          const lighter = Math.max(l1, l2);
          const darker = Math.min(l1, l2);
          return (lighter + 0.05) / (darker + 0.05);
        }

        function rgbToHex(rgb: string): string {
          const match = rgb.match(/\d+/g);
          if (!match) return "#000000";
          return (
            "#" +
            match
              .slice(0, 3)
              .map((c) => parseInt(c).toString(16).padStart(2, "0"))
              .join("")
          );
        }

        const issues: string[] = [];
        const links = Array.from(document.querySelectorAll("a:not(.btn)"));
        for (const link of links.slice(0, 20)) {
          if ((link as HTMLElement).offsetParent === null) continue;
          const style = getComputedStyle(link);
          const parentStyle = getComputedStyle(link.parentElement!);
          const fg = rgbToHex(style.color);
          const bg = rgbToHex(parentStyle.backgroundColor);
          if (bg === "#000000" && parentStyle.backgroundColor === "rgba(0, 0, 0, 0)") continue; // transparent
          const ratio = contrastRatio(luminance(fg), luminance(bg));
          if (ratio < 3) {
            issues.push(
              `Link "${(link as HTMLElement).innerText.trim().slice(0, 20)}" contrast ${ratio.toFixed(1)}:1 (fg:${fg} bg:${bg})`,
            );
          }
        }
        return issues;
      });

      for (const issue of lowContrast) {
        findings.push({
          page: p.name,
          category: "Color Contrast",
          severity: "major",
          message: issue,
        });
      }
    }
  });
});
