<!--
  PresenceSourcesPanel - the „WLAN-Anwesenheit“ tab of Verwalten › System › Integrationen (Issue #854, rebuilt on
  the blocks of #843; the data, the endpoints and the rules are those of the pre-#854 page /admin/integrations,
  Issues #388 and #610). A management section without configuration keys of its own (registry section
  `integrationen-wlan`). Four groups: the presence sources, the pairing guide, the device list and the opt-in
  overview.

  Loads the sources and the opt-in overview itself, the first time the tab is shown, then the device list of the
  first source. Writes are `POST` and `DELETE /admin/presence-sources` (create with the key shown ONCE in
  OneTimeKey, revoke behind a confirmation) and the device assignment (`mapDevice` in a Dialog, `unmapDevice`
  behind a confirmation); each acts at once and answers with a toast. Where the tenant has not booked the add-on
  module the calm hint replaces the „Quelle anlegen“ action (Issue #566, display only; the server answers 409
  either way) - sources already there stay listed and revocable.

  The pairing guide (Issue #610) is browser state only: this panel adds no request for it.

  Presentation only: `presence-source:manage` is checked by the API; a 403 shows a calm note, not an error.

  Props:
    active - true while the tab is the selected one
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api, ApiError } from "$api/client";
  import {
    listSources,
    createSource,
    revokeSource,
    listDevices,
    mapDevice,
    unmapDevice,
    listOptedInEmployees,
    type PresenceSource,
    type FritzDevice,
    type OptedInEmployee,
  } from "$lib/api/presence";
  import { toasts } from "$stores/toast";
  import { salonContext, moduleBooked } from "$stores/salon-context";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
  import OneTimeKey from "$lib/components/admin/integrationen/OneTimeKey.svelte";
  import PairingGuide from "$lib/components/admin/PairingGuide.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  interface Props {
    active: boolean;
  }

  let { active }: Props = $props();

  // Phase 566 (D-12): display only. `=== false` only: an unknown state never hides the create action.
  const hardwareBooked = $derived(moduleBooked($salonContext, "HARDWARE_CLOCK"));

  let forbidden = $state(false);

  // ── Group 1: presence sources ─────────────────────────────────────────────
  let sources: PresenceSource[] = $state([]);
  let sourcesLoading = $state(false);
  let sourcesError = $state("");
  // Shown once after the creation, then forgotten (T-854-34).
  let newRawKey = $state("");
  let srcPage = $state(1);
  let srcPageSize = $state(10);
  const pagedSources = $derived(sources.slice((srcPage - 1) * srcPageSize, srcPage * srcPageSize));

  const sourceColumns: DataTableColumn[] = [
    { key: "name", label: "Name", primary: true },
    { key: "keyPrefix", label: "Schlüssel-Präfix" },
    { key: "lastUsedAt", label: "Zuletzt verwendet" },
    { key: "status", label: "Status" },
    { key: "actions", label: "Aktionen", align: "end" },
  ];

  async function loadSources() {
    sourcesLoading = true;
    sourcesError = "";
    try {
      sources = await listSources();
      if (
        !selectedSourceId ||
        !sources.some((src) => src.id === selectedSourceId && !src.revokedAt)
      ) {
        selectedSourceId = sources.find((src) => !src.revokedAt)?.id ?? "";
      }
      forbidden = false;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else {
        sourcesError = "Die Präsenz-Quellen konnten nicht geladen werden.";
      }
    } finally {
      sourcesLoading = false;
    }
  }

  // Create dialog
  let createOpen = $state(false);
  let newSourceName = $state("");
  let newSourceAdapterUrl = $state("");
  let sourceCreating = $state(false);
  let sourceCreateError = $state("");

  function openCreateSource() {
    newSourceName = "";
    newSourceAdapterUrl = "";
    sourceCreateError = "";
    createOpen = true;
  }

  // Runs inside the Dialog's form: a refusal keeps the dialog open with its text.
  async function handleCreateSource() {
    if (!newSourceName.trim()) {
      sourceCreateError = "Gib der Quelle einen Namen.";
      return;
    }
    sourceCreating = true;
    sourceCreateError = "";
    try {
      const res = await createSource(newSourceName.trim(), newSourceAdapterUrl.trim() || undefined);
      newRawKey = res.rawKey;
      createOpen = false;
      await loadSources();
    } catch (err: unknown) {
      // A 409 carries the server's German sentence (module not booked); anything else keeps the
      // generic retry hint.
      sourceCreateError =
        err instanceof ApiError && err.status === 409
          ? err.message
          : "Schlüssel konnte nicht erstellt werden. Bitte versuch es noch einmal.";
    } finally {
      sourceCreating = false;
    }
  }

  let revokeConfirm: { open: boolean; source: PresenceSource | null } = $state({
    open: false,
    source: null,
  });

  function askRevokeSource(source: PresenceSource) {
    revokeConfirm = { open: true, source };
  }

  async function confirmRevokeSource() {
    const source = revokeConfirm.source;
    if (!source) return;
    try {
      await revokeSource(source.id);
    } catch (err) {
      toasts.error(
        err instanceof ApiError ? err.message : "Quelle konnte nicht widerrufen werden.",
      );
      throw err;
    }
    toasts.success("Präsenz-Quelle widerrufen.");
    await loadSources();
  }

  // ── Group 3: device list ──────────────────────────────────────────────────
  type Employee = { id: string; firstName: string; lastName: string };
  let employees: Employee[] = $state([]);
  let selectedSourceId = $state("");
  let devices: FritzDevice[] = $state([]);
  let devicesLoading = $state(false);
  let devicesError = $state("");
  let devicesLastRefreshed = $state<Date | null>(null);
  let deviceAssigning = $state<Record<string, boolean>>({}); // mac -> saving
  let devPage = $state(1);
  let devPageSize = $state(10);
  const pagedDevices = $derived(devices.slice((devPage - 1) * devPageSize, devPage * devPageSize));
  const activeSources = $derived(sources.filter((src) => !src.revokedAt));

  const deviceColumns: DataTableColumn[] = [
    { key: "mac", label: "MAC-Adresse", primary: true },
    { key: "hostname", label: "Hostname" },
    { key: "lastSeen", label: "Zuletzt gesehen" },
    { key: "status", label: "Status" },
    { key: "employee", label: "Mitarbeiter" },
    { key: "actions", label: "Aktionen", align: "end" },
  ];

  async function refreshDevices() {
    if (!selectedSourceId) return;
    devicesLoading = true;
    devicesError = "";
    try {
      devices = await listDevices(selectedSourceId);
      devicesLastRefreshed = new Date();
      devPage = 1;
    } catch {
      devicesError =
        "Geräteliste konnte nicht geladen werden. Bitte prüf, ob der Adapter erreichbar ist.";
    } finally {
      devicesLoading = false;
    }
  }

  function fullName(person: { firstName: string; lastName: string }): string {
    return `${person.firstName} ${person.lastName}`;
  }

  function formatLastSeen(iso: string | null): string {
    if (!iso) return "–";
    return new Date(iso).toLocaleString("de-DE");
  }

  // Assign dialog
  let assignOpen = $state(false);
  let assignDevice: FritzDevice | null = $state(null);
  let assignEmployeeId = $state("");

  function openAssign(device: FritzDevice) {
    assignDevice = device;
    assignEmployeeId = device.assignedEmployeeId ?? "";
    assignOpen = true;
  }

  async function saveAssignment() {
    if (!assignDevice || !assignEmployeeId || !selectedSourceId) return;
    const mac = assignDevice.mac;
    const employeeId = assignEmployeeId;
    deviceAssigning = { ...deviceAssigning, [mac]: true };
    try {
      const result = await mapDevice(selectedSourceId, mac, employeeId);
      const matched = employees.find((e) => e.id === employeeId);
      const name = matched ? `${matched.firstName} ${matched.lastName}` : employeeId;
      devices = devices.map((d) =>
        d.mac === mac ? { ...d, assignedEmployeeId: employeeId, assignedEmployeeName: name } : d,
      );
      if (result.optInAutoEnabled) {
        toasts.success(`${name} zugewiesen. WLAN-Präsenz ist automatisch eingeschaltet.`);
        // The opt-in overview reflects the new opt-in.
        void loadOptedIn();
      } else {
        toasts.success(`${name} zugewiesen.`);
      }
      assignOpen = false;
    } catch {
      toasts.error("Zuweisung fehlgeschlagen.");
    } finally {
      deviceAssigning = { ...deviceAssigning, [mac]: false };
    }
  }

  let unassignConfirm: { open: boolean; mac: string | null; name: string } = $state({
    open: false,
    mac: null,
    name: "",
  });

  function askUnassign(device: FritzDevice) {
    unassignConfirm = {
      open: true,
      mac: device.mac,
      name: device.assignedEmployeeName ?? "Mitarbeiter",
    };
  }

  async function confirmUnassign() {
    const mac = unassignConfirm.mac;
    if (!selectedSourceId || !mac) return;
    const name = unassignConfirm.name;
    deviceAssigning = { ...deviceAssigning, [mac]: true };
    try {
      const result = await unmapDevice(selectedSourceId, mac);
      devices = devices.map((d) =>
        d.mac === mac ? { ...d, assignedEmployeeId: null, assignedEmployeeName: null } : d,
      );
      if (result.optInAutoDisabled) {
        toasts.success(`Zuweisung aufgehoben. WLAN-Präsenz für ${name} ist ausgeschaltet.`);
        void loadOptedIn();
      } else {
        toasts.success("Zuweisung aufgehoben.");
      }
    } catch (err) {
      toasts.error("Zuweisung konnte nicht aufgehoben werden.");
      throw err;
    } finally {
      deviceAssigning = { ...deviceAssigning, [mac]: false };
    }
  }

  // ── Group 4: opt-in overview ──────────────────────────────────────────────
  let optedIn: OptedInEmployee[] = $state([]);
  let optInLoading = $state(false);
  let optInError = $state("");
  let optPage = $state(1);
  let optPageSize = $state(10);
  const pagedOptedIn = $derived(optedIn.slice((optPage - 1) * optPageSize, optPage * optPageSize));

  const optInColumns: DataTableColumn[] = [
    { key: "name", label: "Mitarbeiter", primary: true },
    { key: "optIn", label: "Opt-in" },
    { key: "macs", label: "MAC-Adressen" },
    { key: "since", label: "Aktiviert am" },
  ];

  async function loadOptedIn() {
    optInLoading = true;
    optInError = "";
    try {
      optedIn = await listOptedInEmployees();
    } catch (err) {
      // A 403 is already shown by the sources group; anything else gets its own retry.
      if (!(err instanceof ApiError && err.status === 403)) {
        optInError = "Die Opt-in-Übersicht konnte nicht geladen werden.";
      }
    } finally {
      optInLoading = false;
    }
  }

  // Lazy load on the first visit of the tab: a person who never opens it costs no request.
  let started = false;
  $effect(() => {
    if (!active || started) return;
    started = true;
    untrack(() => void start());
  });

  async function start() {
    await Promise.all([loadSources(), loadOptedIn()]);
    // GET /employees returns the array directly (not wrapped in { employees }); it feeds the assignment
    // dropdown only, so a refusal is not an error of the page.
    try {
      const res = await api.get<Employee[] | { employees: Employee[] }>("/employees");
      employees = Array.isArray(res) ? res : (res.employees ?? []);
    } catch {
      /* non-fatal - the dropdown stays empty */
    }
    // Load the device list when a source is available - saves the manual refresh click.
    if (selectedSourceId) await refreshDevices();
  }
