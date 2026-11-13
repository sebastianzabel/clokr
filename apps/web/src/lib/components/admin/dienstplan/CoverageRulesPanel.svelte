<!--
  CoverageRulesPanel - the „Bedarfsregeln“ tab of Verwalten › Regeln › Dienstplan (Issue #854,
  rebuilt on the blocks of #843; the data and the endpoints are those of the pre-#854 page).

  A rule says how many people a template needs on a weekday ("Mindestbesetzung"); the most specific
  rule wins, without a rule 2 people apply. Since Issue #647 a rule can name ONE salon: the choice is
  offered only under the #64 rule (`showSalonOptions()`, its one place), the key is sent only while the
  choice is shown (`coverageRuleSalonPayload`), and a rule of a deactivated salon stays, marked. The
  API validates every salon id (one 404 for a foreign or unknown one); nothing here is a boundary.

  Writes are `POST /shifts/coverage-rules`, `PUT /shifts/coverage-rules/:id` and
  `DELETE /shifts/coverage-rules/:id`; each acts at once and answers with a toast. A rule is edited in a
  Dialog, deleted behind a ConfirmDialog.

  Props:
    rules     - the rows of the list (`GET /shifts/coverage-rules`)
    templates - the shift templates, for the template choice and the template column
    onChanged - called after every successful write
-->
<script lang="ts">
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import { salonContext, showSalonOptions } from "$stores/salon-context";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import {
    DAY_NAMES_LONG,
    type CoverageRule,
    type ShiftTemplate,
  } from "$lib/shifts/dienstplan-config";
  import {
    COVERAGE_RULE_SALON_INACTIVE_BADGE,
    coverageRuleSalonCell,
    coverageRuleSalonChoices,
    coverageRuleSalonPayload,
    showCoverageSalonColumn,
  } from "$lib/shifts/coverage-rule-salon";
  import { formatStaff } from "$lib/shifts/staffing"; // Issue #850 - "2", never "2.00"

  interface Props {
    rules: CoverageRule[];
    templates: ShiftTemplate[];
    onChanged: () => Promise<void>;
  }

  let { rules, templates, onChanged }: Props = $props();

  // The #64 rule, in its one place: the salon choice and the list column appear only with salon options.
  const salonOptionsShown = $derived(showSalonOptions($salonContext));
  const salonColumnShown = $derived(showCoverageSalonColumn(salonOptionsShown, rules));

  const columns = $derived<DataTableColumn[]>([
    { key: "template", label: "Vorlage", primary: true },
    { key: "day", label: "Wochentag" },
    ...(salonColumnShown ? [{ key: "salon", label: "Salon" }] : []),
    { key: "min", label: "Mindestens" },
    { key: "supervision", label: "Aufsicht erforderlich" },
    { key: "actions", label: "Aktion", align: "end" as const },
  ]);

  type RuleRow = {
    id: string;
    rule: CoverageRule;
    template: string;
    day: string;
    min: string;
    supervision: string;
  };

  function templateName(rule: CoverageRule): string {
    if (!rule.templateId) return "Alle Vorlagen";
    return templates.find((t) => t.id === rule.templateId)?.name ?? "Unbekannte Vorlage";
  }

  function dayLabel(rule: CoverageRule): string {
    if (rule.dayOfWeek === -1) return "Alle Tage";
    return DAY_NAMES_LONG[rule.dayOfWeek] ?? "—";
  }

  const rows = $derived<RuleRow[]>(
    rules.map((rule) => ({
      id: rule.id,
      rule,
      template: templateName(rule),
      day: dayLabel(rule),
      min: formatStaff(Number(rule.minStaff)),
      supervision: rule.requiresNonSupervised ? "Ja" : "Nein",
    })),
  );

  // ── Editor ────────────────────────────────────────────────────
  let editorOpen = $state(false);
  let editingId: string | null = $state(null);
  let templateId = $state(""); // "" = all templates
  let dayOfWeek = $state<number>(-1);
  let minStaff = $state<number | null>(2);
  let requiresNonSupervised = $state(false);
  // Issue #647: "" = all salons (tenant-wide). Sent only while the select is shown.
  let salonId = $state("");
  let formError = $state("");
  let saving = $state(false);

  const salonChoices = $derived(
    coverageRuleSalonChoices($salonContext.salons, rules.find((r) => r.id === editingId) ?? null),
  );

  function openCreate() {
    editingId = null;
    templateId = "";
    dayOfWeek = -1;
    minStaff = 2;
    requiresNonSupervised = false;
    salonId = "";
    formError = "";
    editorOpen = true;
  }

  function openEdit(row: RuleRow) {
    const rule = row.rule;
    editingId = rule.id;
    templateId = rule.templateId ?? "";
    dayOfWeek = rule.dayOfWeek;
    minStaff = Number(rule.minStaff);
    requiresNonSupervised = rule.requiresNonSupervised;
    salonId = rule.salonId ?? "";
    formError = "";
    editorOpen = true;
  }

  // Runs inside the Dialog's form: a refusal keeps the dialog open with its text.
  async function saveRule() {
    if (minStaff === null || !Number.isFinite(minStaff) || minStaff < 0) {
      formError = "Die Mindestbesetzung muss eine Zahl ab 0 sein.";
      return;
    }
    saving = true;
    formError = "";
    const creating = editingId === null;
    try {
      const payload = {
        templateId: templateId || null,
        dayOfWeek,
        minStaff,
        requiresNonSupervised,
        ...coverageRuleSalonPayload(salonOptionsShown, salonId),
      };
      if (editingId) {
        await api.put(`/shifts/coverage-rules/${editingId}`, payload);
      } else {
        await api.post("/shifts/coverage-rules", payload);
      }
      toasts.success(creating ? "Mindestbesetzung angelegt." : "Mindestbesetzung gespeichert.");
      editorOpen = false;
      editingId = null;
      await onChanged();
    } catch (err) {
      // A refusal of the API (e.g. a salon outside the reach) is shown as the server worded it.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        formError = err.message;
      } else {
        toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
      }
    } finally {
      saving = false;
    }
  }

  // ── Deletion ──────────────────────────────────────────────────
  let deleteTarget: RuleRow | null = $state(null);
  let deleteOpen = $state(false);

  function askDelete(row: RuleRow) {
    deleteTarget = row;
    deleteOpen = true;
  }

  // Runs inside ConfirmDialog: a refusal toasts the server's text and is rethrown, so the dialog
  // swallows it and stays open.
  async function deleteRule() {
    if (!deleteTarget) return;
    try {
      await api.delete(`/shifts/coverage-rules/${deleteTarget.id}`);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Löschen fehlgeschlagen.");
      throw err;
    }
    toasts.success("Mindestbesetzung gelöscht.");
    await onChanged();
  }
