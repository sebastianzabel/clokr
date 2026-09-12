# Clokr Admin Area Regulatorium

> **Version:** v1.6.2 · **Status:** Binding
>
> This document is the **canonical, self-sufficient rulebook** for the Clokr admin area. Every executor working on Phases 51–57 (admin page migrations) MUST read this document and check their work against it before merging. Readers do not need to follow any external link to understand what to build or what to avoid — all required context is inlined here.
>
> **Canonical location:** `docs/ADMIN_STRUCTURE.md` (this file)
> **Summary pointer:** `.planning/UI_STYLE_GUIDE.md` contains a summary section and pointer back to this document.
> **Closes:** ADMIN-IA-01

---

## 1. Navigation Hierarchy

### 1.1 The 5 Groups

The admin sidebar is divided into **5 named groups**. Section labels are UPPERCASE, letter-spaced, and **visual-only** — they are never clickable. Each group contains 2–4 leaf entries.

```
PERSONAL
  Mitarbeitende
  Urlaubsverwaltung      (includes Sonderurlaubs-Typen as a tab)
  Betriebsurlaub

PLANUNG
  Schichtplan
  Verfügbarkeit

COMPLIANCE
  Monatsabschluss
  Audit & Log

DATEN
  CSV Import
  DATEV Export

SYSTEM
  Allgemein
  Branding & Themes
  Integrationen
  Phorest
```

These 5 groups and their exact entries are the authoritative target structure for Phase 51 (sidebar regrouping). No entries may be added, removed, or renamed without updating this Regulatorium first.

> **Note (v1.6.1 closing decision):** Sonderurlaubs-Typen consolidated into `/admin/vacation#sonderurlaub` (Phase 57). The standalone `/admin/special-leave` route is now a redirect-only stub kept for old deep links. The PERSONAL group went from 4 to 3 entries as a result.

> **Note (Phase 85.1-03):** Phorest configuration/test/staff-mapping/sync/observability UI was extracted out of `/admin/system` (D-10 — dedicated admin tab) into its own `/admin/phorest` route. The SYSTEM group went from 3 to 4 entries as a result.

### 1.2 Group → Pages Mapping

| Group      | Sidebar label     | Route               | Was (if renamed)                                                                        |
| ---------- | ----------------- | ------------------- | --------------------------------------------------------------------------------------- |
| PERSONAL   | Mitarbeitende     | /admin/employees    | —                                                                                       |
| PERSONAL   | Urlaubsverwaltung | /admin/vacation     | — (global view + Sonderurlaubs-Typen tab; per-MA editor moved to /admin/employees/[id]) |
| PERSONAL   | Betriebsurlaub    | /admin/shutdowns    | —                                                                                       |
| PLANUNG    | Schichtplan       | /admin/shifts       | —                                                                                       |
| PLANUNG    | Verfügbarkeit     | /admin/availability | —                                                                                       |
| COMPLIANCE | Monatsabschluss   | /admin/month-close  | —                                                                                       |
| COMPLIANCE | Audit & Log       | /admin/audit        | —                                                                                       |
| DATEN      | CSV Import        | /admin/import       | —                                                                                       |
| DATEN      | DATEV Export      | /admin/export       | —                                                                                       |
| SYSTEM     | Allgemein         | /admin/system       | — (feature flags + defaults; theme picker moved to Branding)                            |
| SYSTEM     | Branding & Themes | /admin/themes       | —                                                                                       |
| SYSTEM     | Integrationen     | /admin/integrations | /admin/wifi-presence (renamed in Phase 52; 301 redirect — see §8)                       |
| SYSTEM     | Phorest           | /admin/phorest      | — (extracted out of /admin/system in Phase 85.1-03; D-10)                               |

### 1.3 Section Label Rules

- Section group labels are rendered in **UPPERCASE** with `letter-spacing: 0.08em` (or `text-transform: uppercase; letter-spacing: 0.08em`).
- Section labels are **never clickable** — they are decorative grouping headers only. Do not wrap them in `<a>` or `<button>`.
- Each group contains a **maximum of 5 entries**. If a new feature would push a group past 5 entries, either create a new group or consolidate existing entries.
- Section labels live in the sidebar (Phase 51 responsibility). They do NOT appear as page headings.

### 1.4 Nav Label ↔ Page H1 Matching Rule

> **Binding rule:** The sidebar leaf label MUST match the `<PageHead title>` prop value exactly, case-for-case, character-for-character.

Examples of valid matches:

| Sidebar label     | `<PageHead title>` value |
| ----------------- | ------------------------ |
| Mitarbeitende     | Mitarbeitende            |
| Urlaubsverwaltung | Urlaubsverwaltung        |
| Branding & Themes | Branding & Themes        |
| Audit & Log       | Audit & Log              |

Any mismatch between sidebar label and PageHead title is a **Regulatorium violation**. The planned `lint:admin-layout` script (ADMIN-LINT-01, v2 backlog) will automatically detect this; until that script ships, Regulatorium compliance is self-enforced by phase executors.

---

## 2. Page Templates

Only **three page templates** are sanctioned for admin pages. Every admin `+page.svelte` MUST use exactly one of these. Mixing templates on a single page, or using a bespoke layout not based on one of these three, is a Regulatorium violation.

### 2.1 Template A — Section-Stack

**When to use (all of the following must apply):**

- The page is a **configuration or settings** page (not a list of entities)
- There is **no list/detail relationship** — no table of items with per-item detail
- The page has **multiple themed concerns** (e.g. company settings, feature flags, branding options) that belong in separate titled cards
- The page does **not** require a step indicator or sequential workflow

**Implemented by:** `apps/web/src/lib/components/admin/SectionStack.svelte`

**ASCII diagram:**

```
+------------------------------------------+
| eyebrow (e.g. "Administration")          |
| <PageHead title="Allgemein" />           |
| optional sub paragraph                   |
+------------------------------------------+
| Section card 1 (title="UNTERNEHMEN & REGION")  |
|   description (sub)                      |
|   form fields / content                  |
|   ─────────────────────────────────────  |
|   footer: [Speichern] [✓ Gespeichert]   |
+------------------------------------------+
| Section card 2 (title="FEATURES")       |
|   toggle rows / content                  |
|   ─────────────────────────────────────  |
|   footer: [Speichern]                   |
+------------------------------------------+
| Danger Zone (red-tinted, always last)   |
|   description                           |
|   [Destructive action button]           |
+------------------------------------------+
```

