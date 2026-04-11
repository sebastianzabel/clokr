# Quick Task 260411-clm: Pro Theme

**Status:** Complete
**Commits:** bd3545f (app.css), cd9e762 (theme store)

## What was built

New `[data-theme="pro"]` block in `apps/web/src/app.css`:
- Indigo `#4f46e5` accent (Linear/Datadog inspired)
- Sharper radii: `--radius-sm: 4px`, `--radius-md: 8px`, `--radius-lg: 12px`
- Solid surfaces: `--glass-blur: 0`, no backdrop-filter blur
- Cold neutral palette: bg `#fafbfc`, text `#0f172a`
- Denser layout: `html[data-theme="pro"] { font-size: 15px; }`

`apps/web/src/lib/stores/theme.ts`: added `{ id: 'pro', label: 'Pro', color: '#4f46e5' }`
