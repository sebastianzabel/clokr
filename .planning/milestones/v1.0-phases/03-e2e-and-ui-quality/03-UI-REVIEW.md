# Phase 03 — UI Review

**Audited:** 2026-04-10
**Baseline:** Abstract 6-pillar standards (no UI-SPEC.md)
**Screenshots:** Not captured (dev server on port 3000 detected but Playwright npx invocation ran in background — code-only audit used as primary evidence source)

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 3/4 | German strings thorough; bare "Fehler" fallbacks in 10+ catch blocks lack context |
| 2. Visuals | 3/4 | Clear page-title hierarchy; 171 inline style attrs add maintenance debt |
| 3. Color | 3/4 | Solid CSS-var token system; 4 hardcoded hex pairs in shutdowns bypass theme system |
| 4. Typography | 3/4 | CSS custom property font system; Tailwind `text-sm` and `font-medium` appear in markup (mixed system) |
| 5. Spacing | 4/4 | No arbitrary px/rem Tailwind values found; radius tokens used consistently |
| 6. Experience Design | 2/4 | 14 `alert()` calls replace toast system; bare "Fehler" gives users no recovery path |

**Overall: 18/24**

---

## Top 3 Priority Fixes

1. **`alert()` used for 14 error notifications** — Breaks the established toast design system, interrupts user flow with a browser-native modal, and is untestable by Playwright assertions. Replace all `alert(...)` calls in `admin/shutdowns/+page.svelte` (lines 152, 179, 190), `admin/system/+page.svelte` (lines 496, 507), `admin/shifts/+page.svelte` (lines 211, 283, 333), and `admin/employees/+page.svelte` (lines 165, 222, 224, 236, 246, 265) with `toasts.error("German message")` using descriptive action-specific messages.

2. **Bare "Fehler" catch fallback in 10+ locations** — When an API call fails and the server returns no message, users see only "Fehler" with no indication of what failed or what to do next. Replace with action-specific German strings: e.g. `"Einstellungen konnten nicht gespeichert werden"`, `"SMTP-Konfiguration konnte nicht gespeichert werden"`, `"Sonderurlaubsregel konnte nicht gelöscht werden"`. Files: `settings/+page.svelte:71`, `admin/special-leave/+page.svelte:67,95,108`, `admin/system/+page.svelte:356,382,409,432,453,476`.

3. **4 hardcoded hex color pairs in `shutdowns/+page.svelte` (lines 663–668)** — `#fef3c7 / #92400e` (amber) and `#dbeafe / #1d4ed8` (blue) are hardcoded in a scoped `<style>` block, bypassing all 4 themes. Under the `nacht` dark theme these will render light-on-light or dark-on-dark. Replace with `var(--color-yellow-bg) / var(--color-yellow)` and `var(--color-blue-bg, ...) / var(--color-blue)` from the token system defined in `app.css` lines 74–120.

---

## Detailed Findings

### Pillar 1: Copywriting (3/4)

**Strengths:**
- Contextual empty states throughout: "Keine Betriebsurlaube für {year} angelegt" (`shutdowns:249`), "Keine Einträge / Für die gewählten Filter wurden keine Audit-Einträge gefunden" (`audit:133-134`), "Keine Vorlagen vorhanden. Erstellen Sie zuerst eine Vorlage." (`shifts:384`).
- Locked-month error correctly implemented: "Monat ist gesperrt" in `time-entries/+page.svelte` catch block (Plan 01 delivery).
- Command palette empty state uses proper German typographic quotes: `„{query}"` (`CommandPalette.svelte:342`).

**Issues:**
- `"Fehler"` as a sole catch fallback appears 10 times across 4 files. This is a single-word non-actionable error; users cannot distinguish a network timeout from a validation failure from a server crash.
- `"Fehler beim Laden"` appears in shutdowns and system pages — slightly better but still lacks recovery instruction.
- Import page uses English status token `"ok"` as a display value (`import:268`): `{detail.status === "ok" ? "OK" : "Fehler"}`. The `"OK"` should be `"Erfolgreich"` or `"Verarbeitet"` per German UI convention.

### Pillar 2: Visuals (3/4)

