---
phase: 09-widget-menu-page-redesign-clockodeo
reviewed: 2026-04-13T13:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - apps/web/src/app.css
  - apps/web/src/routes/(app)/+layout.svelte
  - apps/web/src/routes/(app)/admin/+layout.svelte
  - apps/web/src/routes/(app)/admin/audit/+page.svelte
  - apps/web/src/routes/(app)/admin/employees/+page.svelte
  - apps/web/src/routes/(app)/admin/import/+page.svelte
  - apps/web/src/routes/(app)/admin/system/+page.svelte
  - apps/web/src/routes/(app)/dashboard/+page.svelte
  - apps/web/src/routes/(app)/leave/+page.svelte
  - apps/web/src/routes/(app)/time-entries/+page.svelte
findings:
  critical: 0
  warning: 0
  info: 4
  total: 4
status: issues_found
---

# Phase 09: Code Review Report (Re-Review)

**Reviewed:** 2026-04-13T13:00:00Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

This is the re-review pass after fixes were applied per 09-REVIEW-FIX.md. All five warnings from the initial review (WR-01 through WR-05) have been correctly applied and are confirmed resolved:

- **WR-01** (unsafe `e.date.split()` in `arbzgDayMap`): Fixed — line 757 of `time-entries/+page.svelte` now uses `(e.date ?? e.startTime).split("T")[0]`.
- **WR-02** (`isAnonymized()` hardcoded sentinel): Fixed — `employees/+page.svelte` line 81 now checks both `firstName === "Gelöscht"` and `lastName.startsWith("GELÖSCHT-")`.
- **WR-03** (`phSaved` never reset): Fixed — `system/+page.svelte` line 615 now has `setTimeout(() => (phSaved = false), 3000)`.
- **WR-04** (`pollDashboard` unconditional team-week fetch): Fixed — `dashboard/+page.svelte` line 276 guards `loadTeamWeek()` with `if (isManager)`.
- **WR-05** (`saveDatev()` partial payload): Fixed — `system/+page.svelte` lines 388-410 now spread `_gOtherFields` and include the `if (!_gOtherFields) return` guard.

No new critical or warning-level issues were found in this pass. Four info-level items remain from the prior review (IN-01 through IN-05 were not in scope for the fix pass) plus one new observation noted below.

---

## Info

### IN-01: `import { self } from "svelte/legacy"` — legacy compatibility shim still in use

**File:** `apps/web/src/routes/(app)/time-entries/+page.svelte:1`, `apps/web/src/routes/(app)/admin/employees/+page.svelte:1`, `apps/web/src/routes/(app)/leave/+page.svelte:1`

**Issue:** Three files import `self` (and `preventDefault`) from `svelte/legacy`, the Svelte 4 compatibility shim. These imports are used on modal backdrop `onclick` and form `onsubmit` handlers. Svelte 5 provides native equivalents without the legacy shim. These files are not fully migrated to the Svelte 5 event handling model.

**Fix:** Replace `onclick={self(() => (showModal = false))}` with an inline target guard:
```typescript
onclick={(e) => { if (e.target === e.currentTarget) showModal = false; }}
```
Replace `onsubmit={preventDefault(submitFn)}` with:
```typescript
onsubmit={(e) => { e.preventDefault(); submitFn(); }}
```

---

### IN-02: `isManager` computed once at module level in `leave/+page.svelte` — not reactive

**File:** `apps/web/src/routes/(app)/leave/+page.svelte:70`

**Issue:** `const isManager = ["ADMIN", "MANAGER"].includes($authStore.user?.role ?? "");` is a plain `const` evaluated once at script-initialization time. All other pages in scope compute this via `$derived(...)`. If the auth store is mutated during the session (e.g. after a token refresh that carries a new role claim) this value will be stale.

**Fix:**
```typescript
let isManager = $derived(["ADMIN", "MANAGER"].includes($authStore.user?.role ?? ""));
```

---

### IN-03: Hardcoded chart grid and dataset colors bypass the theme system

**File:** `apps/web/src/routes/(app)/dashboard/+page.svelte:432,446,504,522,529,543`

**Issue:** Chart.js scale grid colors are hardcoded as `"#f3f4f6"` and `"#e5e7eb"` (Tailwind gray-100/200), and the `Soll (h)` bar dataset background is hardcoded as `"#e5e7eb"`. These values match only the light `lila` / `hell` themes. In the `dunkel` (dark) theme, chart grid lines appear as light lines on a dark canvas and the "Soll" bar blends into the background, breaking visual consistency.

**Fix:** Read grid and neutral colors from CSS custom properties at chart instantiation time, the same way `brandColor` is already read:
```typescript
const gridColor = getComputedStyle(document.documentElement)
  .getPropertyValue("--color-border-subtle").trim() || "#f3f4f6";
const mutedColor = getComputedStyle(document.documentElement)
  .getPropertyValue("--color-bg-muted").trim() || "#e5e7eb";
```
Use `gridColor` for all `grid: { color: ... }` options and `mutedColor` for the "Soll" dataset `backgroundColor`.

---

### IN-04: CSV import example contains a plaintext password in sample data

**File:** `apps/web/src/routes/(app)/admin/import/+page.svelte:28`

**Issue:** The `exampleEmployees` template literal displayed in the `<details>` hint block includes `Passwort1!` as the sample password value. While this is example-only content (never sent to the API), displaying a real-looking password in the UI trains administrators to expect plaintext passwords in CSV and may lead to copy-paste of the example into a real import. A placeholder would be clearer and safer.

**Fix:**
```typescript
const exampleEmployees = `email;firstName;lastName;employeeNumber;hireDate;role;weeklyHours;password
max@firma.de;Max;Mustermann;1001;01.01.2024;EMPLOYEE;40;<optional-passwort>
anna@firma.de;Anna;Schmidt;1002;15.03.2024;MANAGER;38.5;`;
```

---

_Reviewed: 2026-04-13T13:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
