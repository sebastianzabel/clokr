---
phase: 260411-de4
plan: 01
subsystem: web-ui
tags: [pagination, ui, svelte5, accessibility]
dependency_graph:
  requires: []
  provides: [Pagination.svelte, paginated-list-views]
  affects: [admin/employees, leave, admin/vacation, reports, overtime, admin/shutdowns, admin/special-leave, admin/shifts, admin/monatsabschluss, admin/audit]
tech_stack:
  added: []
  patterns: [client-side-pagination, server-side-pagination-callback, svelte5-bindable-props]
key_files:
  created:
    - apps/web/src/lib/components/ui/Pagination.svelte
  modified:
    - .planning/UI_STYLE_GUIDE.md
    - apps/web/src/routes/(app)/admin/employees/+page.svelte
    - apps/web/src/routes/(app)/leave/+page.svelte
    - apps/web/src/routes/(app)/admin/vacation/+page.svelte
    - apps/web/src/routes/(app)/reports/+page.svelte
    - apps/web/src/routes/(app)/overtime/+page.svelte
    - apps/web/src/routes/(app)/admin/shutdowns/+page.svelte
    - apps/web/src/routes/(app)/admin/special-leave/+page.svelte
    - apps/web/src/routes/(app)/admin/shifts/+page.svelte
    - apps/web/src/routes/(app)/admin/monatsabschluss/+page.svelte
    - apps/web/src/routes/(app)/admin/audit/+page.svelte
decisions:
  - "Used unique variable names per page (vacPage, txPage, sdPage, etc.) to avoid naming conflicts — leave page has $app/stores 'page' import; using currentPage/currentPageSize"
  - "Used explicit type annotation for reportRows ($derived) to work around TypeScript narrowing issue with MonthlyReport | null in Svelte rune context"
  - "Pagination auto-hides when total <= 10 (smallest pageSizeOptions); no showWhenSinglePage needed for list views"
  - "Shutdowns Pagination placed outside {#each} wrapper div since shutdown-list is a card-list, not a table"
metrics:
  duration: "~30 minutes"
  completed: "2026-04-11T07:52:00Z"
  tasks: 3
  files: 12
---

# Phase 260411-de4 Plan 01: Pagination for All List Views Summary

Reusable `Pagination.svelte` component (Svelte 5 runes, bindable, themed) wired into all 10 list views with 10/25/50 rows-per-page dropdown, prev/next navigation, and server-side onChange mode for the audit log.

## What Was Built

### Pagination.svelte Component

**Path:** `apps/web/src/lib/components/ui/Pagination.svelte`

**API:**
```ts
interface Props {
  total: number;
  page?: number;                   // bindable, default 1
  pageSize?: number;               // bindable, default 10
  pageSizeOptions?: number[];      // default [10, 25, 50]
  labelSingular?: string;          // default "Eintrag"
  labelPlural?: string;            // default "Einträge"
  showWhenSinglePage?: boolean;    // default false
  onChange?: (p: { page: number; pageSize: number }) => void;
}
```

**Features:**
- Auto-hides when `total <= pageSizeOptions[0]` (10)
- Clamps page when pageSize increases and page exceeds totalPages
- Range display: "1–10 von 45 Einträge" (German, en-dash, monospace numbers)
- Prev/Next buttons (`btn btn-sm btn-ghost`), disabled at boundaries
- Rows-per-page `<select>` resets page to 1 on change, calls onChange
- Accessible: `<nav aria-label="Seitennavigation">`, `aria-live="polite"` on range, `aria-current="page"` on indicator
- Fully themed — only CSS custom properties, no hardcoded hex
- Responsive: wraps to vertical on mobile (< 480px)

### Files Modified

| File | Change |
|------|--------|
| `apps/web/src/lib/components/ui/Pagination.svelte` | Created (new component) |
| `.planning/UI_STYLE_GUIDE.md` | Added `## Pagination` section with Props, usage, and rules |
| `admin/employees/+page.svelte` | pagedEmployees, reset on filter change |
| `leave/+page.svelte` | pagedMyRequests (my-requests tab only, not approvals queue) |
| `admin/vacation/+page.svelte` | pagedVacationEmployees for per-employee work schedule table |
| `reports/+page.svelte` | pagedReportRows (resets when monthlyReport changes) |
| `overtime/+page.svelte` | pagedTransactions with txType filter reset |
| `admin/shutdowns/+page.svelte` | pagedShutdowns (card-list, not table) |
| `admin/special-leave/+page.svelte` | pagedRules |
| `admin/shifts/+page.svelte` | pagedTemplates for template management panel only |
| `admin/monatsabschluss/+page.svelte` | pagedMonths with statusFilter reset |
| `admin/audit/+page.svelte` | Server-side mode: LIMIT removed, pageSize bindable, onChange reloads |

### Before vs After

**Before:** All list views rendered the full filtered array — unbounded tables with 50, 100, or more rows on large datasets.

**After:** Default 10 rows per page. Dropdown switches to 25 or 50. Prev/Next navigates pages. Filter changes reset to page 1 automatically. Audit log makes server-side requests with updated limit/page parameters.

## Commits

| Hash | Task |
|------|------|
| `8c19718` | Task 1: Create Pagination component + document in style guide |
| `afd1728` | Task 2: Wire Pagination into primary client-side list views |
| `0b348fa` | Task 3: Wire Pagination into remaining list views + upgrade audit page |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript narrowing issue with MonthlyReport | null in $derived**
- **Found during:** Task 2 (reports page)
- **Issue:** `$derived(monthlyReport ? monthlyReport.rows : [])` caused svelte-check to report "Property 'rows' does not exist on type 'never'" due to TypeScript narrowing in Svelte rune context
- **Fix:** Used explicit type annotation `let reportRows: MonthlyRow[] = $derived(monthlyReport !== null ? (monthlyReport as MonthlyReport).rows : [])` then derived the paged slice from `reportRows`
- **Files modified:** `apps/web/src/routes/(app)/reports/+page.svelte`
- **Commit:** `afd1728`

### Naming Conflicts Handled

- `leave/+page.svelte` already imports `page` from `$app/stores` (used as `$page.url.searchParams`) — pagination state uses `currentPage` and `currentPageSize` instead, with explicit `bind:page={currentPage}` bindings
- Each page uses unique prefix variable names (`vacPage`, `txPage`, `sdPage`, `slPage`, `tplPage`, `maPage`) to prevent any future cross-file confusion

## Known Stubs

None. All pagination is wired to real data sources.

## Threat Flags

None. Pagination is purely client-side state management (slicing arrays) or passes the existing `page`/`limit` query parameters through the existing audit API endpoint. No new network surface introduced.

## Self-Check: PASSED

Files created/verified:
- `apps/web/src/lib/components/ui/Pagination.svelte` — exists
- `.planning/UI_STYLE_GUIDE.md` — contains `## Pagination` section
- All 10 list views — modified and committed

Commits verified:
- `8c19718` — exists
- `afd1728` — exists
- `0b348fa` — exists

svelte-check: 13 errors (all pre-existing, none from this plan's changes)
