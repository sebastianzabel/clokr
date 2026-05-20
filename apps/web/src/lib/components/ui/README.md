# UI Primitives — Canonical Spec

> **Status: FROZEN (post-Phase 34, production).**
> Adding a new primitive or breaking-changing one of the existing six requires a follow-up phase plan + justification. Bug-fixes and additive props are permitted without a phase plan.

This directory is the **enforceable contract** for Clokr UI. If a page builds a raw card / modal / KPI / month-bar / approval-row by hand, it bypasses this spec and lint rules will block the PR.

Read [`/docs/design/README.md`](../../../../docs/design/README.md) for the visual language. This README documents the *components* — what to import, how to call them, what props they accept.

## Rules

- Every `(app)/` page MUST use `<PageHead>` from `$components/layout/PageHead.svelte`.
- No raw `<h1>` outside `PageHead.svelte`.
- No inline `style="color: …; background: …; background-color: …; border: …"` declarations — use theme tokens via class names. CSS custom property passthrough (`style="--card-idx: 3;"`) is allowed.
- No raw `.scrim`, `.modal`, `.modal-hd`, `.modal-body`, `.modal-foot`, `.card-hd`, `.card-title`, `.card-sub`, `.month-bar`, `.month-bar-stats`, `.mstat`, `.approval-row` class usage in route files. Go through the primitive. (Note: the Modal primitive emits `.scrim` + `.modal` + `.modal-hd` + `.modal-body` + `.modal-foot` to match the canonical app.css recipe.)
- Escape-hatch: `<!-- eslint-disable-next-line clokr/ui-no-raw-class -->` with a justification comment. PR review will scrutinize.

## Primitives

### `<PageHead>`

Source: `$components/layout/PageHead.svelte`

```ts
interface Props {
  /** Serif italic eyebrow line, e.g. "Mein Bereich". */
  eyebrow: string;
  /** Main heading, e.g. "Guten Tag, Lena". */
  title: string;
  /**
   * Optional explicit accent word. When provided AND found in `title`,
   * the first occurrence is wrapped in `<em>` (italic, --brand-light).
   * Matching is case-sensitive; only the first occurrence is wrapped.
   */
  accent?: string;
  /** Optional muted sub-paragraph, max-width 560 px, below the H1. */
  sub?: string;
  /** Optional right-aligned action cluster (buttons) on the same row as the H1. */
  actions?: Snippet;
}
```

**`autoAccent` behavior (D-01):** When no explicit `accent` prop is passed, `PageHead` automatically italicizes the LAST word of `title`, where words are split on whitespace or `-`. Single-word titles render WITHOUT an `<em>` wrapper. Explicit `accent="X"` always wins.

| `title`                  | `accent` | Rendered                  |
| ------------------------ | -------- | ------------------------- |
| `Team-Zeiten`            | (none)   | `Team-` + *`Zeiten`*      |
| `Mein Profil`            | (none)   | `Mein ` + *`Profil`*      |
| `Urlaub & Abwesenheit`   | (none)   | `Urlaub & ` + *`Abwesenheit`* |
| `Zeiterfassung`          | (none)   | `Zeiterfassung` (plain)   |
| `Mein Profil`            | `Mein`   | *`Mein`* + ` Profil`      |

Usage:

```svelte
<script>
  import PageHead from "$components/layout/PageHead.svelte";
</script>

<PageHead
  eyebrow="Verwaltung"
  title="Team-Zeiten"
  sub="Übersicht aller gebuchten Zeiteinträge des Teams."
>
  {#snippet actions()}
    <button class="btn btn-primary">Neuer Eintrag</button>
  {/snippet}
</PageHead>
```

### `<Card>`

Source: `$components/ui/Card.svelte`

```ts
interface Props {
  /** Adds the .card-animate class for entrance animation. */
  animate?: boolean;
  /** Extra class names appended to the root <section>. */
  class?: string;
  /**
   * Inline style attribute. Reserved EXCLUSIVELY for CSS custom property
   * passthrough (e.g. `style="--card-idx: 3;"` for animation cascade).
   * Do NOT use for color/background/border declarations — those must go
   * through theme classes. The lint rule does NOT flag `--*:` custom
   * properties, but DOES flag color/background/background-color/border.
   */
  style?: string | null;
  /** Default-slot body. */
  children: Snippet;
}
```

Rendered DOM: `<section class="card {animate ? 'card-animate' : ''} {extraClass}" style={style ?? undefined}>…children…</section>`