**Pages using Template A:** Allgemein, Branding & Themes, Integrationen, Schichtplan, Urlaubsverwaltung (see Appendix A for full table).

**Full reference implementation (Template A):**

```svelte
<!-- apps/web/src/routes/(app)/admin/system/+page.svelte -->
<script lang="ts">
  import SectionStack from "$components/admin/SectionStack.svelte";
  import Section from "$components/admin/Section.svelte";
  import DangerZone from "$components/admin/DangerZone.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  let companySaving = $state(false);
  let companySaved = $state(false);
  let companySaveError = $state("");

  let featuresSaving = $state(false);
  let featuresSaved = $state(false);

  async function saveCompany() {
    companySaving = true;
    companySaveError = "";
    try {
      // await api.put("/config/company", { name, federalState, timezone });
      companySaved = true;
      setTimeout(() => (companySaved = false), 1500);
    } catch (e) {
      companySaveError = e instanceof Error ? e.message : "Unbekannter Fehler";
    } finally {
      companySaving = false;
    }
  }

  async function saveFeatures() {
    featuresSaving = true;
    try {
      // await api.put("/config/features", { ... });
      featuresSaved = true;
      setTimeout(() => (featuresSaved = false), 1500);
    } finally {
      featuresSaving = false;
    }
  }
</script>

<SectionStack
  eyebrow="Administration"
  title="Allgemein"
  sub="Unternehmensweite Einstellungen und Feature-Toggles."
>
  <Section title="UNTERNEHMEN & REGION" sub="Firmenname, Bundesland & Zeitzone">
    <!-- form fields go here -->
    <div class="field-row">
      <label for="company-name">Unternehmensname</label>
      <input id="company-name" type="text" class="input" placeholder="Mein Unternehmen" />
    </div>

    {#snippet footer()}
      <button class="btn btn-primary btn-sm" onclick={saveCompany} disabled={companySaving}>
        {#if companySaving}<Spinner />{/if}
        {companySaved ? "✓ Gespeichert" : "Speichern"}
      </button>
      {#if companySaveError}
        <div class="alert alert-error" role="alert">
          <span>⚠</span><span>{companySaveError}</span>
        </div>
      {/if}
    {/snippet}
  </Section>

  <Section title="FEATURES" sub="Tenant-weite Feature-Toggles">
    <!-- toggle rows go here -->
    <div class="toggle-row">
      <span>Überstundenwarnung aktivieren</span>
      <input type="checkbox" />
    </div>

    {#snippet footer()}
      <button class="btn btn-primary btn-sm" onclick={saveFeatures} disabled={featuresSaving}>
        {#if featuresSaving}<Spinner />{/if}
        {featuresSaved ? "✓ Gespeichert" : "Speichern"}
      </button>
    {/snippet}
  </Section>

  <DangerZone description="Irreversible Aktionen für diesen Mandanten.">
    {#snippet actions()}
      <button class="btn btn-danger">Daten zurücksetzen</button>
    {/snippet}
  </DangerZone>
</SectionStack>
```

**Key rules for Template A implementations:**

- `SectionStack` owns the `<div class="page">` wrapper — do NOT add a second `<div class="page">` in the page file.
- Each `<Section>` saves independently via its own `footer` snippet — there is NO global save bar at the top of the page.
- `DangerZone` MUST be the last child of `SectionStack`, placed after all regular `<Section>` cards.
- Do NOT pass banned tokens (`--color-*`, `--glass-*`, `--radius-*`, `--gray-*`) in any style override.

### 2.2 Template B — List + Detail

**When to use (at least one of the following must apply):**

- The page shows a **list of entities** (employees, special-leave types, shutdowns) where each entity has a dedicated detail view
- The detail view requires **multiple form sections** grouped into a tab strip
- The entity's route is bookmarkable/deep-linkable (e.g. `/admin/employees/123`)

**Implemented by:** `apps/web/src/lib/components/admin/ListDetail.svelte`

**ASCII diagram — list mode:**

```
+------------------------------------------+
| eyebrow (e.g. "Personal")               |
| <PageHead title="Mitarbeitende">        |
|                         [+ Einladen]    |
+------------------------------------------+
| Filter row: [Search input] [Role filter] |
+------------------------------------------+
| Table header                             |
| ─────────────────────────────────────── |
| Row 1: Anna Bauer         → /employees/1 |
| Row 2: Max Mustermann     → /employees/2 |
| Row 3: …                               |
+------------------------------------------+
| Pagination: [< Prev] [1] [2] [Next >]   |
+------------------------------------------+
```

**ASCII diagram — detail mode:**

```
+------------------------------------------+
| Personal / Mitarbeitende / Max Mustermann|  ← breadcrumb
| <PageHead title="Max Mustermann">        |
+------------------------------------------+
| Stammdaten | Arbeitszeit | Urlaub | Berechtigungen | Danger Zone |  ← tab strip
+------------------------------------------+
| Active tab content (Section-Stack style) |
|   <Section title="STAMMDATEN"> … </Section> |
+------------------------------------------+
```

**Pages using Template B:** Mitarbeitende, Sonderurlaubs-Typen, Betriebsurlaub, Audit & Log, Verfügbarkeit (see Appendix A).

**Full reference implementation — list mode:**

```svelte
<!-- apps/web/src/routes/(app)/admin/employees/+page.svelte -->
<script lang="ts">
  import ListDetail from "$components/admin/ListDetail.svelte";

  let search = $state("");
  let page = $state(1);
  // let employees: Employee[] = $state([]);
  // Load employees in onMount via api.get(...)
</script>

<ListDetail
  view="list"
  eyebrow="Personal"
  title="Mitarbeitende"
  sub="Alle Mitarbeiter dieses Mandanten."
>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm">+ Einladen</button>
  {/snippet}

  {#snippet list()}
    <div class="filter-row">
      <input
        class="input"
        type="search"
        placeholder="Name oder E-Mail suchen…"
        bind:value={search}
      />
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Rolle</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <!-- {#each employees as emp} -->
        <tr>
          <td><a href="/admin/employees/1">Max Mustermann</a></td>
          <td>Mitarbeiter</td>
          <td>Aktiv</td>
        </tr>
        <!-- {/each} -->
      </tbody>
    </table>

    <!-- <Pagination bind:page totalPages={totalPages} /> -->
  {/snippet}
</ListDetail>
```

