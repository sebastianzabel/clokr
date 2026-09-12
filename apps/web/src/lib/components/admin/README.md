# Admin Layout Primitives

> **Status: ACTIVE (Phase 50, v1.6.1).**
> These five components are the canonical page-shell and section-card primitives for all admin routes.
> Consuming a route MUST use one of the three page shells (`SectionStack`, `ListDetail`, or `ToolPage`)
> instead of building a layout by hand.

This directory provides the **enforceable contract** for admin-area layouts. If an admin route builds
raw sections, headings, or tab strips by hand it bypasses this spec and will fail the lint gate
introduced in Phase 52.

Read [`docs/ADMIN_STRUCTURE.md`](/docs/ADMIN_STRUCTURE.md) for the Admin Area Regulatorium — the
authoritative IA guide that governs when to use each template.

---

## Components

### `<Section>`

Source: `apps/web/src/lib/components/admin/Section.svelte`

Section is the atomic card primitive that replaces the legacy `<Card animate><CardHeader title sub/>`
pattern in all admin pages. It owns the title/sub/actions/footer structure and is the composable
building block that `SectionStack`, `ListDetail`, and `ToolPage` fill their page columns with. The
`tone="danger"` escape hatch exists to mark a section as dangerous; prefer `<DangerZone>` over
setting `tone="danger"` directly — DangerZone locks the tone and supplies the correct default title.

```ts
interface Props {
  title?: string;
  sub?: string;
  actions?: Snippet;
  footer?: Snippet;
  animate?: boolean;
  tone?: "default" | "danger";
  dirty?: boolean;
  children: Snippet;
}
```

**Snippets:**

| Name       | Required | Description                                                   |
| ---------- | -------- | ------------------------------------------------------------- |
| `children` | yes      | Section body content                                          |
| `actions`  | no       | Right-aligned action cluster in the section header row        |
| `footer`   | no       | Save-area stripe rendered below the body, separated by a rule |

**Props:**

| Name    | Required | Description                                                                                                  |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `dirty` | no       | Renders the "Nicht gespeichert" hint in the footer while the section holds unsaved changes (Phase 109, D-11) |

**`animate` context propagation (D-08):** When `Section` is a child of `SectionStack` or `ToolPage`,
`animate` is inherited from the `admin-animate` Svelte context set by the parent shell. Pass an
explicit `animate` prop to override the context.

**`footer` blast radius (Phase 109, N-03):** the `footer` snippet has **14** consumers across the
admin area, not the smaller count an earlier count assumed — any change to `Section`'s footer
markup (such as the `dirty` prop above) affects all of them: `admin/audit`, `admin/employees`,
`admin/employees/[id]`, `admin/export`, `admin/import`, `admin/integrations`, `admin/month-close`,
`admin/phorest`, `admin/shifts`, `admin/shutdowns`, `admin/shutdowns/[id]`, `admin/system`,
`admin/vacation`, `inbox`.

Usage:

```svelte
<script>
  import Section from "$lib/components/admin/Section.svelte";
</script>

<Section title="UNTERNEHMEN" sub="Firmenname & Region">
  <FormFields />
  {#snippet actions()}
    <button class="btn btn-ghost btn-sm">Vorschau</button>
  {/snippet}
  {#snippet footer()}
    <button class="btn btn-primary btn-sm">Speichern</button>
  {/snippet}
</Section>
```

---

### `<DangerZone>`

Source: `apps/web/src/lib/components/admin/DangerZone.svelte`

DangerZone is a thin wrapper around `<Section tone="danger">` that adopts GitHub's Danger Zone
pattern. It renders a red-tinted card with a default title of "Danger Zone" and is meant to be placed
as the **last child** in a `SectionStack` or as the **last tab panel** in a `ListDetail`. Callers
compose `ConfirmDialog` (from `$lib/components/ui/ConfirmDialog.svelte`) or a type-to-confirm input
around each destructive action — `DangerZone` itself does NOT render a dialog.

```ts
interface Props {
  title?: string;
  description?: string;
  animate?: boolean;
  actions: Snippet;
}
```

**Snippets:**

| Name      | Required | Description                                             |
| --------- | -------- | ------------------------------------------------------- |
| `actions` | **yes**  | Destructive action buttons and their confirmation flows |

Usage:

```svelte
<script>
  import DangerZone from "$lib/components/admin/DangerZone.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";

  let confirmOpen = $state(false);

  async function handleDelete() {
    await api.delete("/tenants/current");
  }
</script>

<DangerZone description="Irreversible Aktionen für diesen Mandanten.">
  {#snippet actions()}
    <button class="btn btn-danger" onclick={() => (confirmOpen = true)}>
      Daten zurücksetzen
    </button>
    <ConfirmDialog
      bind:open={confirmOpen}
      title="Daten zurücksetzen?"
      description="Diese Aktion kann nicht rückgängig gemacht werden."
      confirmLabel="Zurücksetzen"
      danger
      onConfirm={handleDelete}
    />
  {/snippet}
</DangerZone>
```