Usage:

```svelte
<script>
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
</script>

<Card animate class="dashboard-stat" style="--card-idx: 3;">
  <CardHeader title="URLAUB" sub="Verbleibende Tage" />
  <p>Inhalt…</p>
</Card>
```

### `<CardHeader>`

Source: `$components/ui/CardHeader.svelte`

```ts
interface Props {
  /** Bold uppercase title row inside .card-hd. */
  title: string;
  /** Optional italic eyebrow text rendered below the title. */
  sub?: string;
  /** Optional right-aligned actions snippet inside .card-hd-actions. */
  actions?: Snippet;
}
```

Rendered DOM: `<header class="card-hd"><div class="card-title">{title}</div>{#if sub}<div class="card-sub">{sub}</div>{/if}{#if actions}<div class="card-hd-actions">{@render actions()}</div>{/if}</header>`

Usage:

```svelte
<CardHeader title="ZEITERFASSUNG" sub="Übersicht der aktuellen Woche">
  {#snippet actions()}
    <button class="btn btn-ghost">Export</button>
  {/snippet}
</CardHeader>
```

### `<Modal>` (bind:open + Escape + backdrop + focus-trap)

Source: `$components/ui/Modal.svelte`

```ts
interface Props {
  /** Bindable open state — two-way binding. Parent owns the boolean. */
  open: boolean;
  /** Serif italic eyebrow above the title. */
  eyebrow?: string;
  /** Serif H3 title. */
  title: string;
  /** Overrides title for aria-label, if a richer accessible name is needed. */
  ariaLabel?: string;
  /** Body content (default slot). */
  children: Snippet;
  /** Optional footer with action buttons (right-aligned). */
  footer?: Snippet;
}
```

Modal owns:

- **Escape key** → sets `open=false`
- **Backdrop click** → sets `open=false`
- **Focus trap** on `.modal-card` while open (via `use:focusTrap` from `$lib/utils/focus-trap.ts`)
- **Body scroll lock** while open (toggles `document.body.style.overflow`)

Parent surface area is intentionally minimal: bind a boolean + write the body content. Use Svelte 5 `$state(false)` in the caller.

Usage:

```svelte
<script>
  import Modal from "$components/ui/Modal.svelte";

  let modalOpen = $state(false);

  function save() {
    // ...
    modalOpen = false;
  }
</script>

<button onclick={() => (modalOpen = true)}>Neuer Eintrag</button>

<Modal bind:open={modalOpen} eyebrow="Verwaltung" title="Neuer Eintrag">
  <p>Body content…</p>
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={() => (modalOpen = false)}>Abbrechen</button>
    <button class="btn btn-primary" onclick={save}>Speichern</button>
  {/snippet}
</Modal>
```

### `<MonthBar>`

Source: `$components/ui/MonthBar.svelte`

```ts
type Stat = { label: string; value: string; unit?: string };

interface Props {
  /** Optional serif italic eyebrow above the bar. */
  eyebrow?: string;
  /** Cursor date — component derives the label "März 2026" via Intl.DateTimeFormat('de-DE'). */
  date: Date;
  /** Stat tiles displayed in the .month-bar-stats area. */
  stats?: Stat[];
  /** Previous-month handler. */
  onPrev: () => void;
  /** Next-month handler. */
  onNext: () => void;
  /** Optional "Heute" jump-to-today handler. */
  onToday?: () => void;
  /** Optional extra actions snippet in the nav row (e.g. PDF export). */
  extraActions?: Snippet;
}
```

The component formats `date` as German month + year (`"März 2026"`) internally — callers pass the raw `Date`.

Usage:

```svelte
<script>
  import MonthBar from "$components/ui/MonthBar.svelte";

  let cursorDate = $state(new Date());

  function shiftMonth(delta: number) {
    cursorDate = new Date(cursorDate.getFullYear(), cursorDate.getMonth() + delta, 1);
  }
</script>

<MonthBar
  eyebrow="Zeiterfassung"
  date={cursorDate}
  stats={[
    { label: "Arbeitstage", value: "21" },
    { label: "Soll", value: "168", unit: "h" },
    { label: "Ist", value: "162.5", unit: "h" },
  ]}
  onPrev={() => shiftMonth(-1)}
  onNext={() => shiftMonth(1)}
  onToday={() => (cursorDate = new Date())}
>
  {#snippet extraActions()}
    <button class="btn btn-ghost">PDF</button>
  {/snippet}
</MonthBar>
```