</script>

<!-- ── Group 1: Präsenz-Quellen ──────────────────────────────────────────── -->
<section class="settings-group" aria-labelledby="integrationen-quellen-title">
  <h2 class="settings-group-title" id="integrationen-quellen-title">Präsenz-Quellen</h2>
  <p class="settings-group-desc">
    Jeder WLAN-Adapter meldet sich mit einem eigenen Schlüssel an. Die Schlüssel verwaltest du hier.
  </p>

  {#if newRawKey}
    <OneTimeKey
      title="Neuer Schlüssel erstellt"
      rawKey={newRawKey}
      onclose={() => (newRawKey = "")}
    />
  {/if}

  {#if hardwareBooked === false}
    <ModuleHint module="HARDWARE_CLOCK" subject="WLAN-Anwesenheitsquellen" />
  {:else}
    <div class="ip-actions">
      <button type="button" class="btn btn-primary" onclick={openCreateSource}
        >Quelle anlegen</button
      >
    </div>
  {/if}

  {#if forbidden}
    <div role="alert">
      <Note tone="bad">Für die WLAN-Anwesenheit fehlt dir die Berechtigung.</Note>
    </div>
  {:else if sourcesError}
    <ErrorState message={sourcesError} onRetry={loadSources} retrying={sourcesLoading} />
  {:else if sourcesLoading && sources.length === 0}
    <Skeleton shape="card" count={1} lines={3} />
  {:else if sources.length === 0}
    <EmptyState
      icon="wifi"
      title="Noch keine Präsenz-Quellen"
      description="Leg einen Schlüssel für deinen ersten Adapter an."
    />
  {:else}
    <DataTable
      columns={sourceColumns}
      rows={pagedSources}
      rowKey={(row) => row.id}
      caption="Präsenz-Quellen mit Schlüssel und Status"
    >
      {#snippet cell(row, column)}
        {#if column.key === "keyPrefix"}
          <code class="ip-code">{row.keyPrefix}</code>
        {:else if column.key === "lastUsedAt"}
          {row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString("de-DE") : "Nie"}
        {:else if column.key === "status"}
          {#if row.revokedAt}
            <Chip tone="bad">Widerrufen</Chip>
          {:else}
            <Chip tone="ok">Aktiv</Chip>
          {/if}
        {:else if column.key === "actions"}
          {#if !row.revokedAt}
            <button
              type="button"
              class="btn btn-secondary btn-sm btn-danger"
              onclick={() => askRevokeSource(row)}
            >
              Quelle widerrufen
            </button>
          {/if}
        {:else}
          {row.name}
        {/if}
      {/snippet}
    </DataTable>
    <Pagination total={sources.length} bind:page={srcPage} bind:pageSize={srcPageSize} />
  {/if}
</section>

<!-- ── Group 2: Handys per QR-Code koppeln (Issue #610) ──────────────────── -->
<section class="settings-group" aria-labelledby="integrationen-koppeln-title">
  <h2 class="settings-group-title" id="integrationen-koppeln-title">Handys per QR-Code koppeln</h2>
  <p class="settings-group-desc">QR-Code für das Salon-WLAN erstellen und aushängen.</p>
  <PairingGuide />
</section>

<!-- ── Group 3: WLAN-Geräteliste ─────────────────────────────────────────── -->
<section class="settings-group" aria-labelledby="integrationen-geraete-title">
  <h2 class="settings-group-title" id="integrationen-geraete-title">WLAN-Geräteliste</h2>
  <p class="settings-group-desc">Verbundene Geräte und ihre Zuweisungen.</p>

  <div class="ip-device-head">
    {#if activeSources.length > 1}
      <FormField label="Quelle">
        {#snippet field({ id, describedBy })}
          <select
            {id}
            class="form-input ip-source"
            aria-describedby={describedBy}
            bind:value={selectedSourceId}
          >
            {#each activeSources as src (src.id)}
              <option value={src.id}>{src.name}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
    {/if}
    <span class="ip-refreshed">
      {devicesLastRefreshed
        ? `Zuletzt aktualisiert: ${devicesLastRefreshed.toLocaleTimeString("de-DE")}`
        : "Noch nicht geladen"}
    </span>
    <button
      type="button"
      class="btn btn-secondary"
      onclick={refreshDevices}
      disabled={devicesLoading || !selectedSourceId}
    >
      {devicesLoading ? "Aktualisieren …" : "Liste aktualisieren"}
    </button>
  </div>

  {#if devicesError}
    <ErrorState message={devicesError} onRetry={refreshDevices} retrying={devicesLoading} />
  {:else if devicesLoading && devices.length === 0}
    <Skeleton shape="card" count={1} lines={3} />
  {:else if devices.length > 0}
    <DataTable
      columns={deviceColumns}
      rows={pagedDevices}
      rowKey={(row) => row.mac}
      caption="WLAN-Geräte mit Status und zugewiesenem Mitarbeiter"
    >
      {#snippet cell(row, column)}
        {#if column.key === "mac"}
          <code class="ip-code">{row.mac}</code>
        {:else if column.key === "hostname"}
          {row.hostname || "–"}
        {:else if column.key === "lastSeen"}
          {formatLastSeen(row.lastSeen)}
        {:else if column.key === "status"}
          {#if row.online}
            <Chip tone="ok">Online</Chip>
          {:else}
            <Chip tone="neutral">Offline</Chip>
          {/if}
        {:else if column.key === "employee"}
          {#if row.assignedEmployeeId}
            {row.assignedEmployeeName ?? row.assignedEmployeeId}
          {:else}
            <span class="ip-muted">Nicht zugewiesen</span>
          {/if}
        {:else if row.assignedEmployeeId}
          <button
            type="button"
            class="btn btn-secondary btn-sm btn-danger"
            onclick={() => askUnassign(row)}
            disabled={deviceAssigning[row.mac]}
          >
            Aufheben
          </button>
        {:else}
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            onclick={() => openAssign(row)}
            disabled={deviceAssigning[row.mac]}
          >
            Zuweisen
          </button>
        {/if}
      {/snippet}
    </DataTable>
    <Pagination total={devices.length} bind:page={devPage} bind:pageSize={devPageSize} />
  {:else if devicesLastRefreshed}
    <EmptyState
      icon="wifi"
      title="Keine Geräte gefunden"
      description="Stell sicher, dass der WLAN-Adapter (z. B. FRITZ!Box) läuft und verbunden ist."
    />
  {:else}
    <p class="ip-muted">Klick auf „Liste aktualisieren“, um die verbundenen Geräte zu laden.</p>
  {/if}
</section>

<!-- ── Group 4: Opt-in-Übersicht ─────────────────────────────────────────── -->
<section class="settings-group" aria-labelledby="integrationen-optin-title">
  <h2 class="settings-group-title" id="integrationen-optin-title">Opt-in-Übersicht</h2>
  <p class="settings-group-desc">Welche Mitarbeiter die WLAN-Präsenzerkennung aktiviert haben.</p>

  {#if optInError}
    <ErrorState message={optInError} onRetry={loadOptedIn} retrying={optInLoading} />
  {:else if optInLoading && optedIn.length === 0}
    <Skeleton shape="card" count={1} lines={3} />
  {:else if optedIn.length === 0}
    <EmptyState
      icon="inbox"
      title="Noch kein Opt-in"
      description="Kein Mitarbeiter hat die WLAN-Präsenzerkennung aktiviert."
    />
  {:else}
    <DataTable
      columns={optInColumns}
      rows={pagedOptedIn}
      rowKey={(row) => row.id}
      caption="Mitarbeiter mit WLAN-Präsenzerkennung"
    >
      {#snippet cell(row, column)}
        {#if column.key === "optIn"}
          {#if row.wifiPresenceEnabled}
            <Chip tone="ok">Aktiv</Chip>
          {:else}
            <Chip tone="neutral">Inaktiv</Chip>
          {/if}
        {:else if column.key === "macs"}
          {#if row.wifiMacs.length === 0}
            –
          {:else if row.wifiMacs.length <= 2}
            {#each row.wifiMacs as mac (mac)}
              <code class="ip-code ip-mac">{mac}</code>
            {/each}
          {:else}
            <Chip tone="info">{row.wifiMacs.length} Geräte</Chip>
          {/if}
        {:else if column.key === "since"}
          {row.wifiOptInAt ? new Date(row.wifiOptInAt).toLocaleDateString("de-DE") : "–"}
        {:else}
          {fullName(row)}
        {/if}
      {/snippet}
    </DataTable>
    <Pagination total={optedIn.length} bind:page={optPage} bind:pageSize={optPageSize} />
  {/if}
</section>

<!-- ── Dialog: create a presence source ───────────────────────────────────── -->
<Dialog bind:open={createOpen} title="Quelle anlegen">
  <form
    id="presence-source-form"
    novalidate
    class="ip-form"
    onsubmit={(event) => {
      event.preventDefault();
      void handleCreateSource();
    }}
  >
    <FormField label="Name" required help="Zum Beispiel „FritzBox Büro“.">
      {#snippet field({ id, describedBy })}
        <input
          {id}
          class="form-input"
          type="text"
          aria-describedby={describedBy}
          bind:value={newSourceName}
        />
      {/snippet}
    </FormField>
    <FormField label="Adapter-Adresse (optional)">
      {#snippet field({ id, describedBy })}
        <input
          {id}
          class="form-input"
          type="url"
          aria-describedby={describedBy}
          bind:value={newSourceAdapterUrl}
        />
      {/snippet}
    </FormField>
    {#if sourceCreateError}
      <div role="alert"><Note tone="bad">{sourceCreateError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (createOpen = false)}>
      Abbrechen
    </button>
    <button
      type="submit"
      form="presence-source-form"
      class="btn btn-primary"
      disabled={sourceCreating}
    >
      {sourceCreating ? "Anlegen …" : "Schlüssel erstellen"}
    </button>
  {/snippet}
</Dialog>

<!-- ── Dialog: assign a device to an employee ─────────────────────────────── -->
{#if assignDevice}
  <Dialog
    bind:open={assignOpen}
    eyebrow="Gerät zuweisen"
    title={assignDevice.hostname || assignDevice.mac}
  >
    <dl class="ip-meta">
      <div>
        <dt>MAC-Adresse</dt>
        <dd><code class="ip-code">{assignDevice.mac}</code></dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>{assignDevice.online ? "Online" : "Offline"}</dd>
      </div>
      <div>
        <dt>Zuletzt gesehen</dt>
        <dd>{formatLastSeen(assignDevice.lastSeen)}</dd>
      </div>
    </dl>
    <FormField
      label="Mitarbeiter"
      help="Bei der ersten Zuweisung wird die WLAN-Präsenzerkennung für den Mitarbeiter automatisch aktiviert."
    >
      {#snippet field({ id, describedBy })}
        <select
          {id}
          class="form-input"
          aria-describedby={describedBy}
          bind:value={assignEmployeeId}
        >
          <option value="">Mitarbeiter auswählen …</option>
          {#each employees as emp (emp.id)}
            <option value={emp.id}>{emp.firstName} {emp.lastName}</option>
          {/each}
        </select>
      {/snippet}
    </FormField>
    {#snippet footer()}
      <button
        type="button"
        class="btn btn-secondary"
        onclick={() => (assignOpen = false)}
        disabled={deviceAssigning[assignDevice!.mac]}>Abbrechen</button
      >
      <button
        type="button"
        class="btn btn-primary"
        onclick={saveAssignment}
        disabled={!assignEmployeeId || deviceAssigning[assignDevice!.mac]}
      >
        {deviceAssigning[assignDevice!.mac] ? "Speichern …" : "Zuweisung speichern"}
      </button>
    {/snippet}
  </Dialog>
{/if}

<!-- ── Confirmations ──────────────────────────────────────────────────────── -->
<ConfirmDialog
  bind:open={revokeConfirm.open}
  title="Präsenz-Quelle widerrufen?"
  description="Aktive Adapter können sich dann nicht mehr anmelden."
  confirmLabel="Widerrufen"
  danger
  onConfirm={confirmRevokeSource}
/>

<ConfirmDialog
  bind:open={unassignConfirm.open}
  title="Zuweisung aufheben?"
  description={`Die MAC-Adresse wird von ${unassignConfirm.name} getrennt.`}
  confirmLabel="Aufheben"
  danger
  onConfirm={confirmUnassign}
/>

<style>
  .ip-actions {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--s-3);
  }

  .ip-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .ip-device-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--s-3);
    margin-bottom: var(--s-3);
  }

  .ip-source {
    width: auto;
    min-width: 12rem;
  }

  .ip-refreshed,
  .ip-muted {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .ip-muted {
    margin: 0;
  }

  .ip-code {
    font-family: var(--font-code);
    font-size: var(--fs-sm);
  }

  .ip-mac {
    margin-right: var(--s-1);
  }

  .ip-meta {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    margin: 0 0 var(--s-4);
    padding: var(--s-3);
    border-radius: var(--r-control);
    background: var(--sunk);
    font-size: var(--fs-sm);
  }

  .ip-meta div {
    display: flex;
    justify-content: space-between;
    gap: var(--s-3);
  }

  .ip-meta dt {
    color: var(--text-2);
    font-weight: 500;
  }

  .ip-meta dd {
    margin: 0;
    color: var(--text);
  }
</style>
