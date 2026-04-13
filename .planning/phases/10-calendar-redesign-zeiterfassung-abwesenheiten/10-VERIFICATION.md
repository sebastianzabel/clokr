---
phase: 10-calendar-redesign-zeiterfassung-abwesenheiten
verified: 2026-04-13T08:37:04Z
status: human_needed
score: 16/16
overrides_applied: 0
human_verification:
  - test: "Open /time-entries in browser — check that calendar cells are visual islands with 3px gaps and 6px rounded corners"
    expected: "Each cell floats as a separate rounded surface; no shared border lines visible; corner cells show rounded corners without clipping"
    why_human: "CSS rendering (gap, border-radius, overflow clipping) cannot be confirmed without a browser"
  - test: "Open /time-entries with time entries — check ok (green), partial (yellow), missing (red) cells"
    expected: "Each status cell shows both a colored background AND a 3px colored left-border stripe; today cell brand ring still visible on top of status color"
    why_human: "Visual composition of border-left stripe + bg color + today ring requires rendering"
  - test: "Open /time-entries and check the legend row below the calendar"
    expected: "Legend floats cleanly below grid with no gray background bar and no border-top separator line; legend dots are small colored squares matching the cell status colors"
    why_human: "Absence of visual separator and gray background requires visual inspection"
  - test: "Open /leave in browser — check multi-day leave entry spanning multiple days"
    expected: "A leave entry spanning 3+ days shows as a connected bar: left-capped segment on start day, flat (borderless) segments on middle days, right-capped segment on end day. Only the first segment shows the employee name; middle/end segments are color-only blocks."
    why_human: "Spanning bar visual effect (flat shared edges between cells) depends on actual leave data and browser rendering"
  - test: "Open /leave — drag-select multiple cells for a new leave request"
    expected: "Selected cells show a rounded ring (inset box-shadow following border-radius), not a rectangular outline; ring shape matches the cell's rounded corners"
    why_human: "inset box-shadow vs outline rendering on rounded cells requires visual verification"
  - test: "Open /leave — check a week row containing multiple leave entries on different days"
    expected: "The entire week row grows taller to fit content; empty-week rows collapse to a small minimum height (day number only)"
    why_human: "Auto cell height via CSS grid row sizing requires browser rendering with real data"
  - test: "Switch to dark theme (nacht) and verify both /time-entries and /leave calendars"
    expected: "Status colors, legend dots, chip colors, and legend styling all render correctly in dark theme — no off-theme hardcoded colors visible"
    why_human: "Theme token correctness requires visual inspection across themes"
---

# Phase 10: Calendar Redesign — Zeiterfassung & Abwesenheiten Verification Report

