---
phase: 09-widget-menu-page-redesign-clockodeo
reviewed: 2026-04-13T12:00:00Z
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
  warning: 5
  info: 5
  total: 10
status: issues_found
---

# Phase 09: Code Review Report

**Reviewed:** 2026-04-13T12:00:00Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

This phase delivered a significant UI redesign across the sidebar layout, admin pages, dashboard, leave, and time-entries pages. The overall code quality is solid: CSS custom properties are used consistently, glass-morphism patterns follow the style guide, `card-animate` is applied where required, and Svelte 5 runes are used correctly throughout.

Five warnings and five info-level findings were identified. There are no critical (security, data-loss, or crash-level) issues. The most impactful findings are:

1. An inconsistent null-guard on `e.date` in the `arbzgDayMap` derived block that can throw at runtime when an entry lacks a `date` field.
2. `isAnonymized()` hardcodes the sentinel string `"Gelöscht"` making the detection fragile against future i18n or schema changes.
3. The Phorest `phSaved` success flag is never auto-reset, so the UI permanently shows "Gespeichert" after one save.
4. `pollDashboard()` is called unconditionally even for non-manager users, causing unnecessary API calls to `/dashboard/team-week`.
5. The `datevSaved` DATEV save also does not propagate errors to the audit trail — it only passes the four DATEV fields and silently drops the rest of the work settings, which could overwrite existing values.

---

## Warnings

### WR-01: Unsafe `e.date.split()` in `arbzgDayMap` derived block

**File:** `apps/web/src/routes/(app)/time-entries/+page.svelte:757`

**Issue:** Inside `arbzgDayMap`, the iteration over `entries` accesses `e.date.split("T")[0]` directly (no null guard), but throughout the same file all other access patterns use the defensive form `(e.date ?? e.startTime).split("T")[0]`. The `TimeEntry` interface declares `date: string` (non-optional), but NFC-sourced entries and clock-in/out entries historically omit the `date` field and rely on `startTime`. If such an entry reaches this code path it will throw `Cannot read properties of undefined (reading 'split')`, crashing the derived computation silently in Svelte 5.

**Fix:**
```typescript
// Line 757 — replace
const d = e.date.split("T")[0];
// with the same defensive pattern used elsewhere
const d = (e.date ?? e.startTime).split("T")[0];
```

---

### WR-02: `isAnonymized()` uses a hardcoded German sentinel string

**File:** `apps/web/src/routes/(app)/admin/employees/+page.svelte:80`

**Issue:** The function checks `emp.firstName === "Gelöscht"` to detect whether an employee has been anonymized. This matches the DSGVO anonymization spec in CLAUDE.md, but the detection is fragile: any employee legitimately named "Gelöscht" would be misclassified, the function would silently break if the backend sentinel ever changes, and it is not type-safe. Additionally, the function's result controls whether the "Endgültig löschen" button is rendered — a miscategorization could expose the hard-delete button for a real, non-anonymized employee.

**Fix:** Ask the API to return an explicit `isAnonymized: boolean` field (backed by a DB flag or computed from the known sentinel pattern server-side), and use that instead of the frontend string comparison. As a short-term guard at minimum add a comment and a second condition:
```typescript
function isAnonymized(emp: Employee): boolean {
  // Sentinel set by DELETE /employees/:id anonymization flow (CLAUDE.md)
  return emp.firstName === "Gelöscht" && emp.lastName.startsWith("GELÖSCHT-");
}
```

---

### WR-03: `phSaved` success indicator is never auto-reset — stays "Gespeichert" permanently

**File:** `apps/web/src/routes/(app)/admin/system/+page.svelte:596-615`

**Issue:** `savePhorest()` sets `phSaved = true` on success but never schedules a `setTimeout(() => (phSaved = false), 3000)` reset (unlike every other save function in the same file: `stateSaved`, `datevSaved`, `smtpSaved`, `sessionSaved`, `pwSaved`, `emailSaved` all reset after 3 s). The Phorest "Gespeichert" confirmation therefore remains visible indefinitely, misleading the user into thinking the config is still being saved or was just saved on a subsequent page visit.

**Fix:**
```typescript
async function savePhorest() {
  phSaving = true;
  phError = "";
  phSaved = false;
  try {
    await api.put("/integrations/phorest/config", { ... });
    phConfigured = true;
    phSaved = true;
    setTimeout(() => (phSaved = false), 3000); // add this line
  } catch (e: unknown) {
    phError = e instanceof Error ? e.message : "Fehler";
  } finally {
    phSaving = false;
  }
}
```

---

### WR-04: `pollDashboard()` fetches team-week data for non-manager users

**File:** `apps/web/src/routes/(app)/dashboard/+page.svelte:189,275`

**Issue:** `pollInterval = setInterval(pollDashboard, 5000)` is started unconditionally for all authenticated users in `onMount`. However `pollDashboard()` always calls `loadTeamWeek()`, which issues a `GET /dashboard/team-week` request. For regular employees this endpoint either returns empty data or a 403, causing a failed request every 5 seconds throughout the session.

**Fix:**
```typescript
async function pollDashboard() {
  if (isManager) await loadTeamWeek(); // only managers need team-week data
  // Also refresh clock-in status
  try { ... } catch { ... }
}
```
Or: only start the poll interval when `isManager` is true.

---

### WR-05: `saveDatev()` sends a partial `PUT /settings/work` payload that overwrites all other work settings with their defaults

