// Issue #854 (D-854-09, AC-2, AC-5) - source pin of the Personen list's selection and bulk changes.
// The page imports `$app/navigation` and fires requests on mount, so it is source-read like
// `admin-employees-salon-558.test.ts`. Pinned: the list is selectable; both bulk changes run behind
// the BulkPreviewDialog, through the existing endpoints and `runPerPerson`; each is offered only to
// the holder of the permission its endpoint needs; the CSV carries the list's own columns.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/admin/employees/+page.svelte",
  "src/routes/(app)/admin/employees/+page.svelte",
);

/** The text of the `{#if …}` line that precedes the button carrying `testId`. */
function guardOf(testId: string): string {
  const at = PAGE.indexOf(`data-testid="${testId}"`);
  expect(at, `no element with data-testid ${testId}`).toBeGreaterThan(-1);
  const before = PAGE.slice(0, at);
  return before.slice(before.lastIndexOf("{#if"), before.lastIndexOf("<button"));
}

describe("#854 /admin/employees selection and bulk changes", () => {
  it("[floor] the walked source is the real page", () => {
    expect(PAGE.length).toBeGreaterThan(10_000);
  });

  it("[selection] the table is selectable and keeps its selection in a bound state", () => {
    // #854: the page renders the shared PersonenTable, which hands the selection to DataTable.
    const start = PAGE.indexOf("<PersonenTable\n");
    const element = PAGE.slice(start, PAGE.indexOf("{#snippet", start));
    expect(start).toBeGreaterThan(-1);
    expect(element).toContain("selectable");
    expect(element).toContain("bind:selectedKeys={selectedIds}");
    const TABLE = readRouteFile(
      "../lib/components/employees/PersonenTable.svelte",
      "src/lib/components/employees/PersonenTable.svelte",
    );
    expect(TABLE).toMatch(/selectedKeys = \$bindable\(\[\]\)/);
    const table = TABLE.slice(TABLE.indexOf("<DataTable\n"), TABLE.indexOf("{#snippet toolbar"));
    expect(table).toContain("{selectable}");
    expect(table).toContain("bind:selectedKeys");
  });

  it("[preview] both bulk changes run behind the BulkPreviewDialog, one person after the other", () => {
    expect(PAGE).toContain('from "$components/ui/BulkPreviewDialog.svelte"');
    expect(PAGE).toContain("<BulkPreviewDialog");
    expect(PAGE).toContain("runPerPerson(");
    // The run is only reachable from the preview's confirm.
    expect(PAGE).toMatch(/<BulkPreviewDialog[\s\S]*?onConfirm=\{runBulk\}/);
    expect(PAGE).not.toMatch(/onclick=\{runBulk\}/);
  });

  it("[endpoints] the existing per-person endpoints, no bulk endpoint", () => {
    expect(PAGE).toContain("/resend-invitation");
    expect(PAGE).toContain("createRoleAssignment(");
    expect(PAGE).not.toMatch(/["'`]\/(employees|role-assignments)\/bulk\b/);
  });

  it("[rights] each bulk action is offered only to the holder of the permission its endpoint needs", () => {
    expect(guardOf("admin-employees-bulk-invite")).toContain("canManageAccess");
    expect(guardOf("admin-employees-bulk-role")).toContain("canAssignRoles");
    expect(PAGE).toMatch(/canManageAccess\s*=\s*\$derived\(rights\.canManageAccess\)/);
    expect(PAGE).toMatch(/canAssignRoles\s*=\s*\$derived\(rights\.canAssignRoles\)/);
  });

  it("[summary] one summary toast per run and the failed rows stay selected", () => {
    expect(PAGE).toContain("bulkSummaryText(");
    expect(PAGE).toMatch(/selectedIds\s*=\s*result\.failed\.map/);
  });

  it("[csv] the export writes the table's own columns without the „Öffnen“ column", () => {
    expect(PAGE).toContain("rowsToCsv(EXPORT_COLUMNS, records)");
    const block = PAGE.slice(
      PAGE.indexOf("const EXPORT_COLUMNS"),
      PAGE.indexOf("function exportSelectedCsv"),
    );
    for (const label of [
      "Name",
      "Personalnummer",
      "Stammsalon",
      "Vertrag",
      "Std./Woche",
      "Rollen",
      "Status",
    ]) {
      expect(block, label).toContain(`label: "${label}"`);
    }
    expect(block).not.toMatch(/E-Mail|Login|"open"/);
    expect(PAGE).toContain("personen-${today}.csv");
  });
});