### `<KPIStat>`

Source: `$components/ui/KPIStat.svelte`

```ts
interface Props {
  /** 11px UPPERCASE faint label. */
  label: string;
  /** Serif 38px value (formatted by caller — pass a string, not a number). */
  value: string;
  /** Sans muted 14px unit, rendered inline after value. */
  unit?: string;
  /** 12px muted delta line; tone controls color. */
  delta?: string;
  /** Tone for the delta line. Defaults to "neutral". */
  deltaTone?: "good" | "bad" | "warn" | "neutral";
}
```

Pure props — no slots. Rendered DOM:

```html
<article class="kpi">
  <div class="kpi-label">URLAUBSTAGE</div>
  <div class="kpi-value">18<span class="kpi-unit">von 30</span></div>
  <div class="kpi-delta kpi-delta-good">+3.5h</div>
</article>
```

Usage:

```svelte
<script>
  import KPIStat from "$components/ui/KPIStat.svelte";
</script>

<KPIStat label="Urlaubstage" value="18" unit="von 30" />
<KPIStat label="Überstunden" value="+12.5" unit="h" delta="+3.5h" deltaTone="good" />
<KPIStat label="Krankheitstage" value="2" delta="−1 vs Vorjahr" deltaTone="warn" />
```

### `<ApprovalRow>`

Source: `$components/ui/ApprovalRow.svelte`

```ts
interface Props {
  /** Avatar initials or short identifier rendered in the 44px avatar slot. */
  avatar: string;
  /** Employee or requester name. */
  name: string;
  /** Optional meta line below the name (type + leave label as a formatted string). */
  meta?: string;
  /** Tabular dates string + day count, e.g. "2026-04-12 → 2026-04-18 · 5 Tage". */
  dates: string;
  /** Whole-row click handler — typically opens a detail modal. */
  onclick?: () => void;
  /** Right-aligned action buttons. */
  actions?: Snippet;
  /** Optional richer meta content (chip + text) when a plain string isn't enough. */
  metaContent?: Snippet;
}
```

Rendered DOM (matches design handoff §4 approval row, 4-col grid 44px 1fr auto auto):

```html
<div class="approval-row" role="button" tabindex="0" onclick=…>
  <div class="approval-avatar">{avatar}</div>
  <div class="approval-name-meta">
    <div class="approval-name">{name}</div>
    <div class="approval-meta">{meta or @render metaContent}</div>
  </div>
  <div class="approval-dates">{dates}</div>
  <div class="approval-actions">{@render actions()}</div>
</div>
```

Usage:

```svelte
<script>
  import ApprovalRow from "$components/ui/ApprovalRow.svelte";

  function openDetail(id: string) {
    /* … */
  }
  function approve(id: string) {
    /* … */
  }
  function reject(id: string) {
    /* … */
  }
</script>

<ApprovalRow
  avatar="LM"
  name="Lena Müller"
  meta="Urlaub · Vacation"
  dates="2026-04-12 → 2026-04-18 · 5 Tage"
  onclick={() => openDetail(req.id)}
>
  {#snippet actions()}
    <button
      class="btn btn-outline btn-sm"
      onclick={(e) => {
        e.stopPropagation();
        reject(req.id);
      }}
    >
      Ablehnen
    </button>
    <button
      class="btn btn-primary btn-sm"
      onclick={(e) => {
        e.stopPropagation();
        approve(req.id);
      }}
    >
      Genehmigen
    </button>
  {/snippet}
</ApprovalRow>
```

### `<ConfirmDialog>`

Source: `$components/ui/ConfirmDialog.svelte`

```ts
interface Props {
  /** Bindable open state. Parent owns the boolean. */
  open: boolean;
  /** Serif H3 title (e.g. "Betriebsurlaub löschen?"). */
  title: string;
  /** Optional descriptive body text. */
  description?: string;
  /** Confirm-button label (default "Bestätigen"). */
  confirmLabel?: string;
  /** Cancel-button label (default "Abbrechen"). */
  cancelLabel?: string;
  /** When true, confirm button uses .btn-danger styling. */
  danger?: boolean;
  /** Confirm handler — may return a Promise. Spinner shows while pending. */
  onConfirm: () => void | Promise<void>;
  /** Optional cancel handler. */
  onCancel?: () => void;
}
```

