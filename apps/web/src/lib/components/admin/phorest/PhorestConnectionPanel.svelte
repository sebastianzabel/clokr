<!--
  PhorestConnectionPanel - the „Verbindung“ tab of Verwalten › System › Phorest (Issue #854, rebuilt on the
  blocks of #843; the data, the endpoints and the rules are those of the pre-#854 page `/admin/phorest`).

  Two groups:
    - „Zugangsdaten und Import“ (registry section `phorest-verbindung`): Business-ID, Branch-ID, API-Benutzername,
      write-only API-Passwort, prep and wrap-up minutes, sync window and the automatic sync. One SaveBar sends
      exactly the nine keys of the section to `PUT /integrations/phorest/config`. The API needs the Business-ID and
      the user name on every save, so the import fields cannot save alone. Phorest credentials are security
      configuration and never save on a single change (§3.2.1, D-07).
    - „Mitarbeiter-Zuordnung“ (no configuration keys): the Phorest staff mapped to Clokr employees, one explicit
      save per row. Phorest stays the roster master; an unmapped person's shifts are skipped.

  The Branch-ID (Issue #65, D-19/D-20): it lives on the salon coupling, so the field is editable only while exactly
  one salon is active; with several the hint says so. Where the tenant has not booked „Integrationen“ and the sole
  salon has no coupling yet, a first coupling would be refused, so the field is locked and the request carries no
  branch (Issue #566, display only; the server refuses regardless). The package state is read reactively from the
  store, never once: the layout's own forced load supersedes this panel's.

  Presentation only: `integration:manage` is checked by the API; a 403 shows a calm note, not an error. A failed
  load shows that instead of an editable form with made-up defaults.

  Props:
    status  - bindable, what the page's status strip shows; this panel writes the connection and mapping figures
    changes - bindable, the number of unsaved changes (the page sums it into markUnsaved)
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import { authStore } from "$stores/auth";
  import { salonContext, moduleBooked } from "$stores/salon-context";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    PHOREST_BOUNDS,
    SYNC_CRON_OPTIONS,
    mappingRowFrom,
    mappingStatus,
    messageCount,
    phorestFrom,
    phorestMessages,
    phorestWire,
    unsavedMappingCount,
    type PhorestConfig,
    type PhorestField,
    type PhorestMappingRow,
    type PhorestStaffItem,
    type PhorestStatus,
    type PhorestValues,
  } from "$lib/settings/phorest";

  interface Props {
    status: PhorestStatus;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { status = $bindable(), changes = $bindable(0) }: Props = $props();

  const keys = settingsSection("phorest-verbindung").keys as readonly PhorestField[];
  const LOAD_ERROR = "Die Phorest-Einstellungen konnten nicht geladen werden.";

  // ── Connection and import ────────────────────────────────────────────────
  let loading = $state(true);
  let loadError = $state("");
  let forbidden = $state(false);

  let snapshot = $state<PhorestValues>(phorestFrom(emptyConfig()));
  let values = $state<PhorestValues>(phorestFrom(emptyConfig()));
  let saving = $state(false);

  // Phase 65b (issue #65, D-20): true iff the tenant has exactly one active salon - the API is the authority
  // here, the panel only reflects it. When false the Branch-ID field is locked.
  let phSoleSalon = $state(true);
  // The sole active salon's existing coupling branch as the API returned it (null = none yet).
  let phServerBranchId = $state<string | null>(null);
  let phConfigLoaded = $state(false);
  // Phase 566 (D-05, D-12): a first coupling would be refused. An existing coupling stays editable (updating
  // the branch is free). Unknown package state never blocks. Derived from the store, never read once.
  const phCouplingBlocked = $derived(
    phConfigLoaded &&
      moduleBooked($salonContext, "INTEGRATIONS") === false &&
      phServerBranchId === null,
  );
  const phBranchIdEditable = $derived(phSoleSalon && !phCouplingBlocked);
  // True when more than one salon is active (the branch is then coupled per salon).
  const phMultiSalon = $derived(phConfigLoaded && !phSoleSalon);

  function emptyConfig(): PhorestConfig {
    return {
      configured: false,
      phorestBusinessId: null,
      branchId: null,
      branchIdEditable: true,
      phorestUsername: null,
      phorestAutoSync: false,
      phorestSyncCron: null,
      phorestSyncWindowDays: null,
      phorestPrepMinutes: null,
      phorestWrapupMinutes: null,
    };
  }

  const messages = $derived(phorestMessages(values, { branchEditable: phBranchIdEditable }));
  const errorCount = $derived(messageCount(messages));
  const configChanges = $derived(countChanges(snapshot, values, keys));

  async function loadConfig() {
    loading = true;
    loadError = "";
    forbidden = false;
    try {
      // Forced, so the package state is fresh before the Branch-ID field is decided.
      await salonContext.load($authStore.user?.id ?? null, { force: true }).catch(() => undefined);
      const config = await api.get<PhorestConfig>("/integrations/phorest/config");
      const loaded = phorestFrom(config);
      snapshot = loaded;
      values = $state.snapshot(loaded);
      phSoleSalon = config.branchIdEditable;
      phServerBranchId = config.branchId;
      phConfigLoaded = true;
      status.configured = config.configured;
      status.autoSync = loaded.phorestAutoSync;
      status.syncCron = loaded.phorestSyncCron;
      status.syncWindowDays = loaded.phorestSyncWindowDays ?? status.syncWindowDays;
      if (config.configured) {
        void loadEmployees();
        void loadMapping();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) forbidden = true;
      else loadError = LOAD_ERROR;
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (errorCount > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    saving = true;
    try {
      const wire = phorestWire(values, { branchEditable: phBranchIdEditable });
      await api.put(
        "/integrations/phorest/config",
        pickSection(wire as Record<string, unknown>, settingsSection("phorest-verbindung").keys),
      );
      // The password is write-only: it never enters the snapshot, and the field is empty again.
      const saved = { ...$state.snapshot(values), phorestPassword: "" };
      snapshot = saved;
      values = $state.snapshot(saved);
      if (phBranchIdEditable) phServerBranchId = saved.branchId.trim();
      const firstTime = !status.configured;
      status.configured = true;
      status.autoSync = saved.phorestAutoSync;
      status.syncCron = saved.phorestSyncCron;
      status.syncWindowDays = saved.phorestSyncWindowDays ?? status.syncWindowDays;
      toasts.success("Phorest-Einstellungen gespeichert.");
      // After the first save the mapping can be read.
      if (firstTime && mapRows.length === 0) {
        void loadEmployees();
        void loadMapping();
      }
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      saving = false;
    }
  }

  function discard() {
    values = $state.snapshot(snapshot);
  }

  // ── Connection test ──────────────────────────────────────────────────────
  let testing = $state(false);
  let testResult = $state<{ ok: boolean; text: string } | null>(null);

  async function testConnection() {
    testing = true;
    testResult = null;
    try {
      const res = await api.post<{
        ok: boolean;
        reason?: string;
        message?: string;
        staffCount?: number;
        branchName?: string;
      }>("/integrations/phorest/test", {});
      // The API already words the failure (auth invalid vs. unreachable) in German (SS-02).
      status.testOk = res.ok;
      if (res.ok) {
        const branch = res.branchName ? `Branch „${res.branchName}“, ` : "";
        testResult = {
          ok: true,
          text: `Verbindung erfolgreich: ${branch}${res.staffCount ?? "?"} Mitarbeiter gefunden.`,
        };
      } else {
        testResult = { ok: false, text: res.message ?? "Verbindung fehlgeschlagen." };
      }
    } catch (err) {
      status.testOk = false;
      testResult = {
        ok: false,
        text: err instanceof Error ? err.message : "Verbindung fehlgeschlagen.",
      };
    } finally {
      testing = false;
    }
  }

  // ── Staff mapping ────────────────────────────────────────────────────────
  interface PhEmployee {
    id: string;
    firstName: string;
    lastName: string;
  }

  let phEmployees: PhEmployee[] = $state([]);
  let mapRows: PhorestMappingRow[] = $state([]);
  let mapLoading = $state(false);
  let mapPage = $state(1);
  let mapPageSize = $state(10);
  let removeConfirm = $state<{ open: boolean; phorestStaffId: string; name: string }>({
    open: false,
    phorestStaffId: "",
    name: "",
  });

  const mappedCount = $derived(mapRows.filter((row) => row.savedEmployeeId).length);
  const unmappedCount = $derived(mapRows.length - mappedCount);
  const pagedRows = $derived(mapRows.slice((mapPage - 1) * mapPageSize, mapPage * mapPageSize));
  const mappingChanges = $derived(unsavedMappingCount(mapRows));

  $effect(() => {
    status.mappedCount = mappedCount;
    status.staffTotal = mapRows.length;
  });

  $effect(() => {
    changes = configChanges + mappingChanges;
  });

  const mapColumns: DataTableColumn[] = [
    { key: "name", label: "Phorest-Mitarbeiter", primary: true },
    { key: "email", label: "E-Mail" },
    { key: "phorestStaffId", label: "Phorest-ID" },
    { key: "employee", label: "Clokr-Mitarbeiter" },
    { key: "status", label: "Status" },
    { key: "actions", label: "Aktionen", align: "end" },
  ];

  async function loadEmployees() {
    try {
      const res = await api.get<PhEmployee[] | { employees: PhEmployee[] }>("/employees?limit=500");
      phEmployees = Array.isArray(res) ? res : (res.employees ?? []);
    } catch {
      // Not fatal: the select stays empty and a row can still be left unmapped.
    }
  }

  async function loadMapping() {
    mapLoading = true;
    try {
      const res = await api.get<{ staff?: PhorestStaffItem[]; error?: string }>(
        "/integrations/phorest/staff",
      );
      // The table is pre-filled with the server's suggestion for every unmapped row; the baseline of the
      // unsaved count is that selection as loaded, so a fresh table is not "unsaved".
      mapRows = (res.staff ?? []).map(mappingRowFrom);
    } catch {
      mapRows = [];
    } finally {
      mapLoading = false;
    }
  }

  /** The sync panel calls this after a run: the unmapped figures of the run may have changed. */
  export function reloadMapping(): Promise<void> {
    return status.configured ? loadMapping() : Promise.resolve();
  }

  async function saveRow(row: PhorestMappingRow) {
    if (!row.selectedEmployeeId) return;
    row.saving = true;
    try {
      await api.post("/integrations/phorest/mappings", {
        phorestStaffId: row.phorestStaffId,
        employeeId: row.selectedEmployeeId,
      });
      row.savedEmployeeId = row.selectedEmployeeId;
      row.baselineEmployeeId = row.selectedEmployeeId;
      toasts.success("Zuordnung gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Zuordnung fehlgeschlagen.");
    } finally {
      row.saving = false;
    }
  }

  function askRemove(row: PhorestMappingRow) {
    const employee = phEmployees.find((entry) => entry.id === row.savedEmployeeId);
    removeConfirm = {
      open: true,
      phorestStaffId: row.phorestStaffId,
      name: employee ? `${employee.firstName} ${employee.lastName}` : row.name,
    };
  }

  async function confirmRemove() {
    const staffId = removeConfirm.phorestStaffId;
    try {
      await api.delete(`/integrations/phorest/mappings/${staffId}`);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Aufheben fehlgeschlagen.");
      throw err;
    }
    const row = mapRows.find((entry) => entry.phorestStaffId === staffId);
    if (row) {
      row.savedEmployeeId = null;
      // The selection stays in place; it is the new baseline, so the removal does not read as unsaved.
      row.baselineEmployeeId = row.selectedEmployeeId;
    }
    toasts.success("Zuordnung aufgehoben.");
  }

  onMount(() => {
    void loadConfig();
  });
</script>

{#if forbidden}
  <div role="alert">
    <Note tone="bad">Für die Phorest-Anbindung fehlt dir die Berechtigung.</Note>
  </div>
{:else if loadError}
  <ErrorState message={loadError} onRetry={loadConfig} retrying={loading} />
{:else if loading}
  <Skeleton shape="card" count={1} lines={5} />
{:else}
  <SettingsGroup
    id="zugangsdaten"
    title="Zugangsdaten und Import"
    description="So meldet sich Clokr bei Phorest an und so holt es die Schichten ab."
    changes={configChanges}
    errors={errorCount}
    {saving}
    saveLabel="Phorest-Einstellungen speichern"
    onSave={save}
    onDiscard={discard}
  >
    <FormField label="Business-ID" required error={messages.phorestBusinessId}>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          placeholder="z. B. abc123def456"
          bind:value={values.phorestBusinessId}
          disabled={saving}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>

    <FormField
      label="Branch-ID"
      required={phBranchIdEditable}
      help={phMultiSalon
        ? "Mehrere aktive Salons — die Phorest-Filiale wird je Salon gekoppelt."
        : undefined}
      error={messages.branchId}
    >
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          placeholder="z. B. branch-001"
          bind:value={values.branchId}
          disabled={!phBranchIdEditable || saving}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    {#if phCouplingBlocked}
      <ModuleHint module="INTEGRATIONS" subject="Phorest-Kopplungen" />
    {/if}

    <FormField label="API-Benutzername (E-Mail)" required error={messages.phorestUsername}>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          autocomplete="off"
          placeholder="api@salon.de"
          bind:value={values.phorestUsername}
          disabled={saving}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>

    <FormField label="API-Passwort" help="Leer lassen, um das gespeicherte Passwort beizubehalten.">
      {#snippet field({ id, describedBy })}
        <input
          {id}
          class="form-input"
          type="password"
          autocomplete="new-password"
          placeholder="••••••••"
          bind:value={values.phorestPassword}
          disabled={saving}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>

    <div class="pc-test">
      <button
        type="button"
        class="btn btn-secondary"
        onclick={testConnection}
        disabled={testing || !status.configured}
      >
        {#if testing}<Spinner size={14} label="Verbindung wird getestet" />{/if}
        Verbindung testen
      </button>
      {#if !status.configured}
        <span class="pc-test-hint">Speichere zuerst die Zugangsdaten.</span>
      {/if}
    </div>
    {#if testResult}
      <div role={testResult.ok ? "status" : "alert"}>
        <Note tone={testResult.ok ? "ok" : "bad"}>{testResult.text}</Note>
      </div>
    {/if}

    {#if status.configured}
      <h3 class="pc-subhead">Vor- und Nachbereitung</h3>
      <p class="pc-note">
        Phorest hält die buchbare Zeit fest. Die tatsächliche Arbeitszeit beginnt früher und endet
        später. Dieser Puffer wird bei jedem Import auf die gespeicherte Schicht angewendet.
      </p>
      <div class="pc-pair">
        <FormField label="Vorbereitungszeit (Minuten)" error={messages.phorestPrepMinutes}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              inputmode="numeric"
              min={PHOREST_BOUNDS.phorestPrepMinutes.min}
              max={PHOREST_BOUNDS.phorestPrepMinutes.max}
              step="1"
              bind:value={values.phorestPrepMinutes}
              disabled={saving}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
        <FormField label="Nachbereitungszeit (Minuten)" error={messages.phorestWrapupMinutes}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              inputmode="numeric"
              min={PHOREST_BOUNDS.phorestWrapupMinutes.min}
              max={PHOREST_BOUNDS.phorestWrapupMinutes.max}
              step="1"
              bind:value={values.phorestWrapupMinutes}
              disabled={saving}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
      </div>

      <h3 class="pc-subhead">Zeitfenster</h3>
      <FormField
        label="Zeitfenster (Tage)"
        help="Gilt für den automatischen und den manuellen Abgleich. Standard: 7 Tage."
        error={messages.phorestSyncWindowDays}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input pc-narrow"
            type="number"
            inputmode="numeric"
            min={PHOREST_BOUNDS.phorestSyncWindowDays.min}
            max={PHOREST_BOUNDS.phorestSyncWindowDays.max}
            step="1"
            bind:value={values.phorestSyncWindowDays}
            disabled={saving}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>

      <h3 class="pc-subhead">Automatischer Abgleich</h3>
      <ToggleField
        bind:checked={values.phorestAutoSync}
        label="Automatischen Abgleich aktivieren"
        help="Schichten werden automatisch aus Phorest übernommen. Der Zeitplan gilt ab dem Speichern."
        disabled={saving}
        testid="admin-phorest-autosync"
      />
      {#if values.phorestAutoSync}
        <FormField label="Zeitplan">
          {#snippet field({ id, describedBy })}
            <select
              {id}
              class="form-input pc-narrow"
              aria-describedby={describedBy}
              bind:value={values.phorestSyncCron}
              disabled={saving}
            >
              {#each SYNC_CRON_OPTIONS as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>
      {/if}
    {/if}
  </SettingsGroup>

  {#if status.configured}
    <section class="settings-group" aria-labelledby="phorest-zuordnung-title">
      <h2 class="settings-group-title" id="phorest-zuordnung-title">Mitarbeiter-Zuordnung</h2>
      <p class="settings-group-desc">
        Verbinde die Phorest-Mitarbeitenden mit den Personen in Clokr. Die Schichten einer Person
        ohne Zuordnung werden übersprungen.
      </p>

      {#if unmappedCount > 0}
        <div role="alert">
          <Note tone="warn">
            {unmappedCount} Phorest-Mitarbeitende ohne Zuordnung. Deren Schichten werden übersprungen,
            bis du sie einer Person in Clokr zuordnest.
          </Note>
        </div>
      {/if}

      {#if mapLoading && mapRows.length === 0}
        <Skeleton shape="row" count={3} />
      {:else if mapRows.length === 0}
        <EmptyState
          icon="users"
          title="Keine Phorest-Mitarbeitenden gefunden"
          description="Prüf die Branch-ID und die Zugangsdaten."
        />
      {:else}
        <DataTable
          columns={mapColumns}
          rows={pagedRows}
          rowKey={(row) => row.phorestStaffId}
          caption="Phorest-Mitarbeitende mit ihrer Zuordnung zu Clokr"
        >
          {#snippet cell(row, column)}
            {#if column.key === "email"}
              {row.email ?? "—"}
            {:else if column.key === "phorestStaffId"}
              <code class="pc-code">{row.phorestStaffId}</code>
            {:else if column.key === "employee"}
              <select
                class="form-input pc-select"
                aria-label={`Clokr-Mitarbeiter für ${row.name}`}
                value={row.selectedEmployeeId}
                onchange={(event) => (row.selectedEmployeeId = event.currentTarget.value)}
              >
                <option value="">Mitarbeiter auswählen …</option>
                {#each phEmployees as employee (employee.id)}
                  <option value={employee.id}>{employee.firstName} {employee.lastName}</option>
                {/each}
              </select>
            {:else if column.key === "status"}
              {@const mapState = mappingStatus(row)}
              {#if mapState === "saved"}
                <Chip tone="ok">Zugeordnet</Chip>
              {:else if mapState === "suggested"}
                <Chip tone="info">Vorschlag</Chip>
              {:else}
                <Chip tone="neutral">Nicht zugeordnet</Chip>
              {/if}
            {:else if column.key === "actions"}
              <div class="pc-actions">
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  onclick={() => saveRow(row)}
                  disabled={row.saving ||
                    !row.selectedEmployeeId ||
                    row.selectedEmployeeId === row.savedEmployeeId}
                >
                  {#if row.saving}<Spinner size={14} label="Wird gespeichert" />{/if}
                  Zuordnung speichern
                </button>
                {#if row.savedEmployeeId}
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm btn-danger"
                    onclick={() => askRemove(row)}
                  >
                    Aufheben
                  </button>
                {/if}
              </div>
            {:else}
              {row.name}
            {/if}
          {/snippet}
        </DataTable>
        <Pagination
          total={mapRows.length}
          bind:page={mapPage}
          bind:pageSize={mapPageSize}
          labelSingular="Person"
          labelPlural="Personen"
        />
      {/if}
    </section>
  {/if}
{/if}

<!-- ── Confirmation: remove a mapping ──────────────────────────────────────── -->
<ConfirmDialog
  bind:open={removeConfirm.open}
  title="Zuordnung aufheben?"
  description={`Die Verbindung zwischen dem Phorest-Mitarbeiter und ${removeConfirm.name} wird getrennt. Künftige Schichten dieses Mitarbeiters werden dann nicht mehr importiert.`}
  confirmLabel="Aufheben"
  danger
  onConfirm={confirmRemove}
/>

<style>
  .pc-test {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-3);
  }

  .pc-test-hint,
  .pc-note {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .pc-subhead {
    margin: var(--s-3) 0 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }

  .pc-pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-4);
  }

  .pc-narrow {
    max-width: 20rem;
  }

  .pc-select {
    min-width: 12rem;
  }

  .pc-code {
    font-family: var(--font-code);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .pc-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--s-2);
  }

  @media (max-width: 640px) {
    .pc-pair {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
