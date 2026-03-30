---
phase: 02-compliance-and-api-coverage
plan: "06"
subsystem: ui
tags: [dsgvo, fonts, csp, woff2, privacy]

# Dependency graph
requires: []
provides:
  - "8 WOFF2 font files self-hosted in apps/web/static/fonts/"
  - "Local @font-face declarations for DM Sans, Jost, Fraunces replacing Google Fonts CDN"
  - "CSP headers with no Google Fonts domain references"
affects: [phase-03-e2e]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Local font self-hosting: WOFF2 files in static/fonts/, declared via @font-face with unicode-range subsetting"
    - "CSP narrowed to 'self' only for font-src and style-src"

key-files:
  created:
    - "apps/web/static/fonts/dmsans-v17-latin-ext.woff2"
    - "apps/web/static/fonts/dmsans-v17-latin.woff2"
    - "apps/web/static/fonts/fraunces-v38-vietnamese.woff2"
    - "apps/web/static/fonts/fraunces-v38-latin-ext.woff2"
    - "apps/web/static/fonts/fraunces-v38-latin.woff2"
    - "apps/web/static/fonts/jost-v20-cyrillic.woff2"
    - "apps/web/static/fonts/jost-v20-latin-ext.woff2"
    - "apps/web/static/fonts/jost-v20-latin.woff2"
  modified:
    - "apps/web/src/app.css"
    - "apps/web/src/hooks.server.ts"

key-decisions:
  - "Self-host all three font families (DM Sans, Jost, Fraunces) as WOFF2 with unicode-range subsetting — mirrors Google's own subsetting strategy for same network efficiency"
  - "font-display: swap on all @font-face blocks — prevents invisible text during load, consistent with prior CDN behavior"
  - "CSP narrowed: removed fonts.googleapis.com from style-src and fonts.gstatic.com from font-src — DSGVO compliance eliminates need for these origins"

patterns-established:
  - "Font self-hosting: download versioned WOFF2 from fonts.gstatic.com, store in static/fonts/ with version in filename (e.g. dmsans-v17-latin.woff2)"
  - "CSP enforcement: no external font or style origins — font-src 'self', style-src 'self' 'unsafe-inline'"

requirements-completed: [AUDIT-02]

# Metrics
duration: 15min
completed: 2026-03-31
---

# Phase 02 Plan 06: Self-hosted Fonts (DSGVO Art. 44) Summary

**8 WOFF2 font files downloaded locally, Google Fonts CDN replaced with @font-face declarations, CSP cleaned to remove all Google domain references**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-03-31T00:20:00Z
- **Completed:** 2026-03-31T00:35:00Z
- **Tasks:** 1 of 2 complete (Task 2 is human-verify checkpoint — pending)
- **Files modified:** 10 (8 new font files, app.css, hooks.server.ts)

## Accomplishments

- Downloaded all 8 WOFF2 font files from fonts.gstatic.com into `apps/web/static/fonts/` (total ~256KB)
- Replaced Google Fonts `@import` in `app.css` with 8 local `@font-face` blocks covering DM Sans (latin, latin-ext), Fraunces (latin, latin-ext, vietnamese), and Jost (latin, latin-ext, cyrillic)
- Removed `fonts.googleapis.com` from `style-src` and `fonts.gstatic.com` from `font-src` in the CSP header set by `hooks.server.ts`

## Task Commits

1. **Task 1: Download WOFF2 font files and replace Google Fonts CSS** - `2217362` (feat)

**Plan metadata:** _pending_ (this commit)

## Files Created/Modified

- `apps/web/static/fonts/dmsans-v17-latin-ext.woff2` — DM Sans latin-extended subset (18KB)
- `apps/web/static/fonts/dmsans-v17-latin.woff2` — DM Sans latin subset (37KB)
- `apps/web/static/fonts/fraunces-v38-vietnamese.woff2` — Fraunces Vietnamese subset (19KB)
- `apps/web/static/fonts/fraunces-v38-latin-ext.woff2` — Fraunces latin-extended subset (60KB)
- `apps/web/static/fonts/fraunces-v38-latin.woff2` — Fraunces latin subset (67KB)
- `apps/web/static/fonts/jost-v20-cyrillic.woff2` — Jost Cyrillic subset (10KB)
- `apps/web/static/fonts/jost-v20-latin-ext.woff2` — Jost latin-extended subset (17KB)
- `apps/web/static/fonts/jost-v20-latin.woff2` — Jost latin subset (27KB)
- `apps/web/src/app.css` — Replaced `@import url("https://fonts.googleapis.com/...")` with 8 local `@font-face` blocks
- `apps/web/src/hooks.server.ts` — CSP: `style-src` no longer includes `fonts.googleapis.com`; `font-src` no longer includes `fonts.gstatic.com`

## Decisions Made

- All three font families self-hosted with unicode-range subsetting (mirrors Google's strategy — browser loads only subsets needed for visible characters)
- `font-display: swap` preserved on all `@font-face` declarations for consistent loading behavior
- No additional compression or tooling added — WOFF2 is already the most efficient web font format; additional tooling would be over-engineering

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- DSGVO Art. 44 font compliance complete (AUDIT-02 satisfied)
- CSP is now more restrictive (no external font/style origins) — ready for security audit in Phase 3
- Visual font rendering must be confirmed by human (Task 2 checkpoint — see below)

### Pending: Human Verification (Task 2)

Task 2 is a blocking `checkpoint:human-verify`. The human must:

1. Run `docker compose up --build -d` to rebuild with new font files
2. Open the web app in a browser
3. Open DevTools Network tab, reload — confirm zero requests to `fonts.googleapis.com` or `fonts.gstatic.com`
4. Visually confirm fonts render correctly (DM Sans body text, Jost/Fraunces headings)
5. Check Response Headers — `Content-Security-Policy` must not contain Google domains

---
*Phase: 02-compliance-and-api-coverage*
*Completed: 2026-03-31*
