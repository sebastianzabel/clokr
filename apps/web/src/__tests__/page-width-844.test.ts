// Issue #844 (owner 09.11.2026) — a page's width is chosen ONLY by the route table: the app layout's page frame
// applies `read` (1120 px) or `full` (2400 px). No route page sets its own content max-width of 1000 px or more
// (media queries do not count), and the layout keeps no fixed width of its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES = resolve(process.cwd(), "src/routes/(app)");

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name.endsWith(".svelte") ? [path] : [];
  });
}

const FILES = pages(ROUTES);
const WIDE = /(^|[^-(])max-width:\s*(\d{4,})px/g;

describe("page widths come from the route table (#844)", () => {
  it("walks the (app) route files (non-vacuity)", () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  it("no route file sets a content max-width of 1000 px or more", () => {
    const hits = FILES.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(WIDE)].map((m) => `${file}: ${m[0].trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("the layout frames the page with the table's width and nothing else", () => {
    const layout = readFileSync(join(ROUTES, "+layout.svelte"), "utf8");
    expect(layout).toContain("pageWidthForPath(currentPath)");
    expect(layout).toContain("data-width={pageWidth}");
    expect(layout).toContain("max-width: var(--page-read)");
    expect(layout).toContain("max-width: var(--page-full)");
  });
});