---

### `<SectionStack>`

Source: `apps/web/src/lib/components/admin/SectionStack.svelte`

SectionStack is the page shell for admin pages that display a vertical stack of `<Section>` cards —
settings pages, configuration panels, and any view where all content is accessible without
sub-navigation. It renders `<PageHead>` followed by a `<div class="page">` flex column. It sets the
`admin-animate` Svelte context so nested `<Section>` components inherit `card-animate` entrance
animations without requiring an explicit `animate` prop on each card.

```ts
interface Props {
  eyebrow: string;
  title: string;
  accent?: string;
  sub?: string;
  animate?: boolean;
  actions?: Snippet;
  children: Snippet;
  dangerZone?: Snippet;
}
```

**Snippets:**

| Name         | Required | Description                                                      |
| ------------ | -------- | ---------------------------------------------------------------- |
| `children`   | **yes**  | One or more `<Section>` cards in layout order                    |
| `actions`    | no       | Right-aligned action cluster next to the H1 in `<PageHead>`      |
| `dangerZone` | no       | `<DangerZone>` rendered after `children`, separated from content |

Usage:

```svelte
<script>
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import DangerZone from "$lib/components/admin/DangerZone.svelte";
</script>

<SectionStack eyebrow="Administration" title="Allgemein" animate>
  <Section title="UNTERNEHMEN" sub="Firmenname & Region">
    <FormFields />
    {#snippet footer()}
      <button class="btn btn-primary btn-sm">Speichern</button>
    {/snippet}
  </Section>

  <Section title="FEATURES">
    <FeatureToggles />
  </Section>

  {#snippet dangerZone()}
    <DangerZone description="Irreversible Aktionen für diesen Mandanten.">
      {#snippet actions()}
        <button class="btn btn-danger">Daten zurücksetzen</button>
      {/snippet}
    </DangerZone>
  {/snippet}
</SectionStack>
```

---

### `<ListDetail>`

Source: `apps/web/src/lib/components/admin/ListDetail.svelte`

ListDetail is the page shell for admin pages that follow the List+Detail navigation pattern — a
list view shows an overview (table, search, records) and a detail view shows one selected record
with optional tabbed sub-sections. The `view` prop discriminates between the two modes at the
template level. In detail mode the component optionally renders a `<Breadcrumb>` navigation, a
tab strip using the global `.view-tabs` recipe from `app.css`, and a per-tab content area.

Tab ARIA follows the ARIA 1.1 Tabs Pattern. IDs for `aria-controls` / `aria-labelledby` are
derived from `$props.id()` so multiple `ListDetail` instances on the same page never collide.
The `activeTab` prop is `$bindable()` — callers two-way bind it to control the tab from outside
(e.g. from a URL query param).

```ts
interface Props {
  view: "list" | "detail";
  eyebrow: string;
  title: string;
  accent?: string;
  sub?: string;
  actions?: Snippet;
  crumbs?: { label: string; href?: string }[];
  tabs?: { id: string; label: string }[];
  activeTab?: string;
  list?: Snippet;
  tabContent?: Snippet<[string]>;
}
```

**Snippets:**

| Name         | Required | Description                                                        |
| ------------ | -------- | ------------------------------------------------------------------ |
| `list`       | no       | List-mode body content (table, search bar, record rows)            |
| `tabContent` | no       | Called with `(tabId: string)` — render tab panel content by tab id |
| `actions`    | no       | Right-aligned action cluster next to the H1 in `<PageHead>`        |

**Keyboard navigation (detail mode):** When the tab strip is focused, `ArrowLeft` / `ArrowRight`
cycle through tabs (wrapping), `Home` jumps to the first tab, `End` jumps to the last.

Usage (list mode):

```svelte
<script>
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
</script>

<ListDetail eyebrow="Administration" title="Mandanten" view="list">
  {#snippet list()}
    <Section title="ALLE MANDANTEN">
      <TenantTable />
    </Section>
  {/snippet}
</ListDetail>
```

Usage (detail mode with tabs):

```svelte
<script>
  import { page } from "$app/stores";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import DangerZone from "$lib/components/admin/DangerZone.svelte";

  let activeTab = $state("general");

  const crumbs = [{ label: "Mandanten", href: "/admin/tenants" }, { label: tenantName }];

  const tabs = [
    { id: "general", label: "Allgemein" },
    { id: "billing", label: "Abrechnung" },
    { id: "danger", label: "Sicherheit" },
  ];
</script>

<ListDetail eyebrow="Administration" title="Mandant" view="detail" {crumbs} {tabs} bind:activeTab>
  {#snippet tabContent(tab)}
    {#if tab === "general"}
      <Section title="ALLGEMEIN">
        <TenantForm />
      </Section>
    {:else if tab === "billing"}
      <Section title="ABRECHNUNG">
        <BillingForm />
      </Section>
    {:else if tab === "danger"}
      <DangerZone description="Irreversible Aktionen.">
        {#snippet actions()}
          <button class="btn btn-danger">Mandant löschen</button>
        {/snippet}
      </DangerZone>
    {/if}
  {/snippet}
</ListDetail>
```