**Strengths:**
- Consistent `page-header` + `page-title` pattern used across all admin pages.
- 4-theme system (`pflaume`, `nacht`, `wald`, `schiefer`) via `data-theme` attribute is well-structured in `app.css`.
- `EmptyState.svelte` component exists as a shared visual primitive.
- 62 `aria-label` attributes indicate reasonable accessibility intent on interactive elements.

**Issues:**
- 171 inline `style="..."` attribute instances across all pages. Inline styles cannot be overridden by themes, break the CSS variable cascade, and indicate layout logic that belongs in scoped `<style>` blocks or utility classes. E.g. `admin/audit/+page.svelte:95` and `admin/import/+page.svelte:114` use `style="margin-bottom:1.5rem"` directly on container divs.
- Heading level inconsistency: some pages use `<h1 class="page-title">` (settings, special-leave) while others use `<h2 class="page-title">` (shutdowns, monatsabschluss, shifts) for the same visual role. Screen readers will experience a broken outline.
- 17 icon-only button instances detected. Without verifying each has an `aria-label`, some may be invisible to assistive technology.

### Pillar 3: Color (3/4)

**Strengths:**
- 109 CSS custom property usages in `app.css` — fully token-based system.
- Named semantic tokens defined: `--color-brand`, `--color-text`, `--color-surface`, `--color-green`, `--color-yellow`, `--color-red`, `--color-blue` with paired `-bg` and `-border` variants.
- No Tailwind color utility classes (e.g. `text-primary`, `bg-primary`) anywhere in Svelte files — color system is entirely CSS variable based.
- `monatsabschluss/+page.svelte` status badges use CSS vars with hex fallbacks (`var(--red-50, #fef2f2)`) — acceptable pattern as the vars are undefined, fallbacks are used consistently.

**Issues:**
- `admin/shutdowns/+page.svelte:663-668`: Two hardcoded hex pairs with no CSS-var wrapper: `background: #fef3c7; color: #92400e` (amber badge) and `background: #dbeafe; color: #1d4ed8` (blue badge). These have no fallback to theme tokens and will break under dark themes.
- `admin/shutdowns/+page.svelte:775,792`: `var(--color-error, #dc2626)` — `--color-error` is not defined in `app.css`; the token should be `--color-red` per the established naming convention. Fix: rename to `var(--color-red)`.
- Total hardcoded hex instances in Svelte style blocks: ~20 (including monatsabschluss fallbacks). The fallback pattern `var(--token, #hex)` is reasonable when the token is defined, but several tokens referenced (`--red-50`, `--gray-200`, `--blue-500`, `--green-50`) are not in the design system.

### Pillar 4: Typography (3/4)

**Strengths:**
- No Tailwind font-size or font-weight utilities (`text-xl`, `font-bold`, etc.) are used systematically — the app uses a CSS custom property font system in `app.css`.
- The sole Tailwind size class found is `text-sm` (appearing in 4 files) and `font-medium` (7 occurrences) — both used sparsely and consistently for secondary text.

**Issues:**
- Mixed typography system: `app.css` defines a CSS-var font system while some components use Tailwind size tokens (`text-sm`) and weight tokens (`font-medium`). This creates two parallel systems. Since Tailwind v4 is installed but CSS-var approach is primary, Tailwind font classes should be removed in favour of CSS classes already defined in `app.css` (e.g. `.text-muted`, `.text-sm` utilities if defined).
- Font size distribution: only `text-sm` detected in markup Tailwind grep — the rest of sizing is likely handled in scoped `<style>` blocks, which is correct but makes a cross-app size audit impossible without reading every style block individually.

### Pillar 5: Spacing (4/4)

**Strengths:**
- Zero arbitrary `[Npx]` or `[Nrem]` Tailwind values found anywhere in Svelte source.
- Radius tokens `--radius-sm: 8px`, `--radius-md: 14px`, `--radius-lg: 22px` used consistently across 12+ style usages in `app.css`.
- Spacing is handled through scoped CSS `<style>` blocks with named values — no magic numbers visible in grep output.
- No problematic `overflow-x: hidden` on `html`/`body` per Phase 03 plan 03 analysis.

No significant spacing issues found. This is the strongest pillar in the codebase.

### Pillar 6: Experience Design (2/4)