**Full reference implementation — detail mode with tabs:**

```svelte
<!-- apps/web/src/routes/(app)/admin/employees/[id]/+page.svelte -->
<script lang="ts">
  import ListDetail from "$components/admin/ListDetail.svelte";
  import Section from "$components/admin/Section.svelte";
  import DangerZone from "$components/admin/DangerZone.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  let activeTab = $state("stammdaten");

  // const { data } = $props(); // employee loaded from +page.server.ts or onMount
</script>

<ListDetail
  view="detail"
  eyebrow="Personal"
  title="Max Mustermann"
  crumbs={[
    { label: "Personal" },
    { label: "Mitarbeitende", href: "/admin/employees" },
    { label: "Max Mustermann" },
  ]}
  tabs={[
    { id: "stammdaten", label: "Stammdaten" },
    { id: "arbeitszeit", label: "Arbeitszeit" },
    { id: "urlaub", label: "Urlaub" },
    { id: "berechtigungen", label: "Berechtigungen" },
    { id: "danger", label: "Danger Zone" },
  ]}
  {activeTab}
  onTabChange={(id) => (activeTab = id)}
>
  {#snippet tabContent(tab)}
    {#if tab === "stammdaten"}
      <Section title="STAMMDATEN" sub="Persönliche Daten und Kontaktinformationen">
        <!-- form fields -->
        <div class="field-row">
          <label for="first-name">Vorname</label>
          <input id="first-name" class="input" type="text" value="Max" />
        </div>

        {#snippet footer()}
          <button class="btn btn-primary btn-sm">Speichern</button>
        {/snippet}
      </Section>
    {:else if tab === "arbeitszeit"}
      <Section title="ARBEITSZEITMODELL" sub="Wochenstunden und Schichtmodell">
        <!-- schedule config -->
      </Section>
    {:else if tab === "urlaub"}
      <Section title="URLAUBSANSPRUCH" sub="Jahresanspruch und Übertrag">
        <!-- vacation config -->
      </Section>
    {:else if tab === "berechtigungen"}
      <Section title="ROLLEN & RECHTE" sub="Zugriffssteuerung für diesen Mitarbeiter">
        <!-- role assignment -->
      </Section>
    {:else if tab === "danger"}
      <DangerZone
        description="Diesen Mitarbeiter anonymisieren (DSGVO Art. 17). Diese Aktion ist nicht rückgängig zu machen."
      >
        {#snippet actions()}
          <button class="btn btn-danger">Anonymisieren</button>
        {/snippet}
      </DangerZone>
    {/if}
  {/snippet}
</ListDetail>
```

**Key rules for Template B implementations:**

- `ListDetail` with `view="list"` renders the list content via the `list` snippet.
- `ListDetail` with `view="detail"` renders tab content via `tabContent(tab)` — the snippet receives the active tab ID as an argument.
- `crumbs` prop is required in detail mode. Format: `[{ label: "Group" }, { label: "Page", href: "/route" }, { label: "Detail name" }]`. (Composes the existing `ui/Breadcrumb.svelte` component, which uses the `crumbs` prop name.)
- `DangerZone` in detail mode MUST be placed as the last tab (e.g. `{ id: "danger", label: "Danger Zone" }`), not as an additional sibling outside the tab strip.
- `activeTab` is `$bindable()` — use `bind:activeTab={selectedTab}` for two-way binding. The parent reactively reads the active tab without wiring an explicit callback.

### 2.3 Template C — Tool / Wizard

**When to use (at least one of the following must apply):**

- The page performs a **one-shot operation** (import, export, close month) with a clear start/result cycle
- The operation has **distinct sequential steps** (upload → preview → commit) that benefit from a step indicator
- The page shows a **history or result list** below the action form

**Implemented by:** `apps/web/src/lib/components/admin/ToolPage.svelte`

**ASCII diagram:**

```
+------------------------------------------+
| eyebrow (e.g. "Daten")                  |
| <PageHead title="CSV Import">           |
| optional sub paragraph                   |
+------------------------------------------+
| Step indicator (if multi-step):          |
|  [1. Datei] ──── [2. Vorschau] ──── [3. Importieren] |
+------------------------------------------+
| Form / file picker / config area         |
|   (content changes per step)             |
+------------------------------------------+
| Primary action button                    |
+------------------------------------------+
| Result / import history list             |
+------------------------------------------+
```

**Pages using Template C:** Monatsabschluss, CSV Import, DATEV Export (see Appendix A).

**Full reference implementation — without steps (Monatsabschluss):**

```svelte
<!-- apps/web/src/routes/(app)/admin/month-close/+page.svelte -->
<script lang="ts">
  import ToolPage from "$components/admin/ToolPage.svelte";
  import Section from "$components/admin/Section.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  let selectedMonth = $state("");
  let closing = $state(false);
  let closeResult = $state<{ success: boolean; message: string } | null>(null);

  async function closeMonth() {
    if (!selectedMonth) return;
    closing = true;
    closeResult = null;
    try {
      // await api.post("/month-close", { month: selectedMonth });
      closeResult = { success: true, message: `Monat ${selectedMonth} erfolgreich abgeschlossen.` };
    } catch (e) {
      closeResult = {
        success: false,
        message: e instanceof Error ? e.message : "Fehler beim Abschließen",
      };
    } finally {
      closing = false;
    }
  }
</script>

<ToolPage
  eyebrow="Compliance"
  title="Monatsabschluss"
  sub="Abgeschlossene Monate können nicht mehr bearbeitet werden."
>
  {#snippet form()}
    <Section title="MONAT AUSWÄHLEN" sub="Wähle den abzuschließenden Monat">
      <div class="field-row">
        <label for="close-month">Monat</label>
        <input id="close-month" type="month" class="input" bind:value={selectedMonth} />
      </div>

      {#snippet footer()}
        <button
          class="btn btn-primary btn-sm"
          onclick={closeMonth}
          disabled={closing || !selectedMonth}
        >
          {#if closing}<Spinner />{/if}
          Monat abschließen
        </button>
      {/snippet}
    </Section>

    {#if closeResult}
      <div class="alert {closeResult.success ? 'alert-success' : 'alert-error'}" role="alert">
        {closeResult.message}
      </div>
    {/if}
  {/snippet}

  {#snippet result()}
    <Section title="ABSCHLUSS-HISTORIE" sub="Bisher abgeschlossene Monate">
      <!-- history table / list -->
      <table class="data-table">
        <thead>
          <tr><th>Monat</th><th>Abgeschlossen am</th><th>Von</th></tr>
        </thead>
        <tbody>
          <!-- {#each closedMonths as entry} -->
          <tr>
            <td>2025-12</td>
            <td>01.01.2026 09:00</td>
            <td>Admin</td>
          </tr>
          <!-- {/each} -->
        </tbody>
      </table>
    </Section>
  {/snippet}
</ToolPage>
```