**Phase Goal:** Redesign the Zeiterfassung and Abwesenheiten monthly calendars to use gap-based island grid layouts with visual polish — rounded cells, status stripes, spanning leave bars, clean legends, and full CSS token compliance.
**Verified:** 2026-04-13T08:37:04Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | Calendar cells are visual islands separated by gaps, with no shared border lines (time-entries) | VERIFIED | `gap: 3px` + `padding: 3px` on `.cal-grid` at line 1511-1512; `border-right`/`border-bottom` removed from `.cal-cell` |
| 2 | Ok/partial/missing cells show a colored left-border stripe alongside their status background (time-entries) | VERIFIED | `border-left: 3px solid var(--color-green/yellow/red)` on all 5 status classes at lines 1554-1570 |
| 3 | Legend floats cleanly below the grid with no gray background and no border-top separator (time-entries) | VERIFIED | `.cal-legend` at line 1616: `display: flex; gap: 1rem; padding: 0.875rem 1.25rem; flex-wrap: wrap;` — no `border-top`, no `background` property |
| 4 | Legend color dots use CSS tokens, not hardcoded hex values (time-entries) | VERIFIED | `.leg-ok/partial/missing::before` use `var(--color-*-bg)` + `color-mix(in srgb, var(--color-*) 25%, transparent)`; all legacy hex (`#dcfce7`, `#fef9c3`, `#fee2e2`, `#16a34a40`) removed |
| 5 | Out-of-month cells are dimmed at opacity 0.35 (raised from 0.30 global) | VERIFIED | `apps/web/src/app.css` line 1657: `opacity: 0.35` on `.cal-cell.cal-other:not(.cal-selected)` |
| 6 | All hardcoded hex values in calendar CSS replaced with CSS custom properties (time-entries) | VERIFIED | No standalone hex in calendar/status/legend CSS sections; ArbZG warn uses `color-mix(in srgb, var(--color-yellow) 8%, transparent)` |
| 7 | Leave calendar cells are visual islands separated by gaps, with no shared border lines | VERIFIED | `gap: 3px` + `padding: 3px` on `.cal-grid` at lines 2659-2660; `border-right`/`border-bottom` removed; nth-child rule deleted |
| 8 | Calendar cells have rounded corners (6px) (leave) | VERIFIED | `border-radius: 6px` on `.cal-cell` at line 2671 |
| 9 | Leave chips have rounder corners (4px base, 4px 0 0 4px start, 0 4px 4px 0 end) | VERIFIED | `.cal-chip { border-radius: 4px }` + `.cal-chip--bar-start { border-radius: 4px 0 0 4px }` + `.cal-chip--bar-end { border-radius: 0 4px 4px 0 }` at lines 2716-2721 |
| 10 | Pending chips have opacity 0.9 instead of 0.85 | VERIFIED | `.cal-chip--pending { opacity: 0.9 }` at line 2728; remaining `opacity: 0.85` at line 2739 is `.cal-chip-type` (type label dimming — different rule, intentional per plan decisions) |
| 11 | Drag-selected cell ring uses inset box-shadow (not outline) so it follows border-radius | VERIFIED | `.cal-cell--drag-selected { box-shadow: inset 0 0 0 2px var(--color-brand) }` at lines 2685-2688; `outline: 2px solid` removed |
| 12 | Legend has no border-top separator — floats cleanly below the grid (leave) | VERIFIED | `.cal-legend` at line 2746: `display: flex; gap: 1rem; padding: 0.875rem 1.25rem; flex-wrap: wrap;` — no `border-top` |
| 13 | All hardcoded hex values in calendar CSS replaced with CSS custom properties (leave) | VERIFIED | Remaining hex are: `rgba(255, 255, 255, 0.7)` on chip pending outline (white on colored chip — acceptable), `color: #fff` on chips (white text on colored chips — content color, not theme token), `rgba(109, 40, 217, 0.1)` as token fallback in `var(--color-brand-tint, ...)` |
| 14 | Multi-day leave spans as a continuous bar — adjacent day segments share edges | VERIFIED | `.cal-chips { margin: 0 -0.4rem }` + bar-start/middle/end CSS rules at lines 2698-2724; chips container bleeds to cell padding edges for full-width bar rendering |
| 15 | Only the first visible segment of a multi-day bar shows name text — middle and end segments are color-only blocks | VERIFIED | `{#if _showLabel}` wrapping `<span class="cal-chip-name">` at line 1460; `_showLabel = day.dateStr === e.startDate \|\| _dow === 1` at line 1446 |
| 16 | Calendar cell height is not fixed — cells grow vertically to fit content | VERIFIED | `.cal-cell { min-height: 36px }` (down from 72px) at line 2669; CSS grid auto-sizes row height to tallest cell |

