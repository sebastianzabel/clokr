---
phase: 08-design-system-foundation
plan: "01"
subsystem: web/css
tags: [glass-tokens, glassmorphism, accessibility, css-custom-properties]
dependency_graph:
  requires: []
  provides:
    - "Glass token system with 10 tokens in :root (replaces 5)"
    - "body::before radial-gradient backdrop for blur visibility"
    - "@supports fallback for browsers without backdrop-filter"
    - "prefers-reduced-transparency a11y media query"
  affects:
    - ".card, .stat-card, .dialog-content consumers via CSS variable inheritance"
    - "Toast.svelte overlay background"
tech_stack:
  added: []
  patterns:
    - "body::before pseudo-element for glassmorphism backdrop"
    - "@supports not (backdrop-filter) progressive enhancement pattern"
    - "CSS custom property fallback chaining: var(--token, var(--fallback))"
key_files:
  created: []
  modified:
    - apps/web/src/app.css
    - apps/web/src/lib/components/ui/Toast.svelte
decisions:
  - "--glass-bg-strong removed from :root block; overlay consumers use --glass-bg-overlay with solid fallback"
  - "body::before opacity baked into rgba (0.10) not via separate opacity property to avoid stacking context issues"
  - "transition on :root covers theme-switch animation (200ms ease)"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-12"
  tasks_completed: 3
  tasks_total: 3
  files_modified: 2
---

# Phase 08 Plan 01: Glass Token System Foundation Summary

Glass token overhaul enabling real glassmorphism — reduced alpha from 0.97 to 0.76, added 6 new tokens, body::before gradient backdrop, @supports fallback, and prefers-reduced-transparency a11y query.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add 6 new glass tokens, reduce glass-bg alpha, body::before gradient | a191668 | apps/web/src/app.css |
| 2 | Add @supports fallback and prefers-reduced-transparency media query | 514e7a2 | apps/web/src/app.css |
| 3 | Fix Toast.svelte — replace var(--glass-bg-strong) with fallback-safe token | 8965e96 | apps/web/src/lib/components/ui/Toast.svelte |

## What Was Built

### Glass Token Overhaul (app.css :root block)

**Replaced 5 old tokens with 10 new tokens:**

| Token | Old Value | New Value |
|-------|-----------|-----------|
| `--glass-bg` | `rgba(255,255,255,0.97)` | `rgba(255,255,255,0.76)` |
| `--glass-bg-strong` | `rgba(255,255,255,0.99)` | removed |
| `--glass-border` | `rgba(128,55,123,0.08)` | `rgba(128,55,123,0.10)` |
| `--glass-blur` | `20px` | `16px` |
| `--glass-shadow` | `...0.08, ...0.04` | `...0.10, ...0.05` |

**6 new tokens added:**
- `--glass-bg-subtle: rgba(255,255,255,0.55)` — layered/nested surfaces
- `--glass-bg-overlay: rgba(250,249,247,0.90)` — modals and overlays
- `--glass-saturate: 160%` — backdrop-filter saturate value
- `--glass-highlight: rgba(255,255,255,0.60)` — top-edge inset highlight
- `--glass-border-light: rgba(255,255,255,0.50)` — inner card separators
- `--glass-shadow-inset: inset 0 1px 0 rgba(255,255,255,0.60)` — top-edge highlight shorthand

**body::before gradient backdrop:**
```css
body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  background: radial-gradient(ellipse at 80% 10%, rgba(168, 92, 163, 0.10) 0%, transparent 60%);
}
```

**Theme switch transition on :root:**
```css
transition: color 200ms ease, background-color 200ms ease;
```

### Fallback System (app.css)

Two new rule blocks after `.card:hover`, before `.card-header`:

1. `@supports not (backdrop-filter: blur(1px))` — solid `var(--color-surface)` background + hides body::before
2. `@media (prefers-reduced-transparency: reduce)` — removes all blur + hides body::before

Both apply to: `.card, .stat-card, .table-wrapper, .dialog-content`

### Toast.svelte Fix

Line 132 changed from `var(--glass-bg-strong)` → `var(--glass-bg-overlay, var(--color-surface))`:
- `--glass-bg-overlay` (0.90 alpha) appropriate for overlay elements
- Solid `var(--color-surface)` fallback for no-backdrop-filter browsers

## Decisions Made

1. **--glass-bg-strong removed from :root:** The `--glass-bg-overlay` token serves the same purpose (near-opaque glass) with better semantic naming. The `.dialog-content` consumer already had `var(--color-surface)` as fallback.

2. **body::before opacity baked into rgba:** Using `rgba(168,92,163,0.10)` instead of separate `opacity: 0.10` avoids creating a new stacking context which could affect z-index layering.

3. **transition on :root:** Adding `transition: color 200ms ease, background-color 200ms ease` to `:root` makes theme switching smooth. This is a slight deviation from typical convention (transitions on elements not :root) but is the correct pattern for CSS-variable-based theming.

## Verification Results

- `grep -c "glass-bg-subtle|..."` → 6 (all 6 new tokens present)
- `grep "glass-bg: rgba(255, 255, 255, 0.76)"` → found
- `grep "body::before"` → found
- `grep "@supports not"` → found
- `grep "prefers-reduced-transparency"` → found
- `pnpm --filter @clokr/web build` → built in 2.03s (PASS)

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all tokens are fully implemented and wired.

## Threat Flags

None - CSS token changes only. No new network endpoints, auth paths, file access patterns, or schema changes.

## Self-Check: PASSED

Files:
- [x] `apps/web/src/app.css` — exists and contains all 10 glass tokens
- [x] `apps/web/src/lib/components/ui/Toast.svelte` — exists and contains glass-bg-overlay

Commits:
- [x] `a191668` — feat(08-01): add glass tokens, body::before gradient, theme transition
- [x] `514e7a2` — feat(08-01): add @supports fallback and prefers-reduced-transparency a11y query
- [x] `8965e96` — fix(08-01): replace glass-bg-strong with glass-bg-overlay in Toast.svelte
