---
phase: 08-design-system-foundation
plan: "03"
subsystem: web/ui
tags: [sidebar, dark-theme, css-custom-properties, nav-opacity, glassmorphism]
dependency_graph:
  requires:
    - "08-01: Glass token system"
    - "08-02: 3-theme system with dark sidebar tokens (--sidebar-bg, --sidebar-border, --nav-active-*)"
  provides:
    - "Sidebar redesign — solid dark background via --sidebar-bg (no more glass-bg-strong)"
    - "Compact 8px/16px nav item padding and 13px/400 typography"
    - "Icon opacity states: 0.6 rest, 1.0 active, 0.85 hover with 150ms ease-out transition"
    - "Active nav state using --nav-active-bg/color/border theme tokens"
    - "Light text colors (rgba whites) for dark-on-dark sidebar readability"
    - "Mobile bottom nav and mobile header also using dark sidebar tokens"
  affects:
    - "All pages in (app) layout group — sidebar visible on all authenticated pages"
    - "Mobile viewport — bottom nav and header now use dark sidebar tokens"
tech_stack:
  added: []
  patterns:
    - "Solid dark surface pattern: background-color var(--sidebar-bg), backdrop-filter none"
    - "Rgba white opacity pattern for text on dark surfaces (0.35-0.90 range)"
    - "CSS icon opacity states via parent class selector (.nav-item--active .nav-icon)"
key_files:
  created: []
  modified:
    - apps/web/src/routes/(app)/+layout.svelte
key_decisions:
  - "Sidebar uses solid var(--sidebar-bg) — not glass. Backdrop-filter explicitly set to none. The sidebar is an opaque dark surface, not a glassmorphism element."
  - "rgba white values instead of var(--color-text-*) for sidebar text — ensures readability on dark bg regardless of theme's light-mode text colors"
  - "Mobile nav (.mobile-nav) and mobile header (.mobile-header) use same sidebar tokens for consistent dark chrome across all viewport sizes"
  - "logout-btn uses rgba white border/bg (not theme color-border/color-bg-subtle) to stay legible on dark sidebar"
patterns-established:
  - "Icon opacity via parent class selector: .nav-item--active .nav-icon { opacity: 1.0 } — no JS needed"
  - "Dark surface text: rgba(255, 255, 255, N) where N varies by hierarchy (0.90 primary, 0.75 body, 0.60 secondary, 0.50 muted, 0.35 dim)"
requirements-completed:
  - UI-03
duration: ~12min
completed: "2026-04-13"
---

# Phase 08 Plan 03: Sidebar Visual Redesign Summary

Dark-sidebar redesign of +layout.svelte: solid var(--sidebar-bg) background (no glass), compact 8px/16px nav padding with 13px/400 labels, icon opacity 0.6→1.0 on active with 150ms ease-out, and rgba-white text colors for dark-on-dark readability across all 3 themes.

## Performance

- **Duration:** ~12 min
- **Completed:** 2026-04-13
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Sidebar background changed from `var(--glass-bg-strong, var(--sidebar-bg))` to solid `var(--sidebar-bg)` — dark purple-navy in lila theme, dark navy in hell, deep charcoal in dunkel
- Nav item padding tightened from `0.625rem 0.75rem` to `8px 16px`, font from `0.9rem/500` to `0.8125rem/400`
- Icon opacity system: `.nav-icon` at 0.6 rest, `.nav-item--active .nav-icon` at 1.0, hover at 0.85, all with `150ms ease-out`
- All sidebar text (brand name, nav labels, user email, role, version) converted to rgba white values for dark-bg readability
- Mobile bottom nav and mobile header migrated to `var(--sidebar-bg)` + `var(--sidebar-border)` (no more glass blur on mobile chrome)

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Restyle sidebar for dark background with compact nav and icon opacity states | 12445c8 | apps/web/src/routes/(app)/+layout.svelte |

## Files Created/Modified

- `apps/web/src/routes/(app)/+layout.svelte` — 18 CSS rule updates: .sidebar, .sidebar-brand, .brand-name, .notification-bell, .sidebar-nav, .nav-item, .nav-item:hover, .nav-item--active, .nav-icon (+ active/hover variants), .sidebar-footer, .sidebar-version, .sidebar-user, .sidebar-user-email, .sidebar-user-role, .logout-btn, .mobile-nav, .mobile-nav-item, .mobile-nav-item--active, .mobile-header, .mobile-header-name

## Decisions Made

1. **Solid surface, not glass:** The sidebar is a navigation chrome element, not a content surface. Glassmorphism belongs on cards and overlays. The sidebar needs opaque dark background for visual hierarchy and contrast.

2. **rgba white values:** Using `rgba(255, 255, 255, N)` instead of `var(--color-text-*)` ensures sidebar text is always readable on dark backgrounds regardless of which theme is active. Theme text colors (--color-text is #44403C in lila) would be unreadable on #1E1B2E.

3. **Mobile nav uses same dark tokens:** Consistent dark chrome across desktop sidebar and mobile nav/header. The mobile experience should feel like the same app.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None — all sidebar CSS properties reference fully implemented theme tokens from Plans 01 and 02.

## Threat Flags

None - scoped CSS changes only. No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries. Nav item visibility is still controlled by Svelte `{#each}` block role-gating (not CSS).

## Self-Check: PASSED

Files:
- [x] `apps/web/src/routes/(app)/+layout.svelte` — exists, contains all sidebar redesign changes

Commits:
- [x] `12445c8` — feat(08-03): restyle sidebar — dark bg, compact nav, icon opacity states

Verification:
- [x] `background-color: var(--sidebar-bg)` present in .sidebar rule
- [x] `opacity: 0.6` present in .nav-icon rule
- [x] `var(--nav-active-bg)` in .nav-item--active
- [x] `var(--nav-active-color)` in .nav-item--active and .mobile-nav-item--active
- [x] `var(--nav-active-border)` in .nav-item--active
- [x] `transition: opacity 150ms ease-out` in .nav-icon
- [x] `background: var(--sidebar-bg)` in .mobile-nav and .mobile-header
- [x] `pnpm --filter @clokr/web build` → built in 2.02s (PASS)