`ConfirmDialog` composes `<Modal>` + a `<Spinner>` and is the canonical replacement for `window.confirm()` on destructive actions. While `onConfirm` is awaiting, the buttons are disabled and a spinner renders before the confirm label (label STAYS, no swap to "Wird gespeichert…").

Usage:

```svelte
<script>
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";

  let confirmState = $state<{ open: boolean; id: string | null }>({ open: false, id: null });

  async function deleteRow() {
    if (!confirmState.id) return;
    await api.delete(`/shutdowns/${confirmState.id}`);
    await reload();
  }
</script>

<button class="btn btn-ghost btn-sm btn-danger" onclick={() => (confirmState = { open: true, id: row.id })}>
  Löschen
</button>

<ConfirmDialog
  bind:open={confirmState.open}
  title="Betriebsurlaub löschen?"
  description="Diese Aktion kann nicht rückgängig gemacht werden."
  confirmLabel="Löschen"
  danger
  onConfirm={deleteRow}
/>
```

### `<Spinner>`

Source: `$components/ui/Spinner.svelte`

```ts
interface Props {
  /** Optional pixel size (default 14). */
  size?: number;
  /** Accessible label (default "Wird geladen"). */
  label?: string;
}
```

Tiny inline SVG arc that spins via CSS `animation: spinner-rotate 800ms linear infinite`. Respects `prefers-reduced-motion` by falling back to a static, dimmed dot. Inherits `currentColor` so it works inside any button variant.

#### Loading-button pattern (keep label)

When a button enters a loading state, **keep the original label** and prefix it with `<Spinner />`. Do NOT swap to "Speichert…" / "Lädt…":

```svelte
<script>
  import Spinner from "$components/ui/Spinner.svelte";
  let saving = $state(false);
</script>

<button class="btn btn-primary" onclick={save} disabled={saving}>
  {#if saving}<Spinner />{/if}
  Speichern
</button>
```

This avoids layout shift, keeps the affordance stable, and aligns with the design system's "calm" tone.

## Import paths

All primitives use the `$components` alias:

```ts
import Card from "$components/ui/Card.svelte";
import CardHeader from "$components/ui/CardHeader.svelte";
import Modal from "$components/ui/Modal.svelte";
import MonthBar from "$components/ui/MonthBar.svelte";
import KPIStat from "$components/ui/KPIStat.svelte";
import ApprovalRow from "$components/ui/ApprovalRow.svelte";
import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
import Spinner from "$components/ui/Spinner.svelte";
import PageHead from "$components/layout/PageHead.svelte";
```

## Lint gates

The custom `pnpm --filter @clokr/web lint:ui` script enforces these rules. It runs in pre-commit (lint-staged) and in CI (`.github/workflows/`). See `apps/web/scripts/lint-ui.mjs` for the implementation.

The script blocks PRs that:

- Add a `+page.svelte` under `(app)/` that does NOT include `<PageHead>`.
- Use raw `<h1>` outside `PageHead.svelte`.
- Use inline `style="…"` containing `color:`, `background:`, `background-color:`, or `border:` declarations. CSS custom property passthrough (`--card-idx:`, `--leave-type-*`, etc.) is allowed.
- Use any of the banned raw classes (`.modal-backdrop`, `.modal-card`, `.modal-header`, `.modal-body`, `.modal-footer`, `.card-hd`, `.card-title`, `.card-sub`, `.month-bar`, `.month-bar-stats`, `.mstat`, `.approval-row`) outside the corresponding primitive component.

Escape-hatch: prefix the offending line with `<!-- eslint-disable-next-line clokr/ui-no-raw-class -->` and a justification comment. Anything escape-hatched will be scrutinized in code review.

## Migration history

Phase 34 (`ui-primitives-lint-gates`) introduced these six primitives + the `<PageHead>` `autoAccent` behavior. The migration playbook, wave-by-wave plans, and rationale for each decision are archived under `.planning/phases/34-ui-primitives-lint-gates/`.

The lint script (`apps/web/scripts/lint-ui.mjs`) enforces the four D-04 rules listed above. During Phase 34's migration window, the CI step ran with `continue-on-error: true` and the pre-commit hook ran with `LINT_UI_SOFT=1` to let waves 4-9 land incrementally. The strict-mode flip is tracked in `34-16-SUMMARY.md` — see that summary for the residual violations that remain in non-migrated routes (admin/shifts, the auth pages, redirect stubs) and the path to flipping the gate to hard-fail.
