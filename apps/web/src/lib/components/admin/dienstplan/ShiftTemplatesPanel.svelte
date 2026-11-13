<!--
  ShiftTemplatesPanel - the „Schichtvorlagen“ tab of Verwalten › Regeln › Dienstplan (Issue #854,
  rebuilt on the blocks of #843; the data and the endpoints are those of the pre-#854 page).

  Reads nothing itself: the page loads `GET /shifts/templates` and hands the rows in. Writes are
  `POST /shifts/templates`, `PUT /shifts/templates/:id` and `DELETE /shifts/templates/:id`; each acts
  at once and answers with a toast (docs/ADMIN_STRUCTURE.md §3.2.1: a list action saves instantly,
  there is no section button). A template is created and edited in a Dialog, deleted behind a
  ConfirmDialog. `onChanged` asks the page to reload the lists.

  Props:
    templates - the rows of the list
    onChanged - called after every successful write
-->
<script lang="ts">
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import {
    SHIFT_PALETTE,
    resolveShiftToken,
    type ShiftTemplate,
  } from "$lib/shifts/dienstplan-config";

  interface Props {
    templates: ShiftTemplate[];
    onChanged: () => Promise<void>;
  }

  let { templates, onChanged }: Props = $props();

  const columns: DataTableColumn[] = [
    { key: "color", label: "Farbe" },
    { key: "name", label: "Name", primary: true },
    { key: "span", label: "Zeitraum" },
    { key: "actions", label: "Aktion", align: "end" },
  ];

  type TemplateRow = ShiftTemplate & { span: string };
  const rows = $derived<TemplateRow[]>(
    templates.map((template) => ({
      ...template,
      span: `${template.startTime} – ${template.endTime}`,
    })),
  );

  // ── Editor ────────────────────────────────────────────────────
  let editorOpen = $state(false);
  let editingId: string | null = $state(null);
  let name = $state("");
  let startTime = $state("06:00");
  let endTime = $state("14:00");
  let color = $state("");
  let formError = $state("");
  let saving = $state(false);

  function openCreate() {
    editingId = null;
    name = "";
    startTime = "06:00";
    endTime = "14:00";
    color = resolveShiftToken("--shift-violet");
    formError = "";
    editorOpen = true;
  }

  function openEdit(row: TemplateRow) {
    editingId = row.id;
    name = row.name;
    startTime = row.startTime;
    endTime = row.endTime;
    color = row.color;
    formError = "";
    editorOpen = true;
  }

  function pickPaletteColor(token: string) {
    color = resolveShiftToken(token, color);
  }

  // Runs inside the Dialog's form: a refusal keeps the dialog open with its text.
  async function saveTemplate() {
    if (!name.trim() || !startTime || !endTime) {
      formError = "Name, Start- und Endzeit sind Pflichtfelder.";
      return;
    }
    saving = true;
    formError = "";
    const creating = editingId === null;
    try {
      const payload = { name: name.trim(), startTime, endTime, color };
      if (editingId) {
        await api.put(`/shifts/templates/${editingId}`, payload);
      } else {
        await api.post("/shifts/templates", payload);
      }
      toasts.success(creating ? "Vorlage angelegt." : "Vorlage gespeichert.");
      editorOpen = false;
      editingId = null;
      await onChanged();
    } catch (err) {
      // A refusal of the API is shown as the server worded it; anything else is a toast.
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
  let deleteTarget: ShiftTemplate | null = $state(null);
  let deleteOpen = $state(false);

  function askDelete(template: ShiftTemplate) {
    deleteTarget = template;
    deleteOpen = true;
  }

  // Runs inside ConfirmDialog: a refusal toasts the server's text and is rethrown, so the dialog
  // swallows it and stays open.
  async function deleteTemplate() {
    if (!deleteTarget) return;
    try {
      await api.delete(`/shifts/templates/${deleteTarget.id}`);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Löschen fehlgeschlagen.");
      throw err;
    }
    toasts.success("Vorlage gelöscht.");
    await onChanged();
  }
</script>

<section class="settings-group" aria-labelledby="dienstplan-vorlagen-title">
  <h2 class="settings-group-title" id="dienstplan-vorlagen-title">Schichtvorlagen</h2>
  <p class="settings-group-desc">
    Wiederkehrende Schichten mit Zeitraum und Farbe. Du wählst sie im Dienstplan, in den
    Bedarfsregeln und in den Wochenmustern aus.
  </p>

  <div class="dp-bar">
    <button type="button" class="btn btn-primary" onclick={openCreate}>Vorlage anlegen</button>
  </div>

  {#if templates.length === 0}
    <EmptyState
      icon="calendar"
      title="Noch keine Schichtvorlagen"
      description="Lege eine Vorlage an, um Schichten schneller zu planen."
    />
  {:else}
    <DataTable
      {columns}
      {rows}
      rowKey={(row) => row.id}
      onRowClick={openEdit}
      caption="Schichtvorlagen mit Zeitraum und Farbe"
    >
      {#snippet cell(row, column)}
        {#if column.key === "color"}
          <span class="dp-swatch" style="--swatch: {row.color}" aria-hidden="true"></span>
        {:else if column.key === "span"}
          {row.span}
        {:else if column.key === "actions"}
          <button
            type="button"
            class="btn btn-ghost btn-sm btn-danger"
            aria-label="Vorlage {row.name} löschen"
            onclick={() => askDelete(row)}
          >
            Löschen
          </button>
        {:else}
          {row.name}
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</section>

<Dialog bind:open={editorOpen} title={editingId ? "Vorlage bearbeiten" : "Vorlage anlegen"}>
  <form
    id="shift-template-form"
    novalidate
    class="dp-form"
    onsubmit={(event) => {
      event.preventDefault();
      void saveTemplate();
    }}
  >
    <FormField label="Name" required>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          maxlength={100}
          placeholder="z. B. Frühschicht"
          bind:value={name}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <div class="dp-row">
      <FormField label="Startzeit" required>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="time"
            bind:value={startTime}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
      <FormField label="Endzeit" required>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="time"
            bind:value={endTime}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>
    <FormField label="Farbe">
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input dp-color"
          type="color"
          bind:value={color}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <div class="dp-palette" role="group" aria-label="Schichtfarbe wählen">
      {#each SHIFT_PALETTE as entry (entry.token)}
        <button
          type="button"
          class="dp-palette-btn"
          style="--swatch: var({entry.token})"
          title={entry.label}
          aria-label={entry.label}
          onclick={() => pickPaletteColor(entry.token)}
        ></button>
      {/each}
    </div>
    {#if formError}
      <div role="alert"><Note tone="bad">{formError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (editorOpen = false)}>
      Abbrechen
    </button>
    <button type="submit" form="shift-template-form" class="btn btn-primary" disabled={saving}>
      {saving ? "Speichern …" : "Speichern"}
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={deleteOpen}
  title="Vorlage löschen?"
  description={deleteTarget ? `Die Vorlage „${deleteTarget.name}“ wird dauerhaft entfernt.` : ""}
  confirmLabel="Löschen"
  danger
  onConfirm={deleteTemplate}
/>

<style>
  .dp-bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--s-3);
  }

  .dp-swatch,
  .dp-palette-btn {
    display: inline-block;
    width: 24px;
    height: 24px;
    border-radius: var(--r-control);
    border: 1px solid var(--line);
    background: var(--swatch);
    padding: 0;
  }

  .dp-palette-btn {
    cursor: pointer;
  }

  .dp-palette-btn:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }

  .dp-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .dp-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-3);
  }

  .dp-color {
    width: 48px;
    padding: 2px;
    cursor: pointer;
  }

  .dp-palette {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
</style>