</script>

<section class="settings-group" aria-labelledby="dienstplan-bedarf-title">
  <h2 class="settings-group-title" id="dienstplan-bedarf-title">Bedarfsregeln</h2>
  <p class="settings-group-desc">
    Wie viele Personen je Vorlage und Wochentag mindestens eingeplant sein sollen. Die genaueste
    Regel gilt; ohne Regel sind es 2.
  </p>

  <div class="dp-bar">
    <button type="button" class="btn btn-primary" onclick={openCreate}>Regel anlegen</button>
  </div>

  {#if rules.length === 0}
    <EmptyState
      icon="calendar"
      title="Noch keine Mindestbesetzung festgelegt"
      description="Ohne Regel gelten 2 Personen."
    />
  {:else}
    <DataTable
      {columns}
      {rows}
      rowKey={(row) => row.id}
      onRowClick={openEdit}
      caption="Bedarfsregeln mit Vorlage, Wochentag und Mindestbesetzung"
    >
      {#snippet cell(row, column)}
        {#if column.key === "salon"}
          {@const salonCell = coverageRuleSalonCell(row.rule)}
          {salonCell.label}
          {#if salonCell.inactive}
            <Chip tone="warn">{COVERAGE_RULE_SALON_INACTIVE_BADGE}</Chip>
          {/if}
        {:else if column.key === "day"}
          {row.day}
        {:else if column.key === "min"}
          {row.min}
        {:else if column.key === "supervision"}
          {row.supervision}
        {:else if column.key === "actions"}
          <button
            type="button"
            class="btn btn-ghost btn-sm btn-danger"
            aria-label="Regel {row.template}, {row.day} löschen"
            onclick={() => askDelete(row)}
          >
            Löschen
          </button>
        {:else}
          {row.template}
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</section>

<Dialog
  bind:open={editorOpen}
  title={editingId ? "Mindestbesetzung bearbeiten" : "Mindestbesetzung anlegen"}
>
  <form
    id="coverage-rule-form"
    novalidate
    class="dp-form"
    onsubmit={(event) => {
      event.preventDefault();
      void saveRule();
    }}
  >
    <Note tone="info">
      Die genaueste Regel gilt: erst Vorlage und Wochentag, dann alle Vorlagen an diesem Wochentag,
      dann die Vorlage an allen Tagen, zuletzt alle Vorlagen an allen Tagen. Ohne Regel gelten 2
      Personen.
    </Note>
    {#if salonOptionsShown}
      <FormField
        label="Salon"
        help="Eine Regel für einen Salon geht auf derselben Stufe der Regel für alle Salons vor. Die Regel gilt, wenn die Wochenansicht genau diesen Salon zeigt: bei Wahl in der Kopfleiste, für alle, die nur diesen Salon planen, und in Unternehmen mit nur einem aktiven Salon. Sonst gelten nur die Regeln für alle Salons."
      >
        {#snippet field({ id, describedBy, invalid })}
          <select
            {id}
            class="form-input"
            bind:value={salonId}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          >
            {#each salonChoices as choice (choice.value)}
              <option value={choice.value}>{choice.label}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
    {/if}
    <FormField label="Vorlage">
      {#snippet field({ id, describedBy, invalid })}
        <select
          {id}
          class="form-input"
          bind:value={templateId}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        >
          <option value="">Alle Vorlagen</option>
          {#each templates as template (template.id)}
            <option value={template.id}>{template.name}</option>
          {/each}
        </select>
      {/snippet}
    </FormField>
    <FormField label="Wochentag">
      {#snippet field({ id, describedBy, invalid })}
        <select
          {id}
          class="form-input"
          bind:value={dayOfWeek}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        >
          <option value={-1}>Alle Tage</option>
          {#each DAY_NAMES_LONG as name, index (index)}
            <option value={index}>{name}</option>
          {/each}
        </select>
      {/snippet}
    </FormField>
    <FormField
      label="Mindestens (Personen)"
      required
      help="Personen zählen nach ihrem Schicht-Gewicht, z. B. Vollzeit 1 und Azubi 0,5 – zusammen 1,5."
    >
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="number"
          step="0.25"
          min="0"
          max="99"
          bind:value={minStaff}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <ToggleField
      bind:checked={requiresNonSupervised}
      label="Aufsicht erforderlich"
      help="Mindestens 1 nicht-aufsichtspflichtige Person muss eingeplant sein."
    />
    {#if formError}
      <div role="alert"><Note tone="bad">{formError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (editorOpen = false)}>
      Abbrechen
    </button>
    <button type="submit" form="coverage-rule-form" class="btn btn-primary" disabled={saving}>
      {saving ? "Speichern …" : "Speichern"}
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={deleteOpen}
  title="Mindestbesetzung löschen?"
  description="Die Regel wird dauerhaft entfernt. Gibt es keine andere passende Regel, gelten 2 Personen."
  confirmLabel="Löschen"
  danger
  onConfirm={deleteRule}
/>

<style>
  .dp-bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--s-3);
  }

  .dp-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>
