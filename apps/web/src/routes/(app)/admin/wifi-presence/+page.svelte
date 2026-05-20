<script lang="ts">
  import { onMount } from "svelte";
  import Pagination from "$lib/components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
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
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";

  // ── Block 1: Presence-Quellen ─────────────────────────────────────────────
  let sources: PresenceSource[] = $state([]);
  let sourcesLoading = $state(true);
  let newSourceName = $state("");
  let newSourceAdapterUrl = $state("");
  let sourceCreating = $state(false);
  let sourceCreateError = $state("");
  let newRawKey = $state("");
  let showNewKey = $state(false);
  let srcPage = $state(1);
  let srcPageSize = $state(10);
  let pagedSources = $derived(sources.slice((srcPage - 1) * srcPageSize, srcPage * srcPageSize));

  // ── Block 2: WiFi-Geräteliste ────────────────────────────────────────────
  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
  }
  let employees: Employee[] = $state([]);
  let selectedSourceId = $state("");
  let devices: FritzDevice[] = $state([]);
  let devicesLoading = $state(false);
  let devicesError = $state("");
  let devicesLastRefreshed = $state<Date | null>(null);
  let deviceAssigning = $state<Record<string, boolean>>({}); // mac -> saving
  let devPage = $state(1);
  let devPageSize = $state(10);
  let pagedDevices = $derived(devices.slice((devPage - 1) * devPageSize, devPage * devPageSize));

  // Device-Assign Modal state
  let assignModalOpen = $state(false);
  let assignModalDevice: FritzDevice | null = $state(null);
  let assignModalEmployeeId = $state("");

  // Bestätigungs-Dialoge
  let revokeConfirm = $state<{ open: boolean; id: string | null }>({ open: false, id: null });
  let unassignConfirm = $state<{ open: boolean; mac: string | null; name: string }>({
    open: false,
    mac: null,
    name: "",
  });

  // ── Block 3: Opt-in-Übersicht ─────────────────────────────────────────────
  let optedIn: OptedInEmployee[] = $state([]);
  let optInLoading = $state(true);
  let optPage = $state(1);
  let optPageSize = $state(10);
  let pagedOptedIn = $derived(optedIn.slice((optPage - 1) * optPageSize, optPage * optPageSize));

  onMount(async () => {
    await Promise.all([loadSources(), loadOptedIn()]);
    // Load employees list for device assignment dropdown.
    // GET /employees returns the array directly (not wrapped in { employees }).
    try {
      const res = await api.get<Employee[] | { employees: Employee[] }>("/employees");
      employees = Array.isArray(res) ? res : (res.employees ?? []);
    } catch {
      /* non-fatal — assignment dropdown will be empty */
    }
    sourcesLoading = false;
    optInLoading = false;
    // Auto-load device list when a source is available — saves the manual refresh click
    if (selectedSourceId) {
      refreshDevices();
    }
  });

  async function loadSources() {
    try {
      sources = await listSources();
      if (sources.length > 0 && !selectedSourceId) {
        selectedSourceId = sources[0].id;
      }
    } catch {
      /* ignore — empty state shown */
    }
  }

  async function loadOptedIn() {
    try {
      optedIn = await listOptedInEmployees();
    } catch {
      /* ignore — empty state shown */
    }
  }

  async function handleCreateSource() {
    if (!newSourceName.trim()) return;
    sourceCreating = true;
    sourceCreateError = "";
    try {
      const res = await createSource(newSourceName.trim(), newSourceAdapterUrl.trim() || undefined);
      newRawKey = res.rawKey;
      showNewKey = true;
      newSourceName = "";
      newSourceAdapterUrl = "";
      await loadSources();
    } catch {
      sourceCreateError = "Schlüssel konnte nicht erstellt werden. Bitte versuchen Sie es erneut.";
    } finally {
      sourceCreating = false;
    }
  }

  function askRevokeSource(id: string) {
    revokeConfirm = { open: true, id };
  }

  async function confirmRevokeSource() {
    if (!revokeConfirm.id) return;
    try {
      await revokeSource(revokeConfirm.id);
      await loadSources();
    } catch {
      /* ignore */
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

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
        "Geräteliste konnte nicht geladen werden. Bitte prüfen Sie, ob der Adapter erreichbar ist.";
    } finally {
      devicesLoading = false;
    }
  }

  function openAssignModal(dev: FritzDevice) {
    assignModalDevice = dev;
    assignModalEmployeeId = dev.assignedEmployeeId ?? "";
    assignModalOpen = true;
  }

  function closeAssignModal() {
    assignModalOpen = false;
    assignModalDevice = null;
    assignModalEmployeeId = "";
  }

  async function saveAssignment() {
    if (!assignModalDevice || !assignModalEmployeeId || !selectedSourceId) return;
    const mac = assignModalDevice.mac;
    const employeeId = assignModalEmployeeId;
    deviceAssigning = { ...deviceAssigning, [mac]: true };
    try {
      const result = await mapDevice(selectedSourceId, mac, employeeId);
      const matched = employees.find((e) => e.id === employeeId);
      const name = matched ? `${matched.firstName} ${matched.lastName}` : employeeId;
      // Update local device record
      devices = devices.map((d) =>
        d.mac === mac
          ? {
              ...d,
              assignedEmployeeId: employeeId,
              assignedEmployeeName: name,
            }
          : d,
      );
      if (result.optInAutoEnabled) {
        toasts.success(`${name} zugewiesen — WiFi-Opt-In automatisch aktiviert`);
        // Refresh opt-in overview so Block 3 reflects the new opt-in
        loadOptedIn();
      } else {
        toasts.success(`${name} zugewiesen`);
      }
      closeAssignModal();
    } catch {
      toasts.error("Zuweisung fehlgeschlagen");
    } finally {
      deviceAssigning = { ...deviceAssigning, [mac]: false };
    }
  }

  function askUnassignDevice(mac: string) {
    const dev = devices.find((d) => d.mac === mac);
    const name = dev?.assignedEmployeeName ?? "Mitarbeiter";
    unassignConfirm = { open: true, mac, name };
  }

  async function unassignDevice() {
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
        toasts.success(`Zuweisung aufgehoben — WiFi-Opt-In für ${name} deaktiviert`);
        loadOptedIn();
      } else {
        toasts.success("Zuweisung aufgehoben");
      }
    } catch {
      toasts.error("Zuweisung konnte nicht aufgehoben werden");
    } finally {
      deviceAssigning = { ...deviceAssigning, [mac]: false };
    }
  }

  function formatLastSeen(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("de-DE");
  }