**Full reference implementation — with steps (CSV Import):**

```svelte
<!-- apps/web/src/routes/(app)/admin/import/+page.svelte -->
<script lang="ts">
  import ToolPage from "$components/admin/ToolPage.svelte";
  import Section from "$components/admin/Section.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  const steps = [
    { id: "upload", label: "Datei hochladen" },
    { id: "preview", label: "Vorschau" },
    { id: "commit", label: "Importieren" },
  ];

  let currentStep = $state("upload");
  let selectedFile = $state<File | null>(null);
  let importing = $state(false);

  function nextStep() {
    const idx = steps.findIndex((s) => s.id === currentStep);
    if (idx < steps.length - 1) currentStep = steps[idx + 1].id;
  }

  async function runImport() {
    importing = true;
    try {
      // await api.post("/import/csv", formData);
      currentStep = "commit";
    } finally {
      importing = false;
    }
  }
</script>

<ToolPage
  eyebrow="Daten"
  title="CSV Import"
  sub="Mitarbeiterdaten aus einer CSV-Datei importieren."
  {steps}
  {currentStep}
>
  {#snippet form()}
    {#if currentStep === "upload"}
      <Section title="DATEI AUSWÄHLEN" sub="CSV-Datei im vorgegebenen Format hochladen">
        <div class="field-row">
          <label for="csv-file">CSV-Datei</label>
          <input
            id="csv-file"
            type="file"
            accept=".csv"
            onchange={(e) => (selectedFile = (e.target as HTMLInputElement).files?.[0] ?? null)}
          />
        </div>

        {#snippet footer()}
          <button class="btn btn-primary btn-sm" onclick={nextStep} disabled={!selectedFile}>
            Weiter zur Vorschau
          </button>
        {/snippet}
      </Section>
    {:else if currentStep === "preview"}
      <Section title="DATENVORSCHAU" sub="Überprüfe die zu importierenden Daten">
        <!-- preview table generated from parsed CSV -->
        {#snippet footer()}
          <button class="btn btn-primary btn-sm" onclick={runImport} disabled={importing}>
            {#if importing}<Spinner />{/if}
            Import starten
          </button>
        {/snippet}
      </Section>
    {:else if currentStep === "commit"}
      <div class="alert alert-success" role="alert">Import erfolgreich abgeschlossen.</div>
    {/if}
  {/snippet}

  {#snippet result()}
    <Section title="IMPORT-HISTORIE" sub="Frühere Importe">
      <table class="data-table">
        <thead>
          <tr><th>Datei</th><th>Importiert am</th><th>Datensätze</th><th>Status</th></tr>
        </thead>
        <tbody>
          <!-- {#each importHistory as entry} -->
          <tr>
            <td>mitarbeiter-2026.csv</td>
            <td>01.01.2026 10:00</td>
            <td>42</td>
            <td>Erfolgreich</td>
          </tr>
          <!-- {/each} -->
        </tbody>
      </table>
    </Section>
  {/snippet}
</ToolPage>
```

**Key rules for Template C implementations:**

- `steps` prop is optional. When omitted, `ToolPage` renders no step indicator.
- `form` snippet is required — it contains the primary action area.
- `result` snippet is optional — when provided, it renders below the form (history list, result summary).
- Do NOT add a global submit button at the page level — each step's submit logic is inside the `form` snippet.
- `currentStep` MUST be managed by the caller (local `$state`). `ToolPage` does not manage step state internally.

---

## 3. Sub-Patterns

### 3.1 Danger Zone

The **Danger Zone** is a distinct card section for irreversible or high-impact destructive actions (DSGVO anonymization, data resets, deletion). It follows the pattern popularized by GitHub's repository settings page.

**Placement rules:**

- In a `SectionStack`: `<DangerZone>` MUST be the **last child**, placed after all regular `<Section>` cards.
- In a `ListDetail` detail view: `<DangerZone>` MUST be inside the **last tab panel** (typically a tab labeled "Danger Zone").
- `DangerZone` MUST NOT appear in the middle of a section stack, inside a regular `<Section>`, or in list mode.

**Visual contract:**

- Background: `var(--bad-soft)` (red-tinted surface)
- Border: `1px solid var(--bad)` (red border)
- No `box-shadow` (flat, to emphasize the warning)
- Title default: **"Danger Zone"** (English — recognized industry term; not translated to German)

**Confirmation mechanisms:**

