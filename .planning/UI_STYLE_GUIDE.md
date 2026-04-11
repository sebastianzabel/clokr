# Clokr UI Style Guide

> Reference for building consistent UI across `apps/web`. When in doubt, check `apps/web/src/app.css` as the source of truth.

---

## Themes

Applied via `data-theme` on `<html>`. Four themes, all defined in `app.css`:

| Theme | Brand color | Use case |
|-------|-------------|----------|
| `pflaume` | `#80377b` (plum) | Default |
| `nacht` | `#a85ca3` | Dark mode |
| `wald` | `#059669` | Nature green |
| `schiefer` | `#475569` | Neutral slate |

**Rule**: Never hardcode hex values in component styles. Use CSS vars — they resolve correctly for all themes automatically.

---

## Core Color Variables

```css
/* Backgrounds */
--color-bg             /* page background */
--color-bg-subtle      /* zebra rows, weekends, sidebars */
--color-surface        /* card/input backgrounds */
--color-surface-raised /* elevated surfaces */
--color-brand-tint     /* subtle brand highlight */
--color-brand-tint-hover

/* Text */
--color-text           /* body text */
--color-text-muted     /* labels, hints, placeholders */
--color-text-heading   /* headings, bold values */

/* Brand */
--color-brand          /* primary accent */
--color-brand-dark     /* hover state */
--color-brand-light    /* active state */

/* Borders */
--color-border         /* default border */
--color-border-subtle  /* calendar grid lines */

/* Status */
--color-green / --color-green-bg / --color-green-border
--color-yellow / --color-yellow-bg / --color-yellow-border
--color-red / --color-red-bg / --color-red-border
--color-blue / --color-blue-bg / --color-blue-border
--color-orange / --color-orange-bg / --color-orange-border

/* Domain */
--leave-type-vacation, --leave-type-sick, --leave-type-overtime ...
```

---

## Typography

```css
--font-sans  /* "DM Sans", system-ui */
--font-mono  /* ui-monospace, SFMono */
```

| Use | Size | Weight |
|-----|------|--------|
| Page title | `1.375rem` | 700 |
| H2 | `1.25rem` | 600 |
| H3 | `1rem` | 600 |
| Body | `1rem` | 400 |
| Form label | `0.9375rem` | 500 |
| Summary value | `0.9375rem` | 700, `--font-mono`, `--color-text-heading` |
| Summary label | `0.8125rem` | 500, `--color-text-muted` |
| Badge / chip | `0.8125rem` | 500 |

---

## Spacing & Radius

```css
--radius-sm   /* 8px  — inputs, small cards */
--radius-md   /* 14px — primary cards */
--radius-lg   /* 22px — large modals */
```

Common padding patterns:
- Card body: `1.75rem`
- Summary bar: `0.875rem 1.25rem`
- Employee selector: `0.75rem 1rem`
- Table cell: `1rem 1.125rem` (compact: `0.625rem 1rem`)

---

## Glass Effect

All top-level content cards use the glass treatment:

```css
background: var(--glass-bg, rgba(255,255,255,0.97));
border: 1px solid var(--glass-border);
box-shadow: var(--glass-shadow);
backdrop-filter: blur(var(--glass-blur));
-webkit-backdrop-filter: blur(var(--glass-blur));
```

Use `.card` global class — it already applies all of the above.

---

## Animations

### Entrance animation — `card-animate`

**Every primary content block must have this class.** Applies `card-enter` (fade + translateY + scale) with staggered delays for up to 6 siblings.

```svelte
<div class="month-summary card-animate">...</div>
<div class="cal-section card card-animate">...</div>
<div class="employee-selector card-animate">...</div>
```

Stagger delays: `nth-child(1)=0ms`, `(2)=60ms`, `(3)=120ms` … `(6)=300ms`

### Page enter — `page-enter`

For the outermost page wrapper when navigating between routes.

### Other keyframes (do not duplicate)

| Name | Duration | Use |
|------|----------|-----|
| `card-enter` | 0.4s | Cards, panels, summary bars |
| `page-enter` | 0.3s | Route-level page wrapper |
| `count-up` | 0.5s | Numeric stat values |
| `skeleton-shimmer` | 1.5s ∞ | Loading skeletons |
| `dialog-in` | 0.2s | Modals |
| `backdrop-in` | 0.15s | Modal backdrop |

**Rule**: Never write a custom `@keyframes fade` or `@keyframes slideIn` — use the existing ones.

### Easing functions

```css
--ease-out    /* cubic-bezier(0.16, 1, 0.3, 1)    — default for enters */
--ease-in     /* cubic-bezier(0.55, 0, 1, 0.45)    — exits */
--ease-in-out /* cubic-bezier(0.65, 0, 0.35, 1)    — transforms */
--spring      /* cubic-bezier(0.34, 1.56, 0.64, 1) — bouncy micro-interactions */
```

