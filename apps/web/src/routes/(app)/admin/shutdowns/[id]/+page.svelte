<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import {
    SHUTDOWN_NAME_MAX,
    dayCountLabel,
    formatShutdownDate,
    shutdownFieldMessages,
    type CompanyShutdown,
    type ShutdownEmployee,
    type ShutdownException,
  } from "$lib/settings/betriebsurlaub";

  // ── Loading state ──────────────────────────────────────────────────────────
  let loading = $state(true);
  let loadError = $state("");

  // ── Data state ─────────────────────────────────────────────────────────────
  let shutdown = $state<CompanyShutdown | null>(null);
  let allEmployees = $state<ShutdownEmployee[]>([]);

  const shutdownId = $derived($page.params.id);

  onMount(async () => {
    loading = true;
    loadError = "";
    try {
      const [shutdownsRes, employeesRes] = await Promise.allSettled([
        api.get<CompanyShutdown[]>("/company-shutdowns"),
        api.get<{ employees?: ShutdownEmployee[] } | ShutdownEmployee[]>("/employees?limit=500"),
      ]);

      if (shutdownsRes.status === "rejected") {
        loadError = "Der Betriebsurlaub konnte nicht geladen werden.";
        return;
      }
      const found = shutdownsRes.value.find((s) => s.id === shutdownId);
      if (!found) {
        loadError = "Betriebsurlaub nicht gefunden.";
        return;
      }
      shutdown = found;
      formName = found.name;
      formStart = found.startDate.slice(0, 10);
      formEnd = found.endDate.slice(0, 10);
      formDeducts = found.deductsFromVacation;
      formNotes = found.notes ?? "";

      shutdownSnapshot = snap(formName, formStart, formEnd, formDeducts, formNotes);
      snapshotsReady = true;

      if (employeesRes.status === "fulfilled") {
        const d = employeesRes.value;
        allEmployees = (Array.isArray(d) ? d : d.employees) ?? [];
      }
    } catch {
      loadError = "Der Betriebsurlaub konnte nicht geladen werden.";
    } finally {
      loading = false;
    }
  });

  // ── State ──────────────────────────────────────────────────────────────────
  let saving = $state(false);
  let saveError = $state("");

  // Edit form fields
  let formName = $state("");
  let formStart = $state("");
  let formEnd = $state("");
  let formDeducts = $state(false);
  let formNotes = $state("");

  // ── Unsaved-section tracking (Phase 109, D-11/D-12 · AK-06/AK-07) ──────────────
  // Snapshot comparison rather than per-field oninput flags - same idiom as admin/system.
  function snap(...values: unknown[]): string {
    return JSON.stringify(values);
  }

  let shutdownSnapshot = $state("");
  let shutdownDirty = $derived(
    snap(formName, formStart, formEnd, formDeducts, formNotes) !== shutdownSnapshot,
  );

  // The number of fields that differ from the snapshot (the SaveBar's "N Änderungen").
  const shutdownChanges = $derived.by(() => {
    if (shutdownSnapshot === "") return 0;
    const stored = JSON.parse(shutdownSnapshot) as unknown[];
    return [formName, formStart, formEnd, formDeducts, formNotes].filter(
      (value, index) => value !== stored[index],
    ).length;
  });

  const messages = $derived(
    shutdownFieldMessages({ name: formName, startDate: formStart, endDate: formEnd }),
  );
  const shutdownErrors = $derived(Object.values(messages).filter((m) => m !== "").length);

  // Gate the registration on "the baseline has been taken" (WR-01). onMount returns early on a
  // failed load AND on a not-found id, both before any field is hydrated - registering an ungated
  // dirty flag would arm the navigation guard on a page that shows nothing but an error.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-shutdown-detail", snapshotsReady && shutdownDirty);
    return () => markUnsaved("admin-shutdown-detail", false);
  });

  // Delete confirm
  let deleteConfirmOpen = $state(false);

  // Exceptions are instant writes from a Dialog and a ConfirmDialog; their drafts are a dialog-dismissal
  // concern that beforeNavigate never sees, so only the period section is tracked above.
  let exceptionDialogOpen = $state(false);
  let addExceptionEmpId = $state("");
  let addExceptionReason = $state("");
  let savingException = $state(false);
  let removeConfirm = $state<{ open: boolean; employeeId: string | null; name: string }>({
    open: false,
    employeeId: null,
    name: "",
  });

  const exceptionColumns: DataTableColumn[] = [
    { key: "person", label: "Mitarbeitende", primary: true },
    { key: "number", label: "Nr." },
    { key: "reason", label: "Grund" },
    { key: "actions", label: "Aktionen", align: "end" },
  ];

  // ── Reload ─────────────────────────────────────────────────────────────────
  async function reloadShutdown() {
    if (!shutdown) return;
    try {
      const all = await api.get<CompanyShutdown[]>("/company-shutdowns");
      const updated = all.find((s) => s.id === shutdown!.id);
      if (updated) shutdown = updated;
    } catch {
      toasts.error("Die Ausnahmen konnten nicht neu geladen werden. Lade die Seite neu.");
    }
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function saveShutdown() {
    if (!shutdown) return;
    if (shutdownErrors > 0) {
      saveError = "Bitte prüf die markierten Felder.";
      return;
    }
    saving = true;
    saveError = "";
    try {
      const updated = await api.patch<CompanyShutdown>(`/company-shutdowns/${shutdown.id}`, {
        name: formName.trim(),
        startDate: formStart,
        endDate: formEnd,
        deductsFromVacation: formDeducts,
        notes: formNotes,
      });
      shutdown = updated;
      shutdownSnapshot = snap(formName, formStart, formEnd, formDeducts, formNotes); // the section is clean again
      toasts.success("Betriebsurlaub gespeichert.");
    } catch (err) {
      // A refusal of the API is shown as the server worded it.
      saveError =
        err instanceof ApiError && err.status >= 400 && err.status < 500
          ? err.message
          : "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  function discardShutdown() {
    const stored = JSON.parse(shutdownSnapshot) as [string, string, string, boolean, string];
    [formName, formStart, formEnd, formDeducts, formNotes] = stored;
    saveError = "";
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function confirmDelete() {
    if (!shutdown) return;
    try {
      await api.delete(`/company-shutdowns/${shutdown.id}`);
      toasts.success("Betriebsurlaub gelöscht.");
      // The shutdown is gone: leave without the unsaved guard asking about the form.
      shutdownSnapshot = snap(formName, formStart, formEnd, formDeducts, formNotes);
      await goto("/verwalten/regeln/abwesenheiten#betriebsurlaub");
    } catch {
      toasts.error("Löschen fehlgeschlagen. Versuche es noch einmal.");
    }
  }

  // ── Exceptions ─────────────────────────────────────────────────────────────
  function openExceptions() {
    addExceptionEmpId = "";
    addExceptionReason = "";
    exceptionDialogOpen = true;
  }

  async function addException() {
    if (!shutdown || !addExceptionEmpId) return;
    savingException = true;
    try {
      await api.post(`/company-shutdowns/${shutdown.id}/exceptions`, {
        employeeId: addExceptionEmpId,
        reason: addExceptionReason || undefined,
      });
      exceptionDialogOpen = false;
      toasts.success("Ausnahme hinzugefügt.");
      await reloadShutdown();
    } catch {
      toasts.error(
        "Ausnahme konnte nicht hinzugefügt werden. Prüfe die Auswahl und versuche es noch einmal.",
      );
    } finally {
      savingException = false;
    }
  }

  function askRemoveException(ex: ShutdownException) {
    removeConfirm = {
      open: true,
      employeeId: ex.employeeId,
      name: `${ex.employee.firstName} ${ex.employee.lastName}`,
    };
  }

  async function confirmRemoveException() {
    if (!shutdown || !removeConfirm.employeeId) return;
    try {
      await api.delete(`/company-shutdowns/${shutdown.id}/exceptions/${removeConfirm.employeeId}`);
      toasts.success("Ausnahme entfernt.");
      await reloadShutdown();
    } catch {
      toasts.error("Ausnahme konnte nicht entfernt werden. Versuche es noch einmal.");
    }
  }

  const availableEmployees = $derived(
    shutdown
      ? allEmployees.filter((e) => !shutdown!.exceptions.some((ex) => ex.employeeId === e.id))
      : [],
  );
</script>

<svelte:head>
  <title>{shutdown ? shutdown.name : pageLabel("/admin/shutdowns")} – Clokr</title>
</svelte:head>

{#if loading}
  <Skeleton shape="card" count={2} lines={3} />
{:else if loadError || !shutdown}
  <div role="alert"><Note tone="bad">{loadError || "Betriebsurlaub nicht gefunden."}</Note></div>
{:else}
  <!-- A snippet body loses the `!shutdown` narrowing of the branch above, so it reads this const. -->
  {@const shownShutdown = shutdown}
  <PageHead
    title={shownShutdown.name}
    sub={`${formatShutdownDate(shownShutdown.startDate)} – ${formatShutdownDate(shownShutdown.endDate)} (${dayCountLabel(shownShutdown.startDate, shownShutdown.endDate)})`}
  >
    {#snippet actions()}
      <Chip tone={shownShutdown.deductsFromVacation ? "warn" : "neutral"}>
        {shownShutdown.deductsFromVacation ? "Zieht vom Urlaubskonto ab" : "Kein Urlaubsabzug"}
      </Chip>
    {/snippet}
  </PageHead>

  <div class="sd-stack">
    <!-- ── Zeitraum und Einstellungen ───────────────────────────────────────── -->
    <SettingsGroup
      title="Zeitraum und Einstellungen"
      description="Bezeichnung, Zeitraum und ob der Betriebsurlaub vom Urlaubskonto abgezogen wird."
      changes={shutdownChanges}
      errors={shutdownErrors}
      {saving}
      saveLabel="Betriebsurlaub speichern"
      onSave={saveShutdown}
      onDiscard={discardShutdown}
    >
      <FormField label="Bezeichnung" required error={messages.name}>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="text"
            maxlength={SHUTDOWN_NAME_MAX}
            placeholder="z. B. Weihnachtsschließung 2026"
            bind:value={formName}
            disabled={saving}
            data-testid="shutdown-name"
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
      <div class="sd-dates">
        <FormField label="Startdatum" required error={messages.startDate}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="date"
              bind:value={formStart}
              disabled={saving}
              data-testid="shutdown-start"
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
        <FormField label="Enddatum" required error={messages.endDate}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="date"
              bind:value={formEnd}
              disabled={saving}
              data-testid="shutdown-end"
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
      </div>
      <ToggleField
        bind:checked={formDeducts}
        label="Vom Urlaubskonto abziehen"
        help="Der Betriebsurlaub wird automatisch vom Jahresurlaub der Mitarbeitenden abgezogen, außer bei Ausnahmen."
        disabled={saving}
        testid="shutdown-deducts"
      />
      <FormField label="Notiz">
        {#snippet field({ id, describedBy })}
          <textarea
            {id}
            class="form-input"
            rows="3"
            placeholder="Interne Anmerkung (optional)"
            bind:value={formNotes}
            disabled={saving}
            data-testid="shutdown-notes"
            aria-describedby={describedBy}
          ></textarea>
        {/snippet}
      </FormField>
      {#if saveError}
        <div role="alert"><Note tone="bad">{saveError}</Note></div>
      {/if}
    </SettingsGroup>

    <!-- ── Ausnahmen ──────────────────────────────────────────────────────────── -->
    <section class="settings-group" aria-labelledby="shutdown-exceptions-title">
      <h2 class="settings-group-title" id="shutdown-exceptions-title">Ausnahmen</h2>
      <p class="settings-group-desc">
        Mitarbeitende in dieser Liste sind vom Betriebsurlaub ausgenommen; ihr Urlaubskonto wird
        nicht belastet.
      </p>
      <div class="sd-bar">
        <button type="button" class="btn btn-primary" onclick={openExceptions}>
          Ausnahme hinzufügen
        </button>
      </div>
      {#if shownShutdown.exceptions.length === 0}
        <EmptyState
          icon="users"
          title="Noch keine Ausnahmen"
          description="Alle Mitarbeitenden sind vom Betriebsurlaub betroffen."
        />
      {:else}
        <DataTable
          columns={exceptionColumns}
          rows={shownShutdown.exceptions}
          rowKey={(row) => row.id}
          caption="Ausnahmen vom Betriebsurlaub mit Mitarbeitenden und Grund"
        >
          {#snippet cell(row, column)}
            {#if column.key === "number"}
              {row.employee.employeeNumber}
            {:else if column.key === "reason"}
              {row.reason ?? "–"}
            {:else if column.key === "actions"}
              <button
                type="button"
                class="btn btn-secondary btn-sm btn-danger"
                onclick={() => askRemoveException(row)}
              >
                Entfernen
              </button>
            {:else}
              {row.employee.firstName}
              {row.employee.lastName}
            {/if}
          {/snippet}
        </DataTable>
      {/if}
    </section>

    <!-- ── Löschen ───────────────────────────────────────────────────────────── -->
    <section class="settings-group" aria-labelledby="shutdown-delete-title">
      <h2 class="settings-group-title" id="shutdown-delete-title">Betriebsurlaub löschen</h2>
      <p class="settings-group-desc">
        Der Betriebsurlaub wird unwiderruflich gelöscht. Seine Ausnahmen gehen mit.
      </p>
      <div>
        <button
          type="button"
          class="btn btn-secondary btn-danger"
          onclick={() => (deleteConfirmOpen = true)}
        >
          Betriebsurlaub löschen
        </button>
      </div>
    </section>
  </div>

  <ConfirmDialog
    bind:open={deleteConfirmOpen}
    title="Betriebsurlaub löschen?"
    description={`„${shownShutdown.name}“ wird entfernt. Diese Aktion kann nicht rückgängig gemacht werden.`}
    confirmLabel="Löschen"
    danger
    onConfirm={confirmDelete}
  />

  <ConfirmDialog
    bind:open={removeConfirm.open}
    title="Ausnahme entfernen?"
    description={`${removeConfirm.name} ist danach wieder vom Betriebsurlaub betroffen und ihr oder sein Urlaubskonto wird belastet.`}
    confirmLabel="Entfernen"
    danger
    onConfirm={confirmRemoveException}
  />

  <!-- ── Dialog: Ausnahme hinzufügen ───────────────────────────────────────── -->
  <Dialog bind:open={exceptionDialogOpen} title="Ausnahme hinzufügen">
    <form
      id="shutdown-exception-form"
      novalidate
      class="sd-form"
      onsubmit={(event) => {
        event.preventDefault();
        void addException();
      }}
    >
      <FormField
        label="Mitarbeitende"
        required
        help="Wer hier ausgenommen wird, bekommt den Betriebsurlaub nicht vom Urlaubskonto abgezogen."
      >
        {#snippet field({ id, describedBy })}
          <select
            {id}
            class="form-input"
            bind:value={addExceptionEmpId}
            data-testid="shutdown-exception-employee"
            aria-describedby={describedBy}
          >
            <option value="">– Person wählen –</option>
            {#each availableEmployees as emp (emp.id)}
              <option value={emp.id}>{emp.firstName} {emp.lastName} ({emp.employeeNumber})</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
      <FormField label="Grund">
        {#snippet field({ id, describedBy })}
          <input
            {id}
            class="form-input"
            type="text"
            placeholder="z. B. Notdienstbereitschaft (optional)"
            bind:value={addExceptionReason}
            data-testid="shutdown-exception-reason"
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </form>
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={() => (exceptionDialogOpen = false)}>
        Abbrechen
      </button>
      <button
        type="submit"
        form="shutdown-exception-form"
        class="btn btn-primary"
        disabled={!addExceptionEmpId || savingException}
      >
        {savingException ? "Hinzufügen …" : "Hinzufügen"}
      </button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .sd-stack {
    display: flex;
    flex-direction: column;
    gap: var(--s-8);
  }

  .sd-dates {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--s-4);
  }

  .sd-bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--s-3);
  }

  .sd-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>
