---
quick_id: 260411-fth
title: Fix leave-type colors and employee-selector style
date: 2026-04-11
commit: 5883486
files_modified:
  - apps/web/src/routes/(app)/leave/+page.svelte
  - apps/web/src/routes/(app)/time-entries/+page.svelte
tags: [ui, css-vars, theme, leave, time-entries]
---

# Quick Task 260411-fth: Fix leave-type colors and employee-selector style

## One-liner

Replaced hardcoded hex colors with CSS custom properties (`var(--leave-type-*)` and `var(--color-brand-tint)`) in leave calendar chips, legend dots, and the time-entries employee-selector.

## Changes Made

### 1. `leave/+page.svelte` — `typeColor()` function

Replaced all hardcoded hex values in the `typeColor()` function with `var(--leave-type-*)` CSS custom properties. Pending-state color dimming (previously done by appending `88` to the hex) is now handled entirely by the existing `cal-chip--pending` CSS class (opacity 0.85 + dashed outline), so the status parameter no longer affects the returned color value for own/typed entries.

### 2. `leave/+page.svelte` — Legend dots

Seven legend dot `style="background:#..."` inline values replaced with their corresponding `var(--leave-type-*)` equivalents:

- `#4caf50` → `var(--leave-type-vacation)`
- `#9c27b0` → `var(--leave-type-overtime)`
- `#f44336` → `var(--leave-type-sick)`
- `#ff9800` → `var(--leave-type-sick-child)`
- `#2196f3` → `var(--leave-type-special)`
- `#00bcd4` → `var(--leave-type-education)`
- `#9e9e9e` → `var(--leave-type-absent)`

### 3. `time-entries/+page.svelte` — Employee selector

- `.employee-selector` background/border replaced with `var(--color-brand-tint)` / `var(--color-brand-tint-hover)`
- `.viewing-other-hint` color replaced with `var(--color-brand)`

## Deviations from Plan

None — plan executed exactly as written.

## Pre-existing Issues (out of scope)

svelte-check reported 14 errors across 11 files before and after these changes. None are in the modified files. Logged as out-of-scope per deviation rules.