---

### `<ToolPage>`

Source: `apps/web/src/lib/components/admin/ToolPage.svelte`

ToolPage is the page shell for single-tool or wizard-style admin pages — data import/export,
report generation, batch operations, or any task with a clear start and end state. It renders
`<PageHead>` followed by an optional numbered step indicator, then the required `form` snippet,
and optional `result` and `history` snippets below it. When both `steps` and `currentStep` are
provided the step indicator shows above the form: active step uses `--brand` background, completed
steps use `--good` with a checkmark SVG, upcoming steps use muted border and text.

```ts
interface Props {
  eyebrow: string;
  title: string;
  accent?: string;
  sub?: string;
  animate?: boolean;
  actions?: Snippet;
  steps?: string[];
  currentStep?: number;
  form: Snippet;
  result?: Snippet;
  history?: Snippet;
}
```

**Snippets:**

| Name      | Required | Description                                                             |
| --------- | -------- | ----------------------------------------------------------------------- |
| `form`    | **yes**  | Main tool form / controls area (primary content)                        |
| `actions` | no       | Right-aligned action cluster next to the H1 in `<PageHead>`             |
| `result`  | no       | Output area rendered below the form (e.g. generated report or download) |
| `history` | no       | History / log area rendered last (e.g. past export runs)                |

Usage (no steps):

```svelte
<script>
  import ToolPage from "$lib/components/admin/ToolPage.svelte";
  import Section from "$lib/components/admin/Section.svelte";
</script>

<ToolPage eyebrow="Administration" title="Daten importieren">
  {#snippet form()}
    <Section title="DATEI HOCHLADEN">
      <ImportDropzone />
    </Section>
  {/snippet}
  {#snippet result()}
    <Section title="ERGEBNIS">
      <ImportResult />
    </Section>
  {/snippet}
</ToolPage>
```

Usage (with steps):

```svelte
<script>
  import ToolPage from "$lib/components/admin/ToolPage.svelte";
  import Section from "$lib/components/admin/Section.svelte";

  let currentStep = $state(0);

  const steps = ["Zeitraum", "Prüfen", "Exportieren"];
</script>

<ToolPage eyebrow="Administration" title="DATEV-Export" {steps} {currentStep}>
  {#snippet form()}
    {#if currentStep === 0}
      <Section title="ZEITRAUM WÄHLEN">
        <DateRangePicker />
      </Section>
      <button class="btn btn-primary" onclick={() => (currentStep = 1)}> Weiter </button>
    {:else if currentStep === 1}
      <Section title="PRÜFBERICHT">
        <ReviewTable />
      </Section>
      <button class="btn btn-primary" onclick={() => (currentStep = 2)}> Exportieren </button>
    {:else}
      <Section title="EXPORTIEREN">
        <ExportButton />
      </Section>
    {/if}
  {/snippet}
  {#snippet result()}
    <Section title="DOWNLOAD">
      <DownloadLinks />
    </Section>
  {/snippet}
</ToolPage>
```

---

## Import paths

```ts
import Section from "$lib/components/admin/Section.svelte";
import DangerZone from "$lib/components/admin/DangerZone.svelte";
import SectionStack from "$lib/components/admin/SectionStack.svelte";
import ListDetail from "$lib/components/admin/ListDetail.svelte";
import ToolPage from "$lib/components/admin/ToolPage.svelte";
```

---

## Which shell to use?

| Pattern                          | Shell          | When                                                         |
| -------------------------------- | -------------- | ------------------------------------------------------------ |
| All settings visible at once     | `SectionStack` | Settings, config, profile pages                              |
| Navigate from a list to a record | `ListDetail`   | Tenant list → tenant detail, employee list → employee detail |
| A focused task with a clear end  | `ToolPage`     | Import, export, report generation, bulk operations           |

When in doubt, consult [`docs/ADMIN_STRUCTURE.md`](/docs/ADMIN_STRUCTURE.md) — the Regulatorium
specifies exact criteria, anti-patterns, and rationale for each template choice.

---

## Token compliance

All components use v1.5 tokens only: `var(--bg-card)`, `var(--border)`, `var(--r-lg)`,
`var(--text)`, `var(--text-muted)`, `var(--brand)`, `var(--bad)`, `var(--bad-soft)`,
`var(--good)`, `var(--shadow-md)`, `var(--font-sans)`, `var(--font-serif)`, etc.

Legacy v1.2 token namespaces (`--color-*`, `--glass-*`, `--radius-*`, `--gray-*`) are
absent from all admin component styles. Verified by `pnpm --filter @clokr/web lint:tokens`.
