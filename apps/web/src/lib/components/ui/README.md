# UI Primitives — Canonical Spec

> **Status: the twelve blocks of Issue #843 are built (design system v2).**
> Each block of the Designkonzept exists exactly once in this directory, with one public entry component (see "The twelve blocks" below). Adding a thirteenth block, a second implementation of one, or a breaking change of a block's props requires a follow-up phase plan and justification. Bug-fixes and additive props are permitted without a phase plan.

This directory is the **enforceable contract** for Clokr UI. If a page builds a raw card / modal / KPI / month-bar / approval-row by hand, it bypasses this spec and lint rules will block the PR.

Read [`/docs/design/README.md`](../../../../docs/design/README.md) for the visual language. This README documents the _components_ — what to import, how to call them, what props they accept.

## Typography (Issue #842)

Text is Figtree, upright, with tabular numerals everywhere; JetBrains Mono is for code and raw data only.
There is no serif face and no italic. `<em>` renders upright (app.css reset), so an "accent" word is set
apart by colour, not by slant. Colours and sizes come from `tokens.css` roles (`--text`, `--brand`, `--fs-*`).

## Rules

- Every `(app)/` page MUST use `<PageHead>` from `$components/layout/PageHead.svelte`.
- No raw `<h1>` outside `ui/PageHeader.svelte` (`layout/PageHead.svelte` delegates to it, #843).
- No inline `style="color: …; background: …; background-color: …; border: …"` declarations — use theme tokens via class names. CSS custom property passthrough (`style="--card-idx: 3;"`) is allowed.
- No raw `.scrim`, `.modal`, `.modal-hd`, `.modal-body`, `.modal-foot`, `.card-hd`, `.card-title`, `.card-sub`, `.month-bar`, `.month-bar-stats`, `.mstat`, `.approval-row` class usage in route files. Go through the primitive. (Note: the Modal primitive emits `.scrim` + `.modal` + `.modal-hd` + `.modal-body` + `.modal-foot` to match the canonical app.css recipe.)
- Escape-hatch: `<!-- eslint-disable-next-line clokr/ui-no-raw-class -->` with a justification comment. PR review will scrutinize.

## The twelve blocks (Issue #843)

Every block is a Svelte 5 component built on bits-ui (the only primitive library, exact pin in `apps/web/package.json`) and styled with scoped CSS on the `tokens.css` roles. Pages use the entry component; the sub-parts are listed so nobody builds them again. The example page `/admin/bausteine` renders every block in all six theme × mode frames and is the visual and keyboard proof.

| #   | Block             | Entry component                              | Sub-parts                                                                                             | Legacy delegates (props kept)                                          |
| --- | ----------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Seitenkopf        | `PageHeader`                                 | `PageTabs` (page tabs, bits-ui Tabs)                                                                  | `layout/PageHead` (markup-free, same props, D-843-14)                  |
| 2   | Periodenwahl      | `PeriodPicker`                               | zoom `SegmentedControl`                                                                               | `MonthBar`, `PeriodSwitcher`                                           |
| 3   | Kennzahlenleiste  | `KpiStrip`                                   | `KpiCell` (label · value · explanation · „Herleitung →“)                                              | `KPIStat` (renders a `KpiCell`)                                        |
| 4   | Bühne             | `Stage`                                      | `actions` snippet                                                                                     | —                                                                      |
| 5   | Liste             | `List`                                       | `ListRow` (`default` and `task` variant)                                                              | —                                                                      |
| 6   | Tabelle + Toolbar | `DataTable`                                  | `TableToolbar`, `SortHeader`, `$lib/table/url-state.ts`, `$lib/table/search.ts`                       | —                                                                      |
| 7   | Formular-Satz     | `FormField`                                  | `SaveBar`, `SegmentedControl` (the Segment), `Combobox`, `DatePicker`, `DayGrid`, `BulkPreviewDialog` | —                                                                      |
| 8   | Chips & Hinweise  | `Chip`                                       | `Note`                                                                                                | the `.badge-*` recipes in `app.css` stay as written                    |
| 9   | Rückmeldung       | `Toast` (mounted once in the root layout)    | `ToastItem`, the `toasts` store (`success` / `error` / `info`), `$lib/feedback/action-messages.ts`    | —                                                                      |
| 10  | Zustände          | `Skeleton`                                   | `EmptyState` (`noData` / `noMatches`), `ErrorState`                                                   | —                                                                      |
| 11  | Dialog / Sheet    | `Dialog`                                     | `DialogPanel` (the bare panel for the example page)                                                   | `Modal`, `ConfirmDialog`, `ReasonDialog` (wrappers, callers untouched) |
| 12  | Bewegung          | `$lib/motion` (`fade`, `countUp`, `stagger`) | `reducedMotion` store                                                                                 | `.card-animate` reveal (steps 35 ms)                                   |

### Block rules

- **One block, one implementation.** A page never builds its own filter bar, period arrows, KPI card, data table toolbar, scrim or modal. `lint:ui-classes` scans routes and area components for exactly these patterns against the falling-only ratchet register `apps/web/scripts/lint-ui-classes-route-ratchet.json` (every entry names the page ticket #845–#854 that migrates it; a new occurrence fails). Raw `.scrim` / `.modal` markup has no register.
- **Container breakpoints are 760 and 1100 px, nothing else** (`ui/breakpoints.ts`). Blocks change layout through `@container`, written as `max-width: 759.98px` / `min-width: 760px`. Viewport media queries exist only for the Dialog → bottom-sheet switch and, as the one named exception, `PeriodPicker`, which keeps the narrow-viewport rules of the old `MonthBar` (D-843-21; a container on its root would collapse inside content-sized flex parents).
- **Ids come from `$props.id()`** (`FormField`, `DayGrid`, `TableToolbar`; `Combobox` and `DatePicker` take the id `FormField` passes in); never a module counter or a literal id.
- **Skeleton is the only loading state.** No visible „Laden…“ text anywhere (`no-loading-text-843.test.ts`). `Skeleton` renders `role="status"`, `aria-busy` and one visually hidden „Wird geladen“; shapes `line`, `block`, `row`, `card`, plus `inline` inside a sentence. `Spinner` stays only inside a button that runs an action (keep the label, prefix the spinner).
- **Every write acknowledges its result through `toasts`.** Success: `toasts.success(...)` after the server answered, 2.6 s, text from `action-messages.ts` for the start pages; error: `toasts.error(...)` names what happened and what to do, stays 6 s with a close button. The live regions are mounted empty at app start (`data-toast-root`): success and info `role="status"`, errors `role="alert"`.
- **No native browser dialogs** (`lint:no-alert`): a confirmation is a `ConfirmDialog`, a message a toast or a `Note`.
- **Dialogs portal to `body`** above the topbar (overlay 1500, content 1501, toast 9999), the rest of the page becomes `inert` while one is open, focus is trapped and returned by bits-ui. Escape is a document-level key event. A dialog below 760 px viewport width is a bottom sheet.
- **Colours only from `tokens.css` roles.** `--accent` is a fill, text on a solid status fill uses `--card`, on a brand fill `--brand-ink`. No italics, no uppercase, no letter-spacing in new block CSS. Every text pair of a chip, badge, note, eyebrow, toast, KPI band and Stage is pinned at 4.5:1 in all six combinations (`recipe-contrast-843.test.ts`).
- **Motion is off under `prefers-reduced-motion`** (one `reducedMotion` store; `app.css` has one reduced-motion block). `countUp` writes only the first text node of its element.
- **Tailwind is a token pipeline only.** Utilities are permitted inside `lib/components/ui`, but the blocks are scoped CSS by default; a route with a utility class fails `no-route-utilities-843.test.ts`. The mapping lives in `src/tailwind-theme.css`.
- **No `{@html}`.** Block text is rendered as text (guarded by source tests).

### `<PageHeader>` and `<PageTabs>`

Source: `$components/ui/PageHeader.svelte`, `PageTabs.svelte`. Props: `title`, `subtitle?`, `eyebrow?` and `accent?` (both inert since D-843-22: accepted so `PageHead` callers compile, never rendered), `actions?` (one or two buttons, at most one primary), `tabs?` + `tab` (bindable) + `panel?` + `onTabChange?` (bits-ui Tabs, arrow keys loop, every trigger controls a rendered panel), `headingLevel?` (1 or 2). The `<PageHead>` section below documents the legacy props and the look; `layout/PageHead.svelte` has no markup of its own.

`PageTabs` can also be used on its own (Issue #853, D-853-05, D-853-11): a page places it **directly after its `PageHead`** (PageHead has no tabs prop). Tab items take `value`, `label` and the optional `href`, `testId`, `badge`, `badgeLabel`, `onBadgeSelect`; the component takes `tabsLabel` and the optional `testIdPrefix`.

- **Link mode:** every tab has an `href` and no `panel` is passed. The strip is a `<nav aria-label={tabsLabel}>` of anchors, the tab whose `value` equals `tab` carries `aria-current="page"`; there is no ARIA tablist and no panel. Use it when each tab is a route of its own.
- **Panel mode** (unchanged): bits-ui Tabs with the panels on the page.
- **Test-id contract (#840):** with `testIdPrefix` the strip is `<prefix>-tabs`, a tab `<prefix>-<testId ?? value>`, its count `<prefix>-<tab>-badge`. The count is a `[data-tab-count]` span (plus the visually hidden `badgeLabel`); a pointer click on it selects the tab and then calls `onBadgeSelect` (keyboard activation does not).

### `<Dialog>`

Source: `$components/ui/Dialog.svelte`. Props: `open` (bindable), `title`, `eyebrow?`, `ariaLabel?`, `size?` (`"md"` 520 px, `"wide"` 880 px), `children`, `footer?` (secondary first, primary last), `onOpenChange?`. The legacy class names (`scrim`, `modal`, `modal-hd`, `modal-body`, `modal-foot`, `modal--wide`) are still emitted. A parent binding that refuses a closing (`ConfirmDialog` while a confirm is pending) keeps the dialog open. `Modal`, `ConfirmDialog` and `ReasonDialog` render it; their props, the Phase 89 refusal behaviour of `ConfirmDialog` and all callers are unchanged.

### `<KpiStrip>`, `<KpiCell>`, `<Stage>`

Sources: `KpiStrip.svelte` (`items`, `band?`, `ariaLabel?`), `KpiCell.svelte` (`label`, `value` string or number — a number counts up —, `format?`, `unit?`, `explanation?`, `derivationHref?`, `delta?` + `deltaTone?`, `progress?`), `Stage.svelte` (`state` `ruhig | arbeitet | pause | fertig` on card / brand-soft / warn-soft / card with a 350 ms transition, `children`, `actions?`, `ariaLabel?`). `KPIStat` keeps its 38 px look and strings and renders a `KpiCell`.

### `<List>`, `<ListRow>`

Sources: `List.svelte` (`ariaLabel`, `children`), `ListRow.svelte` (`title`, `subtitle?`, `avatar?` + `avatarKey?`, `variant` `default | task`, `href?`, `trailing?`, `actions?`). 44 px rows with a stable avatar colour; the `task` variant puts the buttons under the text.

Additive props (Issue #853, all optional, output unchanged without them): `List.testId?` (`data-testid` of the `ul`); `ListRow.meta?` (chips under the subtitle, both variants; in the `task` variant between subtitle and actions), `rowId?` (`id` of the `li`, a deep-link target), `testId?`, `kind?` (`data-kind`, a control value never shown), `highlight?` (tints the row with `--brand-tint`), `onPrimary?` (the title becomes the row's one `<button type="button">`, stretched over the row; `actions` and `trailing` stay siblings above it so nothing interactive is nested; same pattern as `ApprovalRow.onPrimary`, ignored when `href` is set).

### `<DataTable>`, `<TableToolbar>`, `<SortHeader>`

Sources: `DataTable.svelte` (`columns`, `rows`, `rowKey`, `cell?`, `sort` + `onSort` with the exported `nextSortState` cycle none → asc → desc → none, `filtered` + `onResetFilters` for „keine Treffer“, `onRowClick?`, `rowTestId?`, `toolbar?`, `caption`, `loading?`), `TableToolbar.svelte` (`query` bindable, `count`, `total`, `filters?`, `onFilterChange?`, `onReset?`), `SortHeader.svelte` (`aria-sort`, button „Nach <Spalte> sortieren“). Additive prop (#853): `rowTone?: (row) => "warn" | "info" | "highlight" | undefined` puts `data-tone` on the row (table and card layout), tinted by the block with `--warn-soft`, `--info-soft`, `--brand-tint`; a page never styles DataTable internals. One table DOM with a horizontal scroll container; below 760 px container width the rows render as cards. State lives in the URL through `urlState(schema)` of `$lib/table/url-state.ts` (allow-list parsers `text`, `oneOf`, `pattern`, `int`; unknown keys are dropped, other keys of the URL are kept). The search text is normalised in one place, `matchesSearch()` of `$lib/table/search.ts`. Loading shows the Skeleton in place of the table; an empty result says „keine Daten“ or „keine Treffer“ with „Filter zurücksetzen“. First adopter: `/admin/employees`.

### `<Chip>`, `<Note>`

Sources: `Chip.svelte` (`tone` `ok | warn | bad | info | brand | neutral`, `title?`, `children`; 22 px pill with a dot) and `Note.svelte` (`tone` `ok | warn | bad | info | brand`, `icon?`, `children`; soft-colour hint line). The `.badge-*` recipes stay as written in `app.css`; the chip tones declare their own proven pairs.

### `<Toast>`, `<Skeleton>`, `<EmptyState>`, `<ErrorState>`

Sources: `Toast.svelte` (the container with the two persistent live regions, mounted once; items are `ToastItem`), `Skeleton.svelte` (`shape`, `count?`, `lines?`, `height?`, `inline?`, `width?`), `EmptyState.svelte` (`title?`, `description?`, `actionLabel?` + `onaction?`, `variant?` `noData | noMatches`) plus `action?: Snippet` (#853: rendered in place of the action button, e.g. a person picker), `ErrorState.svelte` (`message?`, `hint?`, `onRetry`, `retrying?`; a bad `Note` with „Erneut versuchen“).

### `$lib/motion`

`fade` (350 ms crossfade for state changes), `countUp` (500 ms ease-out action), `stagger` (35 ms offset, folded into the `.card-animate` reveal), `reducedMotion` (store). All of them do nothing under `prefers-reduced-motion` or without `matchMedia`.

## Primitives

### `<PageHead>`

Source: `$components/layout/PageHead.svelte` — since Issue #843 a delegate without markup of its own: it renders `ui/PageHeader.svelte` with the same props (D-843-14). New code may import `PageHeader` directly.

**Look (D-843-22, owner request 10.11., design concept 3/4):** title (H1, `--fs-h1` = 20 px, weight 600, plain text) and an optional subtitle (`--fs-base` = 13.5 px, `--text-2`) on the left, one or two actions on the right, below the text on a phone (the block's 760 px container query). There is NO accent rule, NO eyebrow line and NO colour-set accent word. `eyebrow` and `accent` stay in the props only so the 50+ callers and the tests that pin `<PageHead eyebrow=… title=…>` compile and pass unchanged; they are inert and render nothing.

```ts
interface Props {
  /** Inert (D-843-22): accepted, never rendered. */
  eyebrow?: string;
  /** Main heading, e.g. "Guten Tag, Lena". Plain text. */
  title: string;
  /** Inert (D-843-22): accepted, never rendered; the title has no accent word. */
  accent?: string;
  /** Optional muted sub-paragraph, max-width 560 px, below the H1. */
  sub?: string;
  /** Optional right-aligned action cluster (buttons) on the same row as the H1. */
  actions?: Snippet;
}
```

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
  /** Optional eyebrow text rendered below the title (upright). */
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
  /** Eyebrow above the title (upright). */
  eyebrow?: string;
  /** H3 title (Figtree). */
  title: string;
  /** Overrides title for aria-label, if a richer accessible name is needed. */
  ariaLabel?: string;
  /** Body content (default slot). */
  children: Snippet;
  /** Optional footer with action buttons (right-aligned). */
  footer?: Snippet;
  /** Issue #612 — additive. "md" (default) keeps the global `.modal` width; "wide" adds `modal--wide` (`min(880px, calc(100vw - 32px))`). */
  size?: "md" | "wide";
}
```

Modal renders `<Dialog>` (Issue #843, D-843-16) and keeps its props. The block owns:

- **Escape key** (a document-level key event) → sets `open=false`
- **Backdrop click** → sets `open=false` (press inside the dialog and release on the overlay does not close)
- **Focus trap and focus return** (bits-ui), and **`inert` on the rest of the page** while open
- **Portal to `body`** above the topbar, so no ancestor transform (#570) can trap it
- **Initial focus** (Issue #612, additive): the first element inside the dialog that carries `data-autofocus` (and is not disabled); a modal without the attribute focuses its first focusable element as before.

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
  /** Optional eyebrow above the bar (upright). */
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
  /** Issue #612 — additive. Text shown instead of the month derived from `date` (e.g. "Jul – Sep 2026"). */
  label?: string;
  /** Issue #612 — additive. aria-label AND title of the previous arrow (default "Vorheriger Monat"). */
  prevLabel?: string;
  /** Issue #612 — additive. aria-label AND title of the next arrow (default "Nächster Monat"). */
  nextLabel?: string;
  /** Issue #612 — additive. Real `disabled` next arrow; its title is `NEXT_PERIOD_DISABLED_TITLE` (exported from the component's module script). */
  nextDisabled?: boolean;
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

### `<PeriodPicker>`

Source: `$components/ui/PeriodPicker.svelte`

Issue #843 (D-843-01 block 2): the one period control. Controlled: prev / label / next with 44 px targets, optional „Heute“, optional zoom Segment (`zooms` in display order from `jahr`, `quartal`, `monat`, `woche`; shown from two levels on, `zoom` bindable, `onZoom`). It emits the legacy `.month-bar` DOM and the `{prefix}`, `{prefix}-prev|next|today|label` test ids; `MonthBar` and `PeriodSwitcher` render it and keep their props. `aside` takes content that is not the period (MonthBar's stats), `extra` trailing actions of the nav row, `onLabelClick` + `labelOverlay` turn the label into a button with an overlay (MonthBar's month grid).

```ts
interface Props {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday?: () => void;
  prevLabel?: string; // default "Vorheriger Zeitraum"
  nextLabel?: string; // default "Nächster Zeitraum"
  nextDisabled?: boolean;
  testIdPrefix?: string; // default "month-bar"
  eyebrow?: string;
  zooms?: ("jahr" | "quartal" | "monat" | "woche")[];
  zoom?: "jahr" | "quartal" | "monat" | "woche"; // bindable
  onZoom?: (zoom) => void;
}
```

### `<PeriodSwitcher>`

Source: `$components/ui/PeriodSwitcher.svelte`

Phase 840 (Issue #840, D-840-13): one period control for all leave views; a wrapper around PeriodPicker (Issue #843), no new recipe. It renders ‹ label › Heute for a year, a quarter or a month and emits no markup or class of its own, so every `.month-bar` rule and the narrow-viewport proofs (Issue #553/#564) apply unchanged.

```ts
interface Props {
  /** The shown period (`periodOf(zoom, datum)` from `$lib/leave/timeline-model`). */
  period: Period;
  /** Move one period back (-1) or forward (1). */
  onShift: (step: -1 | 1) => void;
  /** "Heute" jump-to-today handler. */
  onToday: () => void;
  /** Real disabled next arrow (PeriodPicker `nextDisabled`). */
  nextDisabled?: boolean;
  /** PeriodPicker test-id prefix (default "month-bar"). */
  testIdPrefix?: string;
}
```

Labels: „2026“ / „Q4 2026 · Okt–Dez“ / „November 2026“; arrow names „Vorheriges/Nächstes Jahr|Quartal“, „Vorheriger/Nächster Monat“.

### Formular-Satz: `<FormField>`, `<SaveBar>`, `<DayGrid>`

Sources: `$components/ui/FormField.svelte`, `SaveBar.svelte` (+ `save-bar.ts`), `DayGrid.svelte` (Issue #843, D-843-01 block 7; `SegmentedControl` is the Segment of this set).

- `FormField` (`label`, `help?`, `error?`, `required?`, `field` snippet): the snippet receives `{ id, describedBy, invalid }` and puts them on the page's own control (`aria-describedby={describedBy}`, `aria-invalid={invalid ? "true" : undefined}`). Ids come from `$props.id()`.
- `SaveBar` (`changes`, `errors`, `saving?`, `saveLabel`, `onSave`, `onDiscard`): the section-button rule of `docs/ADMIN_STRUCTURE.md` §3.2.1 as code. Hidden at 0 changes; the save button is disabled while `errors > 0` or `saving`; `saveLabel` says what happens („Vertrag speichern“). The German phrase and the `canSave` rule live only in `save-bar.ts`. No page adopts it yet.
- `DayGrid` (`value` bindable `{ mon … sun }` hours or `null`, `label`, `step?`, `disabled?`, `onchange?`): Mo…So fields, live sum in German notation („39,5 h“), a field error outside 0…24 (feedback only, the API validates).

### Bulk change preview: `<BulkPreviewDialog>`

Source: `$components/ui/BulkPreviewDialog.svelte` (Issue #843, D-843-01 block 7). The pattern helper for a write that touches many records: a wide `Dialog` with the count sentence („Betrifft 12 Personen“), the caller's `list` snippet, „Gilt ab 01.12.2026“ formatted from a caller-given ISO `effectiveDate` (the block computes no date; the server's preview decides, § 3 NachwG, #568) and a footer „Abbrechen“ + the confirm button (`confirmLabel` says what happens). Props: `open` (bindable), `title`, `eyebrow?`, `count`, `effectiveDate?`, `confirmLabel`, `pending?`, `loading?`, `onConfirm`, `onCancel?`, `list`, `intro?`, `extraActions?`. Confirm is disabled at `count` 0, while `pending` or while `loading`; `loading` shows the Skeleton instead of count and list. First adopter: `admin/BulkApplyDialog.svelte`.

### Pickers: `<Combobox>`, `<DatePicker>`

Sources: `$components/ui/Combobox.svelte`, `DatePicker.svelte`, `$lib/table/search.ts` (Issue #843, D-843-01 block 7). Import them only where used, never through a barrel (bundle, D-843-17).

- `Combobox` (`items: { value, label }[]`, `value` bindable string, `label?`, `placeholder?`, `disabled?`, FormField attrs `id`, `describedBy`, `invalid`): the first ArrowDown opens the list (it does not select), and so does typed text that arrives without a key press (paste, IME, autofill; #853 - bits-ui opens on keydown only); arrows move, Enter selects. The list is filtered by `matchesSearch()` of `lib/table/search.ts`, the one search normaliser (trim + `toLocaleLowerCase("de")`), also used by the table toolbar. No match says „Keine Treffer“.
- `DatePicker` (`value` bindable ISO `YYYY-MM-DD` or `null`, `label`, `min?`, `max?`, `disabled?`, FormField attrs, `open?`): German segments, weeks start on Monday, weekday heads keyed by index. `@internationalized/date` is used inside only; the page sees ISO strings. An unparsable string reads as empty. The popover cannot be opened by a synthetic click in jsdom; unit tests pass `open`, the real opening is proven in the e2e.

### `<KPIStat>`

Source: `$components/ui/KPIStat.svelte`

```ts
interface Props {
  /** 11px UPPERCASE faint label. */
  label: string;
  /** Hero value, tabular Figtree numerals (formatted by caller — pass a string, not a number). */
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
  /** Issue #612 — additive. Primary-action mode: the name becomes the row's one link (stretched over the row). Wins over `onclick`. */
  primaryHref?: string;
  /** Issue #612 — additive. Accessible name of the primary link (default: `name`). */
  primaryLabel?: string;
  /** Issue #612 — additive. Click handler of the primary link; see the interception contract below. */
  onPrimaryClick?: (e: MouseEvent) => void;
  /** Issue #840 — additive. Primary-button mode: the name becomes the row's one `<button>` (stretched over the row). Wins over `onclick`, loses against `primaryHref`. */
  onPrimary?: () => void;
  /** Right-aligned action buttons. */
  actions?: Snippet;
  /** Optional richer meta content (chip + text) when a plain string isn't enough. */
  metaContent?: Snippet;
}
```

Rendered DOM (matches design handoff §4 approval row, 4-col grid 44px 1fr auto auto):

```html
<div class="approval-row" role="button" tabindex="0" onclick="…">
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

#### Primary-action mode (`primaryHref`, Issue #612 — additive)

With `onclick` the row is a `<button>` and `actions` end up INSIDE it — a button in a button, which is
invalid HTML and breaks keyboard and assistive technology. A row that carries `actions` therefore uses
`primaryHref` instead:

- the root is a `div` (never a button); the name is the only link (`a.approval-name.approval-primary`,
  `data-sveltekit-noscroll`), stretched over the whole row with `::after`; focus is drawn on the whole row;
- `actions` render as a SIBLING of the link, above the stretched area (`z-index: 1`), so they stay
  separately clickable, come right after the link in tab order and need no `stopPropagation`;
- `primaryLabel` is the link's accessible name (e.g. „Anna Muster – Personenansicht öffnen“),
  default `name`; when `primaryHref` and `onclick` are both passed, `primaryHref` wins;
- **Interception contract:** the link is a real `href`, so a middle click or ctrl/cmd-click opens a new tab.
  A caller that wants an in-page navigation (history push, modal) passes `onPrimaryClick`, checks
  `isPlainLeftClick(e)` (`$lib/reports/period-state.ts`), calls `e.preventDefault()` only for the plain
  click, and leaves modified clicks alone.

```svelte
<ApprovalRow
  avatar="AM"
  name="Anna Muster"
  dates="Rest 13 T."
  primaryHref="/reports?from=2026-10&to=2026-10&person=…"
  primaryLabel="Anna Muster – Personenansicht öffnen"
  onPrimaryClick={(e) => {
    if (!isPlainLeftClick(e)) return;
    e.preventDefault();
    openDrilldown(id);
  }}
>
  {#snippet actions()}
    <button type="button" class="btn btn-ghost xs">Hinweis senden</button>
  {/snippet}
</ApprovalRow>
```

#### Primary-button mode (`onPrimary`, Issue #840 — additive)

The in-page twin of `primaryHref`, for a row that opens a dialog or a panel instead of navigating and also
carries `actions` (the inbox rows). The `onclick` mode puts `actions` inside a `<button>`, which axe reports as
`nested-interactive`; `onPrimary` keeps every control a sibling:

- the root is a `div` (never a button); the name is the only control (`button.approval-name.approval-primary`,
  `type="button"`), stretched over the whole row with `::after`; focus is drawn on the whole row;
- `actions` render as SIBLINGS of that button, above the stretched area (`z-index: 1`), so they stay separately
  clickable, come right after it in tab order and need no `stopPropagation`;
- Enter and Space on the focused name call `onPrimary` (native button behaviour); `primaryLabel` is the
  button's accessible name, default `name`;
- precedence when several are passed: `primaryHref` > `onPrimary` > `onclick`.

```svelte
<ApprovalRow
  avatar="LM"
  name="Lena Müller"
  dates="12.04. – 18.04. · 5 Tage"
  onPrimary={() => openDetail(req)}
>
  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm" onclick={() => openDetail(req)}
      >Prüfen</button
    >
  {/snippet}
</ApprovalRow>
```

### `<ConfirmDialog>`

Source: `$components/ui/ConfirmDialog.svelte`

```ts
interface Props {
  /** Bindable open state. Parent owns the boolean. */
  open: boolean;
  /** H3 title in Figtree (e.g. "Betriebsurlaub löschen?"). */
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

<button
  class="btn btn-ghost btn-sm btn-danger"
  onclick={() => (confirmState = { open: true, id: row.id })}
>
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
import Dialog from "$components/ui/Dialog.svelte";
import DataTable from "$components/ui/DataTable.svelte";
import Skeleton from "$components/ui/Skeleton.svelte";
```

## Lint gates

The custom `pnpm --filter @clokr/web lint:ui` script enforces these rules. It runs in pre-commit (lint-staged) and in CI (`.github/workflows/`). See `apps/web/scripts/lint-ui.mjs` for the implementation.

The script blocks PRs that:

- Add a `+page.svelte` under `(app)/` that does NOT include `<PageHead>`.
- Use raw `<h1>` outside `PageHead.svelte`.
- Use inline `style="…"` containing `color:`, `background:`, `background-color:`, or `border:` declarations. CSS custom property passthrough (`--card-idx:`, `--leave-type-*`, etc.) is allowed.
- Use any of the banned raw classes (`.modal-backdrop`, `.modal-card`, `.modal-header`, `.modal-body`, `.modal-footer`, `.card-hd`, `.card-title`, `.card-sub`, `.month-bar`, `.month-bar-stats`, `.mstat`, `.approval-row`) outside the corresponding primitive component.

Escape-hatch: prefix the offending line with `<!-- eslint-disable-next-line clokr/ui-no-raw-class -->` and a justification comment. Anything escape-hatched will be scrutinized in code review.

Further gates since Issue #843:

- `pnpm --filter @clokr/web lint:ui-classes` also scans `src/routes` and the area components under `lib/components` (outside `ui/` and `layout/`) for page-own filter bars, period controls, KPI cards and data tables against `apps/web/scripts/lint-ui-classes-route-ratchet.json`; the counts may only fall.
- `pnpm --filter @clokr/web lint:no-alert` fails on `alert(`, `confirm(` and `prompt(` in `apps/web/src` outside tests.
- `lint:tokens` carves out exactly `src/tailwind-theme.css` from the `--color-` / `--radius-` prefix rule.

## Migration history

Phase 34 (`ui-primitives-lint-gates`) introduced these six primitives + the `<PageHead>` `autoAccent` behavior. The migration playbook, wave-by-wave plans, and rationale for each decision are archived under `.planning/phases/34-ui-primitives-lint-gates/`.

The lint script (`apps/web/scripts/lint-ui.mjs`) enforces the four D-04 rules listed above. During Phase 34's migration window, the CI step ran with `continue-on-error: true` and the pre-commit hook ran with `LINT_UI_SOFT=1` to let waves 4-9 land incrementally. The strict-mode flip is tracked in `34-16-SUMMARY.md` — see that summary for the residual violations that remain in non-migrated routes (admin/shifts, the auth pages, redirect stubs) and the path to flipping the gate to hard-fail.
