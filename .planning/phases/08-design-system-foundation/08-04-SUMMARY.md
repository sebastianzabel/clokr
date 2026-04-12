---
phase: 08-design-system-foundation
plan: "04"
subsystem: web/css, web/ui, docs
tags: [glassmorphism, cards, buttons, badges, theme-picker, a11y, style-guide]
dependency_graph:
  requires:
    - "08-01: Glass token system (--glass-shadow-inset, --glass-saturate tokens)"
    - "08-02: 3-theme system with lila/hell/dunkel and theme store"
  provides:
    - ".card with 18px radius, overflow:clip, saturate, inset shadow highlight"
    - ".btn-primary/.btn-secondary pill shape (border-radius: 9999px)"
    - ".badge tighter padding (4px 8px), weight 400, letter-spacing 0.02em"
    - ".theme-picker/.theme-dot CSS with WCAG 44px touch targets and aria-checked"
    - "3-dot theme picker markup in admin/system replacing select dropdown"
    - "UI_STYLE_GUIDE.md updated for all Phase 8 changes"
  affects:
    - "All pages using .card class (18px radius, saturate, inset highlight)"
    - "All .btn-primary and .btn-secondary instances (pill shape)"
    - "All .badge instances (tighter padding, lighter weight)"
    - "Admin > System-Einstellungen theme selection UI"
tech_stack:
  added: []
  patterns:
    - "border-radius: 9999px for pill buttons (CTA-only — primary/secondary)"
    - "overflow: clip on .card (preserves sticky table headers vs overflow:hidden)"
    - "role=radiogroup + aria-checked pattern for dot-picker theme switcher"
    - "style=background-color:{t.color} from hardcoded static themes array (safe, not user-controlled)"
key_files:
  created: []
  modified:
    - apps/web/src/app.css
    - apps/web/src/routes/(app)/admin/system/+page.svelte
    - .planning/UI_STYLE_GUIDE.md
decisions:
  - "overflow:clip chosen over overflow:hidden — clip prevents sticky table headers from being clipped inside .card containers while still preventing overflow visual bleed"
  - "Pill shape (9999px) applied ONLY to .btn-primary and .btn-secondary — other variants (outline, ghost, danger, sm, icon) intentionally keep 8px radius for visual distinction"
  - ".stat-card also gets saturate(var(--glass-saturate)) to match .card glass quality, though it does not get overflow:clip (stat cards don't contain sticky tables)"
metrics:
  duration: "~15 minutes"
  completed: "2026-04-13"
  tasks_completed: 4
  tasks_total: 4
  files_modified: 3
---

# Phase 08 Plan 04: Component Style Overhaul & Dot-Picker Summary

Card/button/badge/input style update completing the glassmorphism design system: 18px card radius with saturate and inset highlight, pill primary/secondary buttons, tighter badges, and a 3-dot ARIA radiogroup theme picker replacing the select dropdown in admin/system.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Update card, button, badge, and input styles in app.css | 523f141 | apps/web/src/app.css |
| 2 | Replace theme select dropdown with dot-picker in admin/system | 2deb483 | apps/web/src/routes/(app)/admin/system/+page.svelte |
| 3 | Update UI_STYLE_GUIDE.md to reflect new design system | 783a6e3 | .planning/UI_STYLE_GUIDE.md |
| 4 | Visual verification of complete design system | approved | — |

## What Was Built

### app.css Changes

**`.card` rule (D-14):**
- `border-radius: 18px` (was `var(--radius-md)` = 14px)
- `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))` (saturate added)
- `-webkit-backdrop-filter`: same with saturate
- `box-shadow: var(--glass-shadow), var(--glass-shadow-inset)` (inset top-edge highlight added)
- `overflow: clip` (new — preserves sticky table headers)

**Pill buttons (D-15):**
```css
.btn-primary,
.btn-secondary {
  border-radius: 9999px;
}
```
Base `.btn` unchanged at `var(--radius-sm)` = 8px for all other variants.

**`.badge` (D-17):**
- `padding: 4px 8px` (was `0.3rem 0.75rem`)
- `font-weight: 400` (was 500)
- `letter-spacing: 0.02em` (was 0.01em)

**`.stat-card`:**
- Added `saturate(var(--glass-saturate))` to backdrop-filter (quality match with .card)