### Reduced motion

All animations are automatically disabled for users who prefer reduced motion via the global `@media (prefers-reduced-motion: reduce)` rule in `app.css`. No per-component handling needed.

---

## Component Classes (Global)

### Buttons
```svelte
<button class="btn btn-primary">Speichern</button>
<button class="btn btn-secondary">Abbrechen</button>
<button class="btn btn-outline">Export</button>
<button class="btn btn-ghost">Mehr</button>
<button class="btn btn-danger">Löschen</button>
<button class="btn btn-sm btn-outline">Klein</button>
<button class="btn btn-icon" aria-label="Schließen">✕</button>
```
All buttons: `min-height: 44px` (WCAG 2.5.5).

### Cards
```svelte
<div class="card card-body card-animate">...</div>          <!-- glass surface -->
<div class="card card-interactive card-animate">...</div>   <!-- hover lift -->
```

### Badges
```svelte
<span class="badge badge-green">Genehmigt</span>
<span class="badge badge-yellow">Ausstehend</span>
<span class="badge badge-red">Abgelehnt</span>
<span class="badge badge-blue">Info</span>
<span class="badge badge-gray">Inaktiv</span>
<span class="badge badge-orange">Stornierung</span>
```

### Forms
```svelte
<div class="form-group">
  <label class="form-label" for="x">Label</label>
  <input id="x" class="form-input" type="text" />
  <p class="form-hint">Hinweistext</p>
  <p class="form-error">Fehlertext</p>
</div>
```

### View Tabs
```svelte
<div class="view-tabs">
  <button class="view-tab" class:view-tab--active={view === "a"} onclick={() => view = "a"}>Tab A</button>
  <button class="view-tab" class:view-tab--active={view === "b"} onclick={() => view = "b"}>Tab B</button>
</div>
```

### Employee Selector (above view-tabs)
```svelte
<div class="employee-selector card-animate">
  <label class="form-label" for="emp-select">Mitarbeiter</label>
  <select id="emp-select" class="form-input" ...>
    <option value="">Alle Mitarbeiter</option>
    <option value="mine">Meine Einträge</option>
    <!-- manager only: individual employees -->
  </select>
</div>
```

### Summary Bar
```svelte
<div class="month-summary card-animate">  <!-- or vac-summary -->
  <div class="msummary-item">
    <span class="msummary-label">Soll</span>
    <span class="msummary-value">40h</span>
  </div>
  <div class="msummary-divider"></div>
  ...
</div>
```
Value: `font-size: 0.9375rem`, `font-weight: 700`, `font-family: var(--font-mono)`, `color: var(--color-text-heading)`
Label: `font-size: 0.8125rem`, `font-weight: 500`, `color: var(--color-text-muted)`

### Alerts
```svelte
<div class="alert alert-info" role="alert"><span>ℹ</span><span>Text</span></div>
<div class="alert alert-warning" role="alert"><span>⚠</span><span>Text</span></div>
<div class="alert alert-error" role="alert"><span>⚠</span><span>Text</span></div>
<div class="alert alert-success" role="alert"><span>✓</span><span>Text</span></div>
```

### Skeletons
```svelte
<div class="skeleton skeleton-heading"></div>
<div class="skeleton skeleton-text"></div>
<div class="skeleton skeleton-stat"></div>
<div class="skeleton skeleton-card"></div>
```

---

## Page Layout Pattern

```svelte
<div class="page-header">
  <h1>Seitentitel</h1>
  <button class="btn btn-primary">Neu</button>
</div>

<!-- optional: employee filter (manager only, above tabs) -->
<div class="employee-selector card-animate">...</div>

<!-- view tabs -->
<div class="view-tabs">...</div>

<!-- summary bar (where applicable) -->
<div class="month-summary card-animate">...</div>

<!-- main content -->
<div class="cal-section card card-animate">...</div>
<!-- or -->
<div class="table-wrapper card-animate">...</div>
```

---

## Calendar Cells

```css
/* Normal weekday */
background: var(--color-surface)

/* Weekend */
background: var(--color-bg-subtle)

/* Holiday */
background: var(--color-brand-tint) !important;
border-left: 3px solid var(--color-brand);

/* Other month */
opacity: 0.3;
background: var(--color-bg-subtle) !important;

/* Today */
box-shadow: inset 0 0 0 2px var(--color-brand);
```

Never use hardcoded hex colors for calendar cell backgrounds.

---

## Accessibility Checklist

- [ ] All interactive elements: `min-height: 44px` (WCAG 2.5.5)
- [ ] Focus styles: do not remove `:focus-visible` outlines
- [ ] Semantic HTML: `role`, `aria-label` on icon-only buttons
- [ ] `.sr-only` for screen-reader-only text
- [ ] Color is never the ONLY indicator of state — always pair with text/icon
- [ ] Animations: handled automatically via `prefers-reduced-motion` in `app.css`