</script>

<svelte:head><title>WiFi-Präsenz – Clokr</title></svelte:head>

<section class="page">
  <PageHead
    eyebrow="Administration"
    title="WiFi-Präsenz"
    accent="Präsenz"
    sub="WiFi-Quellen verwalten, Geräte Mitarbeitern zuweisen und Opt-Ins überblicken."
  />

  <!-- ── Block 1: Presence-Quellen ──────────────────────────────────────── -->
  <Card animate>
    <CardHeader title="Presence-Quellen" sub="API-Schlüssel für WiFi-Adapter verwalten" />

    {#if showNewKey}
      <div class="alert alert-success new-key-alert" role="status" aria-live="polite">
        <div>
          <strong>Neuer Schlüssel erstellt!</strong>
          <p class="key-hint">Kopieren Sie den Schlüssel jetzt — er wird nicht erneut angezeigt:</p>
          <div class="key-row">
            <code class="key-value">{newRawKey}</code>
            <button class="btn btn-sm btn-ghost" onclick={() => copyToClipboard(newRawKey)}
              >Schlüssel kopieren</button
            >
          </div>
          <button
            class="btn btn-sm btn-ghost close-key-btn"
            onclick={() => {
              showNewKey = false;
              newRawKey = "";
            }}>Schließen</button
          >
        </div>
      </div>
    {/if}

    <div class="source-create-row">
      <input
        type="text"
        class="form-input source-name-input"
        bind:value={newSourceName}
        placeholder="Quellen-Name (z.B. FritzBox Büro)"
      />
      <input
        type="url"
        class="form-input source-url-input"
        bind:value={newSourceAdapterUrl}
        placeholder="Adapter-URL (optional)"
      />
      <button
        class="btn btn-primary"
        onclick={handleCreateSource}
        disabled={sourceCreating || !newSourceName.trim()}
      >
        Schlüssel erstellen
      </button>
    </div>

    {#if sourceCreateError}
      <p class="form-error" role="alert">{sourceCreateError}</p>
    {/if}

    {#if sourcesLoading}
      <div class="skeleton skeleton-text source-skel"></div>
    {:else if sources.length > 0}
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Schlüssel-Prefix</th>
              <th>Zuletzt verwendet</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each pagedSources as src (src.id)}
              <tr class:row-revoked={src.revokedAt}>
                <td>{src.name}</td>
                <td><code class="mono-sm">{src.keyPrefix}</code></td>
                <td>{src.lastUsedAt ? new Date(src.lastUsedAt).toLocaleString("de-DE") : "Nie"}</td>
                <td>
                  {#if src.revokedAt}
                    <span class="badge badge-red">Widerrufen</span>
                  {:else}
                    <span class="badge badge-green">Aktiv</span>
                  {/if}
                </td>
                <td>
                  {#if !src.revokedAt}
                    <button
                      class="btn btn-sm btn-ghost btn-danger-text"
                      onclick={() => askRevokeSource(src.id)}
                    >
                      Quelle widerrufen
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <Pagination total={sources.length} bind:page={srcPage} bind:pageSize={srcPageSize} />
      </div>
    {:else}
      <p class="text-muted empty-msg">
        Noch keine Presence-Quellen. Erstellen Sie einen Schlüssel für Ihren ersten Adapter.
      </p>
    {/if}
  </Card>

  <!-- ── Block 2: WiFi-Geräteliste ────────────────────────────────────── -->
  <Card animate>
    <CardHeader title="WiFi-Geräteliste" sub="Verbundene Geräte und ihre Zuweisungen" />

    <div class="devices-toolbar">
      <div class="devices-toolbar-left">
        {#if sources.filter((s) => !s.revokedAt).length > 1}
          <select class="form-input source-select" bind:value={selectedSourceId}>
            {#each sources.filter((s) => !s.revokedAt) as src (src.id)}
              <option value={src.id}>{src.name}</option>
            {/each}
          </select>
        {/if}
        <span class="text-muted refresh-hint">
          {devicesLastRefreshed
            ? `Zuletzt aktualisiert: ${devicesLastRefreshed.toLocaleTimeString("de-DE")}`
            : "Noch nicht geladen"}
        </span>
      </div>
      <button
        class="btn btn-outline btn-sm"
        onclick={refreshDevices}
        disabled={devicesLoading || !selectedSourceId}
      >
        {devicesLoading ? "Aktualisieren…" : "Liste aktualisieren"}
      </button>
    </div>

    {#if devicesError}
      <div class="alert alert-error" role="alert">
        <span aria-hidden="true">⚠</span>
        <span>{devicesError}</span>
      </div>
    {:else if devicesLoading}
      <div class="skeleton skeleton-text devices-skel"></div>
    {:else if devices.length > 0}
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>MAC-Adresse</th>
              <th>Hostname</th>
              <th>Zuletzt gesehen</th>
              <th>Status</th>
              <th>Mitarbeiter</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each pagedDevices as dev (dev.mac)}
              <tr>
                <td><code class="mono-sm">{dev.mac}</code></td>
                <td>{dev.hostname || "—"}</td>
                <td class="cell-sm">{formatLastSeen(dev.lastSeen)}</td>
                <td>
                  <span class="status-cell">
                    <span
                      class="status-dot"
                      class:status-dot--online={dev.online}
                      aria-hidden="true"
                    ></span>
                    {dev.online ? "Online" : "Offline"}
                  </span>
                </td>
                <td>
                  {#if dev.assignedEmployeeId}
                    <span class="cell-sm">{dev.assignedEmployeeName ?? dev.assignedEmployeeId}</span
                    >
                  {:else}
                    <span class="text-muted cell-sm">Nicht zugewiesen</span>
                  {/if}
                </td>
                <td>
                  {#if dev.assignedEmployeeId}
                    <button
                      class="btn btn-sm btn-ghost btn-danger-text"
                      onclick={() => askUnassignDevice(dev.mac)}
                      disabled={deviceAssigning[dev.mac]}
                    >
                      Aufheben
                    </button>
                  {:else}
                    <button
                      class="btn btn-sm btn-outline"
                      onclick={() => openAssignModal(dev)}
                      disabled={deviceAssigning[dev.mac]}
                    >
                      Zuweisen
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <Pagination total={devices.length} bind:page={devPage} bind:pageSize={devPageSize} />
      </div>
    {:else if devicesLastRefreshed}
      <p class="text-muted empty-msg">
        Keine Geräte gefunden. Stellen Sie sicher, dass der WiFi-Adapter (z.B. FritzBox) läuft und
        verbunden ist.
      </p>
    {:else}
      <p class="text-muted empty-msg">
        Klicken Sie auf "Liste aktualisieren", um die verbundenen Geräte zu laden.
      </p>
    {/if}
  </Card>

  <!-- ── Block 3: Opt-in-Übersicht ─────────────────────────────────────── -->
  <Card animate>
    <CardHeader
      title="Opt-In-Übersicht"
      sub="Welche Mitarbeiter haben WiFi-Präsenzerkennung aktiviert"
    />

    {#if optInLoading}
      <div class="skeleton skeleton-text optin-skel"></div>
    {:else if optedIn.length > 0}
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Opt-In</th>
              <th>MAC-Adressen</th>
              <th>Aktiviert am</th>
            </tr>
          </thead>
          <tbody>
            {#each pagedOptedIn as emp (emp.id)}
              <tr>
                <td>{emp.firstName} {emp.lastName}</td>
                <td>
                  {#if emp.wifiPresenceEnabled}
                    <span class="badge badge-green">Aktiv</span>
                  {:else}
                    <span class="badge badge-gray">Inaktiv</span>
                  {/if}
                </td>
                <td class="cell-sm">
                  {#if emp.wifiMacs.length === 0}
                    <span class="text-muted">—</span>
                  {:else if emp.wifiMacs.length <= 2}
                    {#each emp.wifiMacs as mac (mac)}
                      <code class="mono-sm mac-chip">{mac}</code>
                    {/each}
                  {:else}
                    <span class="badge badge-blue">{emp.wifiMacs.length} Geräte</span>
                  {/if}
                </td>
                <td class="cell-sm">
                  {emp.wifiOptInAt ? new Date(emp.wifiOptInAt).toLocaleDateString("de-DE") : "—"}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <Pagination total={optedIn.length} bind:page={optPage} bind:pageSize={optPageSize} />
      </div>
    {:else}
      <p class="text-muted empty-msg">Kein Mitarbeiter hat WiFi-Präsenzerkennung aktiviert.</p>
    {/if}
  </Card>
</section>

<!-- ── Bestätigungs-Dialoge ──────────────────────────────────────────────── -->
<ConfirmDialog
  bind:open={revokeConfirm.open}
  title="Presence-Quelle widerrufen?"
  description="Aktive Adapter können sich dann nicht mehr einloggen."
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
  onConfirm={unassignDevice}
/>

<!-- ── Device-Assign Modal ────────────────────────────────────────────────── -->
{#if assignModalDevice}
  <Modal
    bind:open={assignModalOpen}
    eyebrow="Gerät zuweisen"
    title={assignModalDevice.hostname || assignModalDevice.mac}
  >
    <div class="device-meta">
      <div class="meta-row">
        <span class="meta-label">MAC-Adresse</span>
        <code class="mono-sm">{assignModalDevice.mac}</code>
      </div>
      <div class="meta-row">
        <span class="meta-label">Status</span>
        <span class="status-cell">
          <span
            class="status-dot"
            class:status-dot--online={assignModalDevice.online}
            aria-hidden="true"
          ></span>
          {assignModalDevice.online ? "Online" : "Offline"}
        </span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Zuletzt gesehen</span>
        <span class="cell-sm">{formatLastSeen(assignModalDevice.lastSeen)}</span>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="assign-emp">Mitarbeiter</label>
      <select id="assign-emp" class="form-input" bind:value={assignModalEmployeeId}>
        <option value="">Mitarbeiter auswählen…</option>
        {#each employees as emp (emp.id)}
          <option value={emp.id}>{emp.firstName} {emp.lastName}</option>
        {/each}
      </select>
      <p class="text-muted form-hint">
        Bei der ersten Zuweisung wird WiFi-Präsenzerkennung für den Mitarbeiter automatisch
        aktiviert.
      </p>
    </div>
    {#snippet footer()}
      <button
        class="btn btn-ghost"
        onclick={closeAssignModal}
        disabled={deviceAssigning[assignModalDevice!.mac]}>Abbrechen</button
      >
      <button
        class="btn btn-primary"
        onclick={saveAssignment}
        disabled={!assignModalEmployeeId || deviceAssigning[assignModalDevice!.mac]}
      >
        {deviceAssigning[assignModalDevice!.mac] ? "Speichern…" : "Zuweisung speichern"}
      </button>
    {/snippet}
  </Modal>
{/if}

<style>
  /* .page wrapper is global (app.css) — no per-page padding/max-width. */

  /* ── Block 1: Presence-Quellen ───────────────────────────────────── */
  .new-key-alert {
    margin-bottom: var(--s-4);
  }
  .key-hint {
    margin: 0.5rem 0;
  }
  .key-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .key-value {
    flex: 1;
    padding: 0.5rem;
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    word-break: break-all;
    font-size: 0.8125rem;
    font-family: var(--font-mono);
  }
  .close-key-btn {
    margin-top: 0.5rem;
  }

  .source-create-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: var(--s-4);
    flex-wrap: wrap;
  }
  .source-name-input {
    flex: 1;
    min-width: 200px;
  }
  .source-url-input {
    flex: 1;
    min-width: 180px;
  }

  .source-skel,
  .devices-skel,
  .optin-skel {
    height: 48px;
    border-radius: var(--r-md);
  }
  .devices-skel {
    height: 120px;
  }

  .empty-msg {
    margin: 0;
  }

  .mono-sm {
    font-size: 0.8125rem;
    font-family: var(--font-mono);
  }

  .cell-sm {
    font-size: 0.875rem;
  }

  .btn-danger-text {
    color: var(--bad);
  }

  /* ── Tables ──────────────────────────────────────────────────────── */
  .table-wrap {
    overflow-x: auto;
  }
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .data-table th {
    text-align: left;
    padding: 0.625rem 0.75rem;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    border-bottom: 2px solid var(--border);
  }
  .data-table td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  /* ── Block 2: Devices ─────────────────────────────────────────── */
  .devices-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--s-4);
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .devices-toolbar-left {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .source-select {
    width: auto;
  }
  .refresh-hint {
    font-size: 0.8125rem;
  }

  .status-cell {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }
  .status-dot--online {
    background: var(--good);
  }

  /* ── Block 3: Opt-in ──────────────────────────────────────────── */
  .mac-chip {
    margin-right: 0.25rem;
  }

  :global(.row-revoked) {
    opacity: 0.5;
  }

  /* ── Assign-modal body styles ──────────────────────────────────── */
  .device-meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    background: var(--bg-subtle);
    border-radius: var(--r-md);
  }
  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    font-size: 0.875rem;
  }
  .meta-label {
    color: var(--text-muted);
    font-weight: 500;
  }

  .form-hint {
    font-size: 0.8125rem;
    margin: 6px 0 0;
    line-height: 1.5;
  }

  .text-muted {
    color: var(--text-muted);
  }

  /* ── Alert ───────────────────────────────────────────────────── */
  .alert {
    padding: 0.75rem 1rem;
    border-radius: var(--r-sm);
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }
  .alert-success {
    background: var(--bg-subtle);
    color: var(--good);
    border: 1px solid var(--good);
  }
  .alert-error {
    background: var(--bg-subtle);
    color: var(--bad);
    border: 1px solid var(--bad);
  }
</style>