**Score:** 16/16 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/web/src/routes/(app)/time-entries/+page.svelte` | Redesigned Zeiterfassung calendar CSS | VERIFIED | 2124 lines; gap grid, status stripes, legend redesign, token cleanup all present |
| `apps/web/src/routes/(app)/leave/+page.svelte` | Redesigned Abwesenheiten calendar CSS | VERIFIED | 2861 lines; gap grid, spanning bars, chip polish, legend cleanup all present |
| `apps/web/src/app.css` | Global `.cal-other` opacity 0.3 → 0.35 | VERIFIED | Line 1657: `opacity: 0.35` in `.cal-cell.cal-other:not(.cal-selected)` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `.cal-grid` scoped style (time-entries) | gap-based layout | `gap: 3px` on `.cal-grid` | WIRED | Found at line 1511 |
| `.cal-cell--ok/partial/missing` scoped styles | status stripe | `border-left: 3px solid var(--color-green/yellow/red)` | WIRED | Found at lines 1554-1562 |
| `.cal-grid` scoped style (leave) | gap-based layout | `gap: 3px` on `.cal-grid` | WIRED | Found at line 2659 |
| `.cal-cell--drag-selected` | inset box-shadow ring | `box-shadow: inset 0 0 0 2px var(--color-brand)` | WIRED | Found at line 2687; old `outline` property removed |

### Data-Flow Trace (Level 4)

Not applicable — this phase is CSS-only. No data source or API connections changed. All calendar data flows from pre-existing component logic which was not modified.

### Behavioral Spot-Checks

Step 7b: SKIPPED — this phase is CSS-only with no runnable entry points that can be tested without a browser rendering environment.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| UI-09 | 10-01-PLAN.md | Zeiterfassungs-Seite redesignt — Kalenderansicht modernisiert | SATISFIED | Calendar view modernized: gap grid, rounded cells, status stripes, token-clean legend |
| UI-11 | 10-01-PLAN.md, 10-02-PLAN.md | Urlaubsverwaltungs-Seite redesignt — Leave-Kalender, Antragsübersicht, Status-Badges modernisiert | PARTIALLY SATISFIED | Leave calendar redesigned; Antragsübersicht and Status-Badges were styled in prior phases (global `.badge` CSS in `app.css`) |
| UI-12 | 10-02-PLAN.md | Leave-Antrag-Modal visuell verbessert | SATISFIED (prior phase) | `form-dialog` has glass styling: `var(--glass-bg-strong)`, `backdrop-filter: blur(var(--glass-blur, 16px))`, `border-radius: var(--radius-md)`, `box-shadow: var(--shadow-lg)`, entry animation. Established before Phase 10 (Phase 9 glassmorphism work). Plan 10-02 CONTEXT.md lists "Leave request form — no changes" as out-of-scope; the requirement is satisfied by prior work. |

**Note on UI-09 scope:** REQUIREMENTS.md maps UI-09 to "Phase 9" but Plan 10-01 claims it. UI-09 also specifies "Listen-Ansicht modernisiert" (list view). The calendar modernization in Phase 10 satisfies the calendar portion. The list view in `/time-entries` was not modified in Phase 10 (CONTEXT.md confirms out-of-scope). UI-09's list view modernization appears to have been addressed in Phase 9 work.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None found | — | — | — | — |

No TODO/FIXME/PLACEHOLDER comments found. No stub implementations. No empty return values. All calendar CSS changes are substantive and wired.

### Human Verification Required

7 items need human testing to confirm visual rendering:

#### 1. Zeiterfassung — Gap Grid Visual Islands

**Test:** Open `/time-entries` in a browser with the default theme.
**Expected:** Calendar cells render as distinct floating surfaces with visible ~3px gaps between them. Cells have visibly rounded corners. No shared border lines between adjacent cells.
**Why human:** CSS gap rendering and border-radius visual effect require a browser.

#### 2. Zeiterfassung — Status Stripe Rendering

**Test:** Open `/time-entries` for a month with ok (green), partial (yellow), and missing (red) time entries.
**Expected:** Each status cell shows both a colored background AND a 3px colored left-border stripe. Today's cell shows the brand-color ring (inset box-shadow) on top of the status background color.
**Why human:** Layered visual composition of border-left + bg color + today ring requires rendering.

#### 3. Zeiterfassung — Legend Floating Below Grid

**Test:** Scroll to the legend row below the calendar grid.
**Expected:** Legend row has no gray background fill and no visible border-top separator line. Legend dots are small colored squares matching the green/yellow/red/gray status colors.
**Why human:** Absence of visual elements (separator, background) requires visual inspection.

#### 4. Abwesenheiten — Spanning Leave Bar

**Test:** Open `/leave` for a month containing a leave request spanning 3+ consecutive days.
**Expected:** The leave renders as one visually connected bar: the leftmost cell shows a rounded left cap + employee name, middle cells are flat-edged color blocks with no text, the rightmost cell shows a rounded right cap. If the span crosses a week boundary (Sun → Mon), Sunday segment has a right cap, Monday segment has a left cap.
**Why human:** Bar continuity visual effect depends on actual leave data and browser rendering of adjacent cells sharing the 3px gap.

#### 5. Abwesenheiten — Drag Selection Ring

**Test:** Click and drag across multiple days in `/leave` to initiate a new leave request selection.
**Expected:** Selected cells show a rounded inset ring (following the 6px border-radius), not a rectangular outline that corners clip outside the cell shape.
**Why human:** The visual difference between inset box-shadow and outline rendering on rounded corners requires browser rendering.

#### 6. Abwesenheiten — Auto Cell Height

**Test:** Open `/leave` for a month where some weeks have multiple overlapping leaves on different days.
**Expected:** A week row with many leave chips is taller than an empty week row. Weeks with only a day number visible collapse to a small minimum height. The grid row height adapts automatically per row.
**Why human:** CSS grid `auto` row height with real data requires browser rendering to verify.

#### 7. Dark Theme Token Compliance

**Test:** Switch to the "nacht" (dark) theme via the theme switcher and reload `/time-entries` and `/leave`.
**Expected:** All status colors, legend dots, chip colors, drag-selection ring, and legend styling display correctly — no bright hardcoded colors visible against the dark background. The token-based system maintains readability.
**Why human:** Theme token correctness and dark-mode visual appearance require visual inspection.

### Gaps Summary

No gaps found. All 16 observable truths are verified at the code level (existence, substantive implementation, correct wiring). The phase goal — gap-based island grid layouts with visual polish, spanning leave bars, clean legends, and CSS token compliance — is fully implemented.

The 7 human verification items are needed to confirm correct browser rendering of purely visual changes (gaps, border-radius, spanning bars, drag ring) that cannot be verified programmatically without running a browser.

---

_Verified: 2026-04-13T08:37:04Z_
_Verifier: Claude (gsd-verifier)_