**`.theme-picker` / `.theme-dot` CSS:**
- `.theme-picker`: `display: flex; gap: 8px; align-items: center`
- `.theme-dot`: 28px visual, 44px touch target (WCAG 2.5.5), `border-radius: 50%`
- `.theme-dot[aria-checked="true"]`: `outline: 2px solid var(--color-brand); outline-offset: 2px; transform: scale(1.1)`
- `.theme-dot:hover`: `transform: scale(1.08)`
- `.theme-dot:focus-visible`: `outline: 2px solid var(--color-brand); outline-offset: 2px`

### admin/system/+page.svelte Changes

Replaced:
```html
<label class="form-label" for="theme-select">Theme</label>
<select id="theme-select" class="form-input" value={$theme} onchange={...}>
  {#each themes as t}<option value={t.id}>{t.label}</option>{/each}
</select>
```

With:
```svelte
<span class="form-label">Theme</span>
<div class="theme-picker" role="radiogroup" aria-label="Theme auswählen">
  {#each themes as t (t.id)}
    <button class="theme-dot" type="button"
      aria-checked={$theme === t.id ? 'true' : 'false'}
      aria-label={t.label}
      title="Theme: {t.label}"
      onclick={() => theme.set(t.id)}>
      <span class="theme-dot-inner" style="background-color: {t.color}"></span>
    </button>
  {/each}
</div>
```

`import { theme, themes } from '$stores/theme'` unchanged — already present.

### UI_STYLE_GUIDE.md Updates

- Themes table: 4 old themes → 3 (lila/hell/dunkel) with dot-picker context
- Glass tokens: 10-token reference table including `--glass-bg-subtle`, `--glass-shadow-inset`; `--glass-bg-strong` noted as removed
- body::before gradient pattern documented
- @supports and prefers-reduced-transparency fallbacks documented
- Spacing/Radius: noted `.card` hardcodes 18px; `--radius-md` kept for other consumers
- Cards: noted 18px, overflow:clip, saturate, inset shadow
- Buttons: noted pill shape for primary/secondary only
- Badges: noted 4px 8px, weight 400, 0.02em
- New Sidebar section: dark sidebar tokens, rgba-white text values, icon opacity states
- Accessibility checklist: prefers-reduced-transparency and glass fallback entries added

## Decisions Made

1. **`overflow: clip` vs `overflow: hidden`:** `clip` is used on `.card` because it prevents inner sticky table headers from being clipped (CSS `position: sticky` requires an overflow context; `overflow: hidden` creates a new one; `overflow: clip` creates the paint clipping without creating a scroll container). `overflow: hidden` would break sticky table headers inside cards.

2. **Pill shape only on primary/secondary:** The 9999px pill conveys "primary CTA" semantics. Outline, ghost, danger, sm, and icon buttons intentionally keep 8px radius to maintain visual hierarchy — pill = CTA, square-ish = utility action.

3. **`aria-checked` string (`'true'`/`'false'`) not boolean:** Per ARIA spec, `aria-checked` on role=radio elements requires the string `"true"` or `"false"`, not a boolean. The Svelte attribute `aria-checked={$theme === t.id ? 'true' : 'false'}` correctly outputs the string.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None — theme picker is fully wired to the theme store. Color preview uses `t.color` from the hardcoded `themes` array in `theme.ts`.

## Threat Flags

None - CSS and markup changes only. The theme dot `onclick` calls `theme.set(t.id)` where `t.id` is a compile-time string literal from the static `themes` array (`'lila' | 'hell' | 'dunkel'`). The `style="background-color: {t.color}"` attribute uses `t.color` from the same hardcoded array. No user-controlled data flows to either. No new network endpoints, auth paths, or schema changes.

## Self-Check: PASSED

Files:
- [x] `apps/web/src/app.css` — exists, contains 18px, 9999px, 4px 8px, .theme-picker, .theme-dot
- [x] `apps/web/src/routes/(app)/admin/system/+page.svelte` — exists, contains .theme-picker, aria-checked, no theme-select
- [x] `.planning/UI_STYLE_GUIDE.md` — exists, contains lila/hell/dunkel, glass-bg-subtle, 18px

Commits:
- [x] `523f141` — feat(08-04): update card, button, badge styles and add theme-picker CSS
- [x] `2deb483` — feat(08-04): replace theme select dropdown with dot-picker in admin/system
- [x] `783a6e3` — docs(08-04): update UI_STYLE_GUIDE.md for Phase 8 design system

Build:
- [x] `pnpm --filter @clokr/web build` → built in 1.98s (PASS)