- **Quick destructive actions** (e.g. delete a single special-leave type): use `ui/ConfirmDialog.svelte`. The `<DangerZone>` renders the trigger button; the caller wires up `<ConfirmDialog>` outside the DangerZone.
- **Catastrophic actions** (e.g. DSGVO anonymization, data reset): use a type-to-confirm input — user must type a specific phrase (e.g. the employee's name or "ANONYMISIEREN") before the button becomes active.

**Usage:**

```svelte
<DangerZone description="Diesen Mitarbeiter unwiderruflich anonymisieren (DSGVO Art. 17).">
  {#snippet actions()}
    <button class="btn btn-danger" onclick={() => (confirmOpen = true)}>
      Mitarbeiter anonymisieren
    </button>
  {/snippet}
</DangerZone>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Mitarbeiter anonymisieren?"
  message="Diese Aktion ist nicht rückgängig zu machen."
  confirmLabel="Anonymisieren"
  onConfirm={anonymizeEmployee}
/>
```

### 3.2 Per-Card Save (No Global Save Bar)

Admin settings pages use a **per-card save pattern** — each `<Section>` has its own save button in the `footer` snippet. There is NO global save bar at the top or bottom of the page.

This follows the Linear and GitHub patterns: save actions are scoped to their card, so saving "Company Settings" does not affect "Feature Toggles".

**Save button state machine (per section):**

```
idle → [user edits field] → dirty (Section renders "Nicht gespeichert") → [click Speichern] → saving …
     → success ("✓ Gespeichert" for 1500ms) → idle
     → error (<div class="alert alert-error">) → idle (user fixes and retries)
```

**Implementation pattern (for each Section footer):**

```svelte
<script lang="ts">
  let saving = $state(false);
  let saved = $state(false);
  let saveError = $state("");

  async function save() {
    saving = true;
    saveError = "";
    try {
      // await api.put("/config/...", { ... });
      saved = true;
      setTimeout(() => {
        saved = false;
      }, 1500);
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Unbekannter Fehler";
    } finally {
      saving = false;
    }
  }
</script>

<!-- Inside the Section's footer snippet: -->
{#snippet footer()}
  <button class="btn btn-primary btn-sm" onclick={save} disabled={saving}>
    {#if saving}<Spinner />{/if}
    {saved ? "✓ Gespeichert" : "Speichern"}
  </button>
  {#if saveError}
    <div class="alert alert-error" role="alert">
      <span>⚠</span><span>{saveError}</span>
    </div>
  {/if}
{/snippet}
```

**Anti-pattern reference:** A global sticky save bar at the top of the page violates §4.E (Hidden Destructive Actions) and the general per-card save principle. Any admin page with a global save bar is a Regulatorium violation.

### 3.2.1 Instant save vs. section button — how to classify a control

Phase 109 (Issue #35) found the same page carrying both patterns in visually identical toggle
rows, with no written rule to tell them apart. This section is that rule.

**The rule reads at the control, not at the page (D-01).** Two classes, no third:

- **Atomic single value** — a checkbox or a select that stands on its own — saves on
  interaction, with a success toast and an optimistic rollback on failure.
- **Form group** — several fields that only mean something together — saves via one
  Speichern button in the `Section` `footer` snippet (§3.2 above).

**Text and number fields are always a form group (D-02).** No debounced autosave, no
save-on-blur, regardless of whether the field has siblings. A lone number input with its own
button is correct and must not be "fixed" into an instant save. This is the type-based
override that wins over the atomic-value test above — it is the operative form of the audit
requirement below, and it is enforced mechanically by `pnpm --filter @clokr/web
lint:save-pattern` (see "Enforcement" below).

**Why this is the audit rule, not "audit ⇒ button" (D-06):** `apps/api/src/routes/settings.ts:677`
writes one unconditional audit row per `PUT /settings/work`, and that is exactly the endpoint
every instant-save toggle on `admin/system` writes through. One operator action producing one
audit row is a correct record; what would be wrong is a _chain_ of rows from a single change —
and that is exactly what the text/number carve-out above prevents. Reading D-06 as "anything
audited must be a button" would have made the rule "everywhere in admin is a button", which was
considered and rejected.

**Always a button, whatever the control looks like:**

- Security configuration — password policy, session config / "Angemeldet bleiben", SMTP
  credentials, Phorest credentials (D-07).
- Anything carrying an effective date: _value and effective date are one decision and can only
  be correct together_ (N-04, D-08) — e.g. the `WorkSchedule` on `admin/employees/[id]`, which
  is additionally only legal on the 1st of a month (`MONTH_FIRST_ERROR`,
  `apps/api/src/utils/month-first-date.ts`).

**Instant-save handler shape.** `toggleWifi()`
(`apps/web/src/routes/(app)/settings/+page.svelte:113-125`) is the reference: `await` the
request, write back the _server's_ value, then `toasts.success(...)`; in `catch`, revert the
optimistic value FIRST, then `toasts.error(...)` — never the other order, or the switch briefly
shows a state the server never accepted. The in-admin example that shipped in Phase 109 (plan
109-04) follows the same shape, keyed over a registry instead of a single variable:

```ts
async function toggleEmailFlag(flag: EmailFlag, next: boolean) {
  const previous = emailFlags[flag];
  emailFlags[flag] = next; // optimistic — mirrors the checkbox the browser already flipped
  emailFlagSaving = flag;
  try {
    const res = await api.put<SecurityConfig>("/settings/security", { [flag]: next });
    const serverValue = res?.[flag];
    emailFlags[flag] = typeof serverValue === "boolean" ? serverValue : next;
    toasts.success(`${EMAIL_FLAG_LABELS[flag]} ${emailFlags[flag] ? "aktiviert" : "deaktiviert"}.`);
  } catch (e: unknown) {
    emailFlags[flag] = previous; // revert BEFORE the toast (D-04)
    toasts.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen.");
  } finally {
    emailFlagSaving = null;
  }
}
```

**Payloads are minimal.** A newly converted instant handler sends only the field it changed —
`toggleEmailFlag` above sends `{ [flag]: next }`, a single key, never a full-config spread. The
`_gOtherFields` full-config spread that older handlers in `admin/system` use caches a snapshot
taken once at page load and never refreshed; copying that pattern into a new handler widens a
known lost-update race (N-09) instead of merely inheriting it. Both `/settings/work` and
`/settings/security` accept true partial payloads — there is no technical reason to spread more
than the changed field.

**Unsaved state is visible (D-11).** Pass `dirty` to `Section`; it renders the "Nicht
gespeichert" hint (`role="status"`, class `unsaved-hint`) in the footer next to the Speichern
button. Derive `dirty` by snapshot comparison — take one string snapshot (e.g. via
`JSON.stringify` of exactly the fields the save handler submits) once at load, and re-take it
inside the handler's `try` block **only on the success path**, immediately after marking the
save as done. Re-taking it in `finally` would clear the marker after a FAILED save too, which is
the exact confusion this rule exists to remove — a save that did not happen must keep showing
"Nicht gespeichert".

**Leaving with unsaved changes prompts (D-12).** Each page registers an aggregate dirty flag
with `markUnsaved(<page id>, dirty)` from `$stores/unsaved`, cleared again by the same call (or
its own `$effect` cleanup) when the page unmounts or the section becomes clean.

The registration is gated on a `snapshotsReady` flag that becomes `true` only once the page's
baseline snapshot has actually been taken — set it as the last statement inside the load's `try`
(or, where the load has several exits, directly at the single site that assigns the baseline),
never in `finally`. Without the gate every snapshot is still `""` while the page loads, so every
dirty flag reads `true`, and a load that throws makes that permanent: the guard is armed on a
page showing nothing but an error banner, with no marker to explain the dialog. This was a live
defect found in code review (WR-01) on the first two pages that shipped, and it exists in the
wild on any page that derives `dirty` from an unset baseline.

The `(app)/+layout.svelte` layout runs a single `beforeNavigate` guard that checks `hasUnsaved()`
and opens the shared `ConfirmDialog` primitive before letting a dirty navigation through. Every
logout path (there are four: Topbar, Sidebar, the inactivity timer, and the 401 handler in
`client.ts`) clears the registry via `clearUnsaved()` _before_ it navigates — the guard has no
way to tell a forced logout from any other navigation, so the logout paths themselves carry that
responsibility (N-08).

**Where the marker renders.** `Section` renders the `dirty` hint inside its `footer` snippet
only. A page whose save button does not live in a `Section` footer — a sticky save bar
(`admin/vacation`), a `ListDetail` `actions` snippet (`admin/availability/[employeeId]`), a
Section that only has an `actions` snippet (`admin/phorest`'s mapping table) — renders the same
global `.unsaved-hint` recipe directly, next to the button it refers to. Do not add a `dirty`
prop to a footerless Section: it renders nothing and reads as done work.

**Which admin pages carry the marker and the guard.** Nine pages register; eleven are
deliberately excluded, each with a reason:

| Page                              | Registry id                 | Marker location                                                                          |
| --------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `admin/system`                    | `admin-system`              | `Section.dirty` (multiple footers)                                                       |
| `admin/employees/[id]`            | `admin-employee-detail`     | `Section.dirty` (multiple footers)                                                       |
| `admin/vacation`                  | `admin-vacation`            | inline `.unsaved-hint` in the sticky save bar                                            |
| `admin/phorest`                   | `admin-phorest`             | `Section.dirty` (Verbindung, Import) + inline `.unsaved-hint` (Mitarbeiter-Zuordnung)    |
| `admin/shifts`                    | `admin-shifts`              | `Section.dirty` (Schicht-Muster)                                                         |
| `admin/shutdowns/[id]`            | `admin-shutdown-detail`     | `Section.dirty` (Betriebsurlaub)                                                         |
| `admin/export`                    | `admin-export`              | `Section.dirty` (Lohnartennummern only — Export konfigurieren is never dirty, see below) |
| `admin/audit`                     | `admin-audit`               | `Section.dirty` (Aufbewahrung only — log filters are never dirty, see below)             |
| `admin/availability/[employeeId]` | `admin-availability-detail` | inline `.unsaved-hint` in the `ListDetail` actions snippet                               |

| Page                                                                    | Excluded because                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/employees` (list)                                                | the only editable form is the invite `<Modal>` with its own Abbrechen; a modal draft is a modal-dismissal concern that `beforeNavigate` never sees, and `Section.dirty` cannot render inside a modal footer |
| `admin/shutdowns` (list)                                                | same — the only form is the create `<Modal>`                                                                                                                                                                |
| `admin/month-close`                                                     | `selectedYear`/`statusFilter` are filters; `unlockReason`/`gapAcknowledged` are one-shot confirmations inside modals; the writes (`close-month`, `unlock-month`) are operations, not form state             |
| `admin/import`                                                          | an operation (paste CSV → `POST /imports/:mode`), nothing is held as a setting                                                                                                                              |
| `admin/integrations`                                                    | no update endpoint exists; the single write creates a NEW API key and the two inputs clear afterwards                                                                                                       |
| `admin/themes`                                                          | no write path and no bound form state                                                                                                                                                                       |
| `admin/availability` (list)                                             | list view — no write path                                                                                                                                                                                   |
| `admin/audit/[id]`                                                      | detail view — no write path                                                                                                                                                                                 |
| `admin/special-leave`, `admin/special-leave/[id]`, `admin/+page.svelte` | redirect stubs — no UI, no form state                                                                                                                                                                       |

Two exceptions within otherwise-registered pages get the same "no marker" treatment: `admin/export`'s
"Export konfigurieren" fields are parameters of a single download, never persisted, and
`admin/audit`'s `filterAction`/`filterEntity` parameterise a read (`applyFilter` → `loadLogs`),
not an edit — both are excluded from their page's snapshot and are pinned as such in each page's
own `*-save-wiring.test.ts`.

This table is not maintained by hand:
`apps/web/src/__tests__/admin-unsaved-registry.test.ts` walks the admin route directory and fails
if a `+page.svelte` appears in neither list, if two pages register the same id, or if a
registration is not gated on a readiness flag. A new admin page therefore cannot ship without
someone deciding which side of this table it belongs on. Employee-facing pages are deliberately
out of scope (D-13/D-14) and are their own follow-up phase; `inbox` uses the same `Section`
primitive but is not under `admin/`.

**Enforcement:** `pnpm --filter @clokr/web lint:save-pattern` (wired into CI) mechanically
enforces the text/number half of this rule (D-02) across the whole `admin/**` scope, including
pages that do not exist yet — it does not, and cannot, judge the atomic-value-vs-form-group
question above, which is why this section exists as prose rather than only as a lint rule. The
vitest pins in `apps/web/src/__tests__/admin-system-save-wiring.test.ts` and
`admin-employee-save-wiring.test.ts` additionally pin the specific classification decisions named
above (which controls are instant, which are button-gated) for the two admin pages that exist
today. `apps/web/src/__tests__/admin-unsaved-registry.test.ts` is the equivalent mechanical gate
for D-11/D-12's page coverage, described above.

### 3.3 Breadcrumbs on Detail Pages

Detail pages (Template B, `view="detail"`) MUST display a breadcrumb trail above the page title.

**Format:** `Group / Page / Detail name`

**Examples:**

| Detail page            | Breadcrumb                                        |
| ---------------------- | ------------------------------------------------- |
| /admin/employees/123   | Personal / Mitarbeitende / Max Mustermann         |
| /admin/special-leave/5 | Personal / Sonderurlaubs-Typen / Bildungsurlaub   |
| /admin/shutdowns/2     | Personal / Betriebsurlaub / Weihnachtsurlaub 2026 |

**Implementation:** Pass the `crumbs` prop to `ListDetail`:

```svelte
<ListDetail
  view="detail"
  crumbs={[
    { label: "Personal" },
    { label: "Mitarbeitende", href: "/admin/employees" },
    { label: "Max Mustermann" }
  ]}
  ...
>
```

**Rules:**

- The group label (first crumb) is text-only — no `href`.
- The page label (second crumb) links back to the list view.
- The detail name (last crumb) is the current page — text-only, no `href`.
- Top-level admin pages using `SectionStack` (Template A) do **NOT** show breadcrumbs.

---

## 4. Anti-Patterns

All 7 anti-patterns below are inlined verbatim from `.planning/research/v1.6.1-ADMIN-IA-RESEARCH.md` §4. Do not paraphrase. These are the exact symptoms, diagnoses, and fixes that Phase 51–57 executors MUST check against.

### 4.A Flat Sidebar With Too Many Entries

**Symptom:** Sidebar reads as a list of disconnected features rather than a structured admin.

**Why bad:** Scanning + grouping happens in user's head, not the UI. Cognitive load grows linearly with each new feature.

**Fix:** Group into 3-5 top-level sections (e.g. People, Planning, Compliance, Data, System).

### 4.B Modal as Primary Interaction for Complex Configuration

**Symptom:** Click "Edit employee" → modal pops with 8 form sections, including AZ-Modell radio cluster, vacation field, schedule modal-within-modal.

**Why bad:** Modals are for short tasks. Complex multi-section config in a modal becomes scroll-trapped and loses URL state.

**Fix:** Detail pages with `?employee=X` query param + tab strip inside. Modal only for short tasks (delete confirm, invite, single-field rename).

### 4.C "System" as a Junk Drawer

**Symptom:** `/admin/system` contains feature toggles, default values, integration credentials, and theme settings.

**Why bad:** "System" becomes the page where nobody knows what to expect.

**Fix:** Split into typed sections: Feature flags, Defaults, Integrations, Branding. Or move single concerns into the relevant domain (e.g. theme→Personalization).

### 4.D Inconsistent Page-Level Layouts

**Symptom:** `/admin/vacation` uses modal-heavy editing, `/admin/system` uses Features-Card stack, `/admin/employees` uses table+modal, `/admin/shifts` uses Pattern-Editor table.

**Why bad:** No predictability. Every page needs to be re-learned.

**Fix:** Three sanctioned page templates (see §2) and a lint rule that enforces them.

### 4.E Hidden Destructive Actions

**Symptom:** "Anonymisieren" (DSGVO delete) and "Endgültig löschen" buried inside a modal sub-tab.

**Why bad:** Either too easy to trigger by accident or too hard to find when needed.

**Fix:** Danger Zone pattern at bottom of detail pages with red-tinted card + extra confirmation step.

### 4.F Section Labels That Don't Match Nav Labels

**Symptom:** Sidebar says "Urlaub & Zeiten" → page header says "Mitarbeiter-Konfiguration".

**Why bad:** Disorients the user; they don't know they're on the right page.

**Fix:** Page header EXACTLY mirrors sidebar label (case + wording).

### 4.G Mixing Tenant-Scoped and Global-Scoped Settings

**Symptom:** TenantConfig defaults sitting next to feature flags that affect only the current admin's view.

**Why bad:** Admin doesn't know whether a toggle changes the whole company or just their session.

**Fix:** Visual separator + section label like "Standardwerte für das gesamte Unternehmen" vs "Persönliche Anzeigeeinstellungen".

---

## 5. Modal Use Criteria

Use **modals** (`ui/Modal.svelte`) sparingly in the admin area. The default preference is always a detail page.

### When to use a modal

All three of the following MUST be true:

1. The task completes in **< 30 seconds** (e.g. confirm delete, invite user, rename a type)
2. The task is a **single discrete action** — no sequence of steps, no multi-tab nav needed
3. The task does **not require URL state** (no need to deep-link or reload with context preserved)

**Valid modal examples:** Delete confirmation, send invite email, rename a special-leave type, quick status toggle.

### When to use a detail page (not a modal)

Use a detail page when ANY of the following is true:

- The task has **4 or more form sections**
- The user needs a **bookmarkable URL** (employee detail, audit log entry)
- The task requires **scrolling beyond viewport height**
- The task takes **more than 1 minute** to complete
- The task requires **multi-tab navigation** within the action (e.g. Stammdaten + Arbeitszeit + Urlaub)

### Binding rule

> **Any admin modal with 4+ form sections is a Regulatorium violation.** Convert to a detail page using Template B (ListDetail).

The current `/admin/employees` modal-heavy edit flow (employee edit modal with 8 form sections) is a known violation that Phase 56 will resolve by migrating to the List + Detail template with tab strip.

---

## 6. Naming Rules

| Rule                   | Description                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nav label = Page H1    | The sidebar leaf label MUST match `<PageHead title>` exactly (case-sensitive, character-for-character). No paraphrasing, no abbreviation.              |
| Section labels         | Group labels in the sidebar nav are UPPERCASE + letter-spaced (`text-transform: uppercase; letter-spacing: 0.08em`). Never clickable, never linked.    |
| Page descriptions      | The `sub` prop on `<PageHead>` (or on the wrapper component) holds a brief German description of the page's purpose.                                   |
| Breadcrumb format      | Detail pages: `Group label / Page label / Entity name`. Group label has no href. Page label links to the list. Entity name has no href (current page). |
| Component import paths | Use the `$components` alias: `import SectionStack from "$components/admin/SectionStack.svelte"`                                                        |
| All 5 admin components | `SectionStack.svelte`, `ListDetail.svelte`, `ToolPage.svelte`, `Section.svelte`, `DangerZone.svelte` — all in `apps/web/src/lib/components/admin/`     |
| README location        | `apps/web/src/lib/components/admin/README.md` — prop API + usage examples for all 5 components                                                         |

---

## 7. Future Enforcement (lint:admin-layout)

**One gate has shipped since this section was written:** `pnpm --filter @clokr/web
lint:save-pattern` (Phase 109, `apps/web/scripts/lint-save-pattern.mjs`) is live in CI and
enforces the D-02 text/number half of §3.2.1 across the whole `admin/**` scope. It is narrower
than the `lint:admin-layout` sketch below — it does not check template imports, `PageHead`
matching, or `DangerZone` placement — so `lint:admin-layout` remains deferred for those checks.

The planned `lint:admin-layout` automation script is **deferred to v2 backlog**, tracked as **ADMIN-LINT-01** in REQUIREMENTS.md.

Until `lint:admin-layout` ships, this Regulatorium is the enforcement mechanism. Phases 51–57 are expected to self-check against it. Each phase executor MUST:

1. Verify that every migrated admin `+page.svelte` imports exactly one of `SectionStack`, `ListDetail`, or `ToolPage`.
2. Verify that the `<PageHead title>` prop value matches the Sidebar nav label exactly.
3. Verify that `DangerZone` (when used) is placed as the last child / last tab panel.
4. Confirm no banned legacy tokens (`--color-*`, `--glass-*`, `--radius-*`, `--gray-*`) appear in any scoped `<style>` block.

**Planned `lint:admin-layout` behavior (when it ships in v2):**

```bash
# For each apps/web/src/routes/(app)/admin/*/+page.svelte:
# 1. Verify exactly one of SectionStack|ListDetail|ToolPage is imported
# 2. Verify <PageHead title="..."> matches the Sidebar nav label
# 3. Exit non-zero if any violation found
```

The script will be a Node.js grep-based tool in `scripts/lint-admin-layout.js`. It is explicitly NOT shipped in Phase 50 due to time constraints and the risk of premature enforcement before all 13 pages are migrated.

---

## 8. 301 Redirect Pattern

When an admin route is renamed (e.g. `/admin/wifi-presence` → `/admin/integrations` in Phase 52), use a SvelteKit server-side redirect to preserve deep links and browser history.

**Implementation:** Create a `+page.server.ts` file in the OLD route directory:

```typescript
// apps/web/src/routes/(app)/admin/wifi-presence/+page.server.ts
import { redirect } from "@sveltejs/kit";

export function load() {
  redirect(301, "/admin/integrations");
}
```

**Rules:**

- Use HTTP **301** (Moved Permanently) — not 302 or 307. This tells browsers and crawlers the route has permanently moved.
- The redirect file lives in the **old** route directory (`wifi-presence/+page.server.ts`).
- The redirect function call must NOT be wrapped in a `throw` statement — SvelteKit v2 redirect() is called directly (without throw).
- The old route directory should contain ONLY the `+page.server.ts` redirect file after migration — no other page files.
- Document the redirect in the phase SUMMARY.md so the route mapping is traceable.

**Applies to Phase 52:** `/admin/wifi-presence` → `/admin/integrations`

---

## Appendix A: Page → Template Assignment

All 13 admin pages, their template assignment, migration phase, and requirement ID. (Sonderurlaubs-Typen consolidated into Urlaubsverwaltung — see §1.1 note. Phorest added Phase 85.1-03 — see §1.1 note.)

| Group      | Page              | Route               | Template                                                                         | Phase | Requirement                                          |
| ---------- | ----------------- | ------------------- | -------------------------------------------------------------------------------- | ----- | ---------------------------------------------------- |
| PERSONAL   | Mitarbeitende     | /admin/employees    | List + Detail                                                                    | 56    | ADMIN-MIG-10                                         |
| PERSONAL   | Urlaubsverwaltung | /admin/vacation     | Section-Stack                                                                    | 57    | ADMIN-MIG-11, ADMIN-MIG-12 (Sonderurlaubs-Typen tab) |
| PERSONAL   | Betriebsurlaub    | /admin/shutdowns    | List + Detail                                                                    | 57    | ADMIN-MIG-13                                         |
| PLANUNG    | Schichtplan       | /admin/shifts       | Section-Stack                                                                    | 55    | ADMIN-MIG-08                                         |
| PLANUNG    | Verfügbarkeit     | /admin/availability | List + Detail                                                                    | 55    | ADMIN-MIG-09                                         |
| COMPLIANCE | Monatsabschluss   | /admin/month-close  | Tool / Wizard                                                                    | 53    | ADMIN-MIG-04                                         |
| COMPLIANCE | Audit & Log       | /admin/audit        | Section-Stack (list with tabs) + List + Detail (per-entry via /admin/audit/[id]) | 53    | ADMIN-MIG-05                                         |
| DATEN      | CSV Import        | /admin/import       | Tool / Wizard                                                                    | 54    | ADMIN-MIG-06                                         |
| DATEN      | DATEV Export      | /admin/export       | Tool / Wizard                                                                    | 54    | ADMIN-MIG-07                                         |
| SYSTEM     | Allgemein         | /admin/system       | Section-Stack                                                                    | 52    | ADMIN-MIG-01                                         |
| SYSTEM     | Branding & Themes | /admin/themes       | Section-Stack                                                                    | 52    | ADMIN-MIG-02                                         |
| SYSTEM     | Integrationen     | /admin/integrations | Section-Stack                                                                    | 52    | ADMIN-MIG-03                                         |
| SYSTEM     | Phorest           | /admin/phorest      | Section-Stack                                                                    | 85.1  | D-10 (85.1-CONTEXT.md)                               |

**Reading this table:**

- **Template** — which of the 3 sanctioned templates this page uses (see §2 for full spec of each)
- **Phase** — the migration phase that converts this page to the template (Phase 50 is foundation-only; no page migrations happen in Phase 50)
- **Requirement** — the ADMIN-MIG-XX ID from REQUIREMENTS.md that tracks this migration

**Closing decisions (v1.6.1 audit, 2026-05-23):**

- **Audit & Log**: list page uses Section-Stack with tab-strip filter — Template B (List + Detail) only applies to the per-entry detail route `/admin/audit/[id]`. Original Appendix A entry "List + Detail" was over-broad; clarified above.
- **Sonderurlaubs-Typen**: ADMIN-MIG-12 satisfied by the `#sonderurlaub` tab inside `/admin/vacation`. The standalone `/admin/special-leave` route remains as a redirect stub (no UI).

---

_Regulatorium version: v1.6.2 · Last updated: 2026-08-03 · Owned by: Phase 50 executor + v1.6.1 audit closing pass + Phase 85.1-03 (Phorest tab extraction) · Next update: when the next admin-area change lands_
