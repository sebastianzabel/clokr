/**
 * Issue #83 (D-02) — the German labels of the permission catalog cannot drift.
 *
 * The label set must equal the catalog in both directions: a key without a label would render
 * empty in the role editor, an extra label would name a permission no route checks. The group
 * headings are pinned to the resource headings of `docs/permissions.md` — that document is the
 * reviewed source of the group names and is itself pinned to the code by `system-roles.test.ts`
 * and `permission-site-mapping.test.ts`. DB-free.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { PERMISSIONS, PERMISSION_RESOURCES, permissionKey } from "../permission-catalog";
import {
  PERMISSION_LABELS,
  PERMISSION_RESOURCE_LABELS,
  permissionCatalogGroups,
} from "../permission-labels";

// __dirname is apps/api/src/contexts/platform/__tests__ — six levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const byText = (a: string, b: string) => a.localeCompare(b);
const RAW_KEY = /^[a-z0-9-]+:[a-z-]+:(EIGENE|ZUGEWIESEN)$/;

describe("permission labels (Issue #83, D-02)", () => {
  const catalogKeys: string[] = PERMISSIONS.map(permissionKey);
  const labelKeys = Object.keys(PERMISSION_LABELS);

  it("has exactly one label per catalog key — none missing, none extra", () => {
    expect(PERMISSIONS.length).toBeGreaterThan(50);
    const missing = catalogKeys.filter((key) => !labelKeys.includes(key));
    const extra = labelKeys.filter((key) => !catalogKeys.includes(key));
    expect(missing, `keys without a label: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `labels without a catalog key: ${extra.join(", ")}`).toEqual([]);
    expect(labelKeys).toHaveLength(PERMISSIONS.length);
  });

  it("has exactly one heading per resource", () => {
    expect(Object.keys(PERMISSION_RESOURCE_LABELS).sort(byText)).toEqual(
      Object.keys(PERMISSION_RESOURCES).sort(byText),
    );
  });

  it("labels are unique, trimmed, non-empty and never a raw key", () => {
    for (const labels of [
      Object.values(PERMISSION_LABELS),
      Object.values(PERMISSION_RESOURCE_LABELS),
    ]) {
      expect(new Set(labels).size).toBe(labels.length);
      for (const label of labels) {
        expect(label.trim()).toBe(label);
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toMatch(RAW_KEY);
        expect(label).not.toMatch(/:(EIGENE|ZUGEWIESEN)/);
      }
    }
  });

  it("group headings equal the resource headings of docs/permissions.md", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "permissions.md"), "utf8");
    const headings = [...doc.matchAll(/^### `([a-z0-9-]+)` — (.+)$/gm)].map(
      ([, resource, heading]) => [resource, heading.trim()] as const,
    );
    expect(headings).toHaveLength(Object.keys(PERMISSION_RESOURCES).length);
    expect(Object.fromEntries(headings)).toEqual(PERMISSION_RESOURCE_LABELS);
  });

  it("permissionCatalogGroups() keeps the catalog order, one group per resource", () => {
    const groups = permissionCatalogGroups();
    expect(groups.map((g) => g.resource)).toEqual(Object.keys(PERMISSION_RESOURCES));
    expect(groups.flatMap((g) => g.permissions.map((p) => p.key))).toEqual(catalogKeys);
  });
});