**Strengths:**
- 167 loading-state references (`loading`, `isLoading`, `skeleton`, `Laden`) — strong coverage across async operations.
- 61 `disabled=` attributes — buttons are properly disabled during saves/deletes.
- 33 confirmation patterns (`Bestätigen`, `Wirklich`, `Ja`) — destructive actions have confirmation flows.
- 33 empty-state references with contextual German messages.
- 18 error-state references including `ErrorBoundary` patterns.
- Phase 03 deliverable: `expect(criticalFindings).toHaveLength(0)` now hard-fails CI on audit violations.

**Critical Issues:**
- **14 `alert()` calls** are used for error feedback in admin pages. Native browser alerts: block the main thread, cannot be styled, do not match the `Toast.svelte` component, cannot be dismissed via keyboard in all browsers, and are invisible to Playwright test assertions (E2E tests cannot assert on browser alert dialogs without special handling). Specific files and lines:
  - `admin/shutdowns/+page.svelte`: lines 152, 179, 190
  - `admin/system/+page.svelte`: lines 496, 507
  - `admin/shifts/+page.svelte`: lines 211, 283, 333
  - `admin/employees/+page.svelte`: lines 165, 222, 224, 236, 246, 265
- **Success feedback via `alert()`**: `admin/employees/+page.svelte:222` uses `alert("Einladung erneut gesendet.")` for a success state — a positive outcome should use `toasts.success()` not an alert.
- **No client-side error boundary** at the route level. If an uncaught exception occurs during page initialization, the page silently fails. A top-level `{#if error}...{/if}` guard or SvelteKit `+error.svelte` pages should be confirmed present.

---

## Registry Safety

`components.json` not found — shadcn not initialized. Registry audit skipped.

---

## Files Audited

**Global:**
- `apps/web/src/app.css` — theme system, CSS custom properties, spacing/radius tokens

**Components:**
- `apps/web/src/lib/components/ui/EmptyState.svelte`
- `apps/web/src/lib/components/ui/Toast.svelte`
- `apps/web/src/lib/components/ui/PasswordStrength.svelte`
- `apps/web/src/lib/components/ui/CommandPalette.svelte`
- `apps/web/src/lib/components/ui/Breadcrumb.svelte`

**App Pages:**
- `apps/web/src/routes/(app)/+layout.svelte`
- `apps/web/src/routes/(app)/dashboard/+page.svelte`
- `apps/web/src/routes/(app)/time-entries/+page.svelte`
- `apps/web/src/routes/(app)/leave/+page.svelte`
- `apps/web/src/routes/(app)/overtime/+page.svelte`
- `apps/web/src/routes/(app)/employees/+page.svelte`
- `apps/web/src/routes/(app)/reports/+page.svelte`
- `apps/web/src/routes/(app)/settings/+page.svelte`
- `apps/web/src/routes/(app)/admin/+layout.svelte`
- `apps/web/src/routes/(app)/admin/+page.svelte`
- `apps/web/src/routes/(app)/admin/employees/+page.svelte`
- `apps/web/src/routes/(app)/admin/shutdowns/+page.svelte`
- `apps/web/src/routes/(app)/admin/special-leave/+page.svelte`
- `apps/web/src/routes/(app)/admin/monatsabschluss/+page.svelte`
- `apps/web/src/routes/(app)/admin/system/+page.svelte`
- `apps/web/src/routes/(app)/admin/vacation/+page.svelte`
- `apps/web/src/routes/(app)/admin/audit/+page.svelte`
- `apps/web/src/routes/(app)/admin/import/+page.svelte`
- `apps/web/src/routes/(app)/admin/shifts/+page.svelte`

**Auth Pages:**
- `apps/web/src/routes/(auth)/login/+page.svelte`
- `apps/web/src/routes/(auth)/einladung/+page.svelte`
- `apps/web/src/routes/(auth)/forgot-password/+page.svelte`
- `apps/web/src/routes/(auth)/reset-password/+page.svelte`
- `apps/web/src/routes/(auth)/otp/+page.svelte`

**Audit method:** Static code analysis via grep on class patterns, string literals, inline style attributes, and CSS custom properties. Dev server detected on port 3000; Playwright screenshot capture initiated in background (results not used for scoring — code audit is primary).