**File:** `apps/web/src/routes/(app)/admin/system/+page.svelte:388-406`

**Issue:** `saveDatev()` calls `api.put("/settings/work", { datevNormalstundenNr, datevUrlaubNr, datevKrankNr, datevSonderurlaubNr })`. The API's `PUT /settings/work` is a full-replace operation (Zod-validated on the backend). Sending only four fields without the rest of the work config (federal state, timezone, weeklyHours, per-day hours, vacationDays, etc.) will either fail Zod validation (best case) or silently replace all other work settings with defaults (worst case, depending on how the backend validates partial bodies). The same endpoint is used by `saveFederalState()` which correctly spreads `_gOtherFields`. `saveDatev()` must do the same.

**Fix:**
```typescript
async function saveDatev() {
  if (!_gOtherFields) return; // guard same as saveFederalState
  datevSaving = true;
  datevError = "";
  datevSaved = false;
  try {
    await api.put("/settings/work", {
      ..._gOtherFields,
      federalState: gFederalState,
      timezone: gTimezone,
      datevNormalstundenNr,
      datevUrlaubNr,
      datevKrankNr,
      datevSonderurlaubNr,
    });
    datevSaved = true;
    setTimeout(() => (datevSaved = false), 3000);
  } catch (e: unknown) {
    datevError = e instanceof Error ? e.message : "Fehler";
  } finally {
    datevSaving = false;
  }
}
```

---

## Info

### IN-01: `import { self } from "svelte/legacy"` — legacy compatibility shim still in use

**File:** `apps/web/src/routes/(app)/time-entries/+page.svelte:2`, `apps/web/src/routes/(app)/admin/employees/+page.svelte:2`, `apps/web/src/routes/(app)/leave/+page.svelte:2`

**Issue:** These three files import `self` (and `preventDefault`) from `svelte/legacy`, which is the Svelte 4 compatibility shim. The import is used on modal backdrop `onclick={self(...)}` calls and form `onsubmit`. Svelte 5 natively handles the same patterns without a legacy shim. Using legacy helpers marks these components as "not fully migrated" and will require a migration pass before the Svelte 5 stable API is the only supported path.

**Fix:** Replace `onclick={self(() => (showCreateModal = false))}` with an inline guard checking the event target, e.g. `onclick={(e) => { if (e.target === e.currentTarget) showCreateModal = false; }}`. Replace `onsubmit={preventDefault(submitRequest)}` with `onsubmit={(e) => { e.preventDefault(); submitRequest(); }}`.

---

### IN-02: `isManager` computed once at module level in `leave/+page.svelte` — not reactive

**File:** `apps/web/src/routes/(app)/leave/+page.svelte:70`

**Issue:** `const isManager = ["ADMIN", "MANAGER"].includes($authStore.user?.role ?? "");` is computed as a plain `const` at module-script initialisation time. If the auth store is updated during the session (e.g. token refresh changes the role), this value will not update. All other pages in scope use `$derived(...)` for this check. This is a minor inconsistency but could matter if session re-elevation is ever implemented.

**Fix:**
```typescript
let isManager = $derived(["ADMIN", "MANAGER"].includes($authStore.user?.role ?? ""));
```

---

### IN-03: Audit log `<style>` block missing closing `</style>` tag newline — stray blank line

**File:** `apps/web/src/routes/(app)/admin/audit/+page.svelte:248-250`

**Issue:** There is a double blank line before the closing `</style>` tag (lines 248-249 are empty). This is a cosmetic inconsistency with no functional impact but will produce a Prettier diff on the next format pass.

**Fix:** Remove one of the two blank lines inside the `<style>` block before `</style>`.

---

### IN-04: Hardcoded chart grid colors bypass the theme system

**File:** `apps/web/src/routes/(app)/dashboard/+page.svelte:446,504,529,543`

**Issue:** Chart.js scale grid colors are hardcoded as `"#f3f4f6"` and `"#e5e7eb"` across all three charts. These are Tailwind gray-100/200 values that only match the light `lila` and `hell` themes. In the `dunkel` theme (dark background) the chart grids will appear as very light lines on a dark canvas, breaking visual consistency.

**Fix:** Read grid colors from CSS custom properties at chart instantiation time, the same way `brandColor` is already read:
```typescript
const gridColor = getComputedStyle(document.documentElement)
  .getPropertyValue("--color-border-subtle").trim() || "#f3f4f6";
```
Then use `gridColor` in all `grid: { color: ... }` options.

---

### IN-05: CSV import page — example CSV contains a plaintext password in sample data

**File:** `apps/web/src/routes/(app)/admin/import/+page.svelte:28-30`

**Issue:** The `exampleEmployees` template literal shown to users includes `Passwort1!` as the sample password value in the example CSV. While this is example data shown in a `<details>` hint block (not sent to the API), displaying example credentials in the UI trains administrators to think plaintext passwords in CSV are the expected format and may cause copy-paste of the example into real imports. A placeholder like `<sicheres-passwort>` would be clearer.

**Fix:**
```typescript
const exampleEmployees = `email;firstName;lastName;employeeNumber;hireDate;role;weeklyHours;password
max@firma.de;Max;Mustermann;1001;01.01.2024;EMPLOYEE;40;<optional-passwort>
anna@firma.de;Anna;Schmidt;1002;15.03.2024;MANAGER;38.5;`;
```

---

_Reviewed: 2026-04-13T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
