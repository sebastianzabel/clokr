<script lang="ts">
  import { onMount } from "svelte";
  import Pagination from "$lib/components/ui/Pagination.svelte";
  import {
    listSources,
    createSource,
    revokeSource,
    listDevices,
    mapDevice,
    listOptedInEmployees,
    type PresenceSource,
    type FritzDevice,
    type OptedInEmployee,
  } from "$lib/api/presence";
  import { api } from "$api/client";

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

  // ── Block 2: FritzBox-Geräteliste ────────────────────────────────────────
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
  let deviceAssignSelect = $state<Record<string, string>>({}); // mac -> selected employeeId
  let devPage = $state(1);
  let devPageSize = $state(10);
  let pagedDevices = $derived(devices.slice((devPage - 1) * devPageSize, devPage * devPageSize));

  // ── Block 3: Opt-in-Übersicht ─────────────────────────────────────────────
  let optedIn: OptedInEmployee[] = $state([]);
  let optInLoading = $state(true);
  let optPage = $state(1);
  let optPageSize = $state(10);
  let pagedOptedIn = $derived(optedIn.slice((optPage - 1) * optPageSize, optPage * optPageSize));

  onMount(async () => {
    await Promise.all([loadSources(), loadOptedIn()]);
    // Load employees list for device assignment dropdown
    try {
      const res = await api.get<{ employees: Employee[] }>("/employees?pageSize=500");
      employees = res.employees ?? [];
    } catch {
      /* non-fatal — assignment dropdown will be empty */
    }
    sourcesLoading = false;
    optInLoading = false;
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

  async function handleRevokeSource(id: string) {
    if (
      !confirm("Presence-Quelle widerrufen? Aktive Adapter können sich dann nicht mehr einloggen.")
    )
      return;
    try {
      await revokeSource(id);
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
      // Initialise per-device select state from current assignment
      const sel: Record<string, string> = {};
      for (const d of devices) {
        sel[d.mac] = d.assignedEmployeeId ?? "";
      }
      deviceAssignSelect = sel;
      devPage = 1;
    } catch {
      devicesError =
        "Geräteliste konnte nicht geladen werden. Bitte prüfen Sie, ob der Adapter erreichbar ist.";
    } finally {
      devicesLoading = false;
    }
  }

  async function saveAssignment(mac: string) {
    const employeeId = deviceAssignSelect[mac];
    if (!employeeId || !selectedSourceId) return;
    deviceAssigning = { ...deviceAssigning, [mac]: true };
    try {
      await mapDevice(selectedSourceId, mac, employeeId);
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
    } catch {
      /* ignore */
    } finally {
      deviceAssigning = { ...deviceAssigning, [mac]: false };
    }
  }

  function clearAssignment(mac: string) {
    devices = devices.map((d) =>
      d.mac === mac ? { ...d, assignedEmployeeId: null, assignedEmployeeName: null } : d,
    );
    deviceAssignSelect = { ...deviceAssignSelect, [mac]: "" };
  }

  function formatLastSeen(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("de-DE");
  }
</script>

<svelte:head><title>WiFi-Presence – Clokr</title></svelte:head>

<div class="page-header card-animate">
  <h1 class="page-title">WiFi-Presence</h1>
  <p class="text-muted">FritzBox-Geräte verwalten und Mitarbeiter zuweisen</p>
</div>

<!-- ── Block 1: Presence-Quellen ──────────────────────────────────────────── -->
<div class="section-label card-animate">
  <h2 class="section-header">Presence-Quellen</h2>
  <p class="text-muted">
    API-Schlüssel für WiFi-Presence-Adapter verwalten. Jede Quelle benötigt einen eigenen Schlüssel.
  </p>
</div>

<div class="card card-body settings-card card-animate">
  {#if showNewKey}
    <div class="alert alert-success" role="status" aria-live="polite" style="margin: 1rem 0;">
      <div>
        <strong>Neuer Schlüssel erstellt!</strong>
        <p style="margin: 0.5rem 0;">
          Kopieren Sie den Schlüssel jetzt — er wird nicht erneut angezeigt:
        </p>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <code
            style="flex: 1; padding: 0.5rem; background: var(--color-bg-subtle); border-radius: var(--radius-sm); word-break: break-all; font-size: 0.8125rem;"
            >{newRawKey}</code
          >
          <button class="btn btn-sm btn-ghost" onclick={() => copyToClipboard(newRawKey)}
            >Schlüssel kopieren</button
          >
        </div>
        <button
          class="btn btn-sm btn-ghost"
          style="margin-top: 0.5rem;"
          onclick={() => {
            showNewKey = false;
            newRawKey = "";
          }}>Schließen</button
        >
      </div>
    </div>
  {/if}

  <div style="display: flex; gap: 0.5rem; margin: 1rem 0; flex-wrap: wrap;">
    <input
      type="text"
      class="form-input"
      bind:value={newSourceName}
      placeholder="Quellen-Name (z.B. FritzBox Büro)"
      style="flex: 1; min-width: 200px;"
    />
    <input
      type="url"
      class="form-input"
      bind:value={newSourceAdapterUrl}
      placeholder="Adapter-URL (optional)"
      style="flex: 1; min-width: 180px;"
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
    <div
      class="skeleton skeleton-text"
      style="height: 48px; border-radius: var(--radius-md);"
    ></div>
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
              <td><code style="font-size: 0.8125rem;">{src.keyPrefix}</code></td>
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
                    class="btn btn-sm btn-ghost"
                    style="color: var(--color-red);"
                    onclick={() => handleRevokeSource(src.id)}
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
    <p class="text-muted">
      Noch keine Presence-Quellen. Erstellen Sie einen Schlüssel für Ihren ersten Adapter.
    </p>
  {/if}
</div>

<!-- ── Block 2: FritzBox-Geräteliste ─────────────────────────────────────── -->
<div class="section-label card-animate">
  <h2 class="section-header">FritzBox-Geräteliste</h2>
  <p class="text-muted">
    Aktuell mit dem Netzwerk verbundene Geräte. MAC-Adressen können Mitarbeitern zugewiesen werden.
  </p>
</div>

<div class="card card-body settings-card card-animate">
  <div
    style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;"
  >
    <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
      {#if sources.filter((s) => !s.revokedAt).length > 1}
        <select class="form-input" bind:value={selectedSourceId} style="width: auto;">
          {#each sources.filter((s) => !s.revokedAt) as src (src.id)}
            <option value={src.id}>{src.name}</option>
          {/each}
        </select>
      {/if}
      <span class="text-muted" style="font-size: 0.8125rem;">
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
    <div
      class="skeleton skeleton-text"
      style="height: 120px; border-radius: var(--radius-md);"
    ></div>
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
              <td
                ><code style="font-size: 0.8125rem; font-family: var(--font-mono);">{dev.mac}</code
                ></td
              >
              <td>{dev.hostname || "—"}</td>
              <td style="font-size: 0.875rem;">{formatLastSeen(dev.lastSeen)}</td>
              <td>
                <span style="display: inline-flex; align-items: center; gap: 0.375rem;">
                  <span class="status-dot" class:status-dot--online={dev.online} aria-hidden="true"
                  ></span>
                  {dev.online ? "Online" : "Offline"}
                </span>
              </td>
              <td>
                {#if dev.assignedEmployeeId}
                  <span style="font-size: 0.875rem;"
                    >{dev.assignedEmployeeName ?? dev.assignedEmployeeId}</span
                  >
                {:else}
                  <select
                    class="form-input"
                    bind:value={deviceAssignSelect[dev.mac]}
                    disabled={deviceAssigning[dev.mac]}
                    style="font-size: 0.875rem; padding: 0.25rem 0.5rem; min-width: 160px;"
                  >
                    <option value="">Mitarbeiter zuweisen…</option>
                    {#each employees as emp (emp.id)}
                      <option value={emp.id}>{emp.firstName} {emp.lastName}</option>
                    {/each}
                  </select>
                {/if}
              </td>
              <td>
                {#if !dev.assignedEmployeeId && deviceAssignSelect[dev.mac]}
                  <button
                    class="btn btn-sm btn-ghost"
                    onclick={() => saveAssignment(dev.mac)}
                    disabled={deviceAssigning[dev.mac]}
                  >
                    Zuweisung speichern
                  </button>
                {:else if dev.assignedEmployeeId}
                  <button class="btn btn-sm btn-ghost" onclick={() => clearAssignment(dev.mac)}>
                    Bearbeiten
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
    <p class="text-muted">
      Keine Geräte gefunden. Stellen Sie sicher, dass der FritzBox-Adapter läuft und verbunden ist.
    </p>
  {:else}
    <p class="text-muted">
      Klicken Sie auf "Liste aktualisieren", um die verbundenen Geräte zu laden.
    </p>
  {/if}
</div>

<!-- ── Block 3: Opt-in-Übersicht ──────────────────────────────────────────── -->
<div class="section-label card-animate">
  <h2 class="section-header">Opt-in-Übersicht</h2>
  <p class="text-muted">Welche Mitarbeiter haben WiFi-Präsenzerkennung aktiviert.</p>
</div>

<div class="card card-body settings-card card-animate">
  {#if optInLoading}
    <div
      class="skeleton skeleton-text"
      style="height: 48px; border-radius: var(--radius-md);"
    ></div>
  {:else if optedIn.length > 0}
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Mitarbeiter</th>
            <th>Opt-in</th>
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
              <td style="font-size: 0.875rem;">
                {#if emp.wifiMacs.length === 0}
                  <span class="text-muted">—</span>
                {:else if emp.wifiMacs.length <= 2}
                  {#each emp.wifiMacs as mac (mac)}
                    <code
                      style="font-size: 0.8125rem; margin-right: 0.25rem; font-family: var(--font-mono);"
                      >{mac}</code
                    >
                  {/each}
                {:else}
                  <span class="badge badge-blue">{emp.wifiMacs.length} Geräte</span>
                {/if}
              </td>
              <td style="font-size: 0.875rem;">
                {emp.wifiOptInAt ? new Date(emp.wifiOptInAt).toLocaleDateString("de-DE") : "—"}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <Pagination total={optedIn.length} bind:page={optPage} bind:pageSize={optPageSize} />
    </div>
  {:else}
    <p class="text-muted">Kein Mitarbeiter hat WiFi-Präsenzerkennung aktiviert.</p>
  {/if}
</div>

<style>
  .page-header {
    margin-bottom: 2rem;
  }

  .page-title {
    font-size: 1.375rem;
    font-weight: 700;
    color: var(--color-text-heading);
    margin: 0 0 0.25rem;
  }

  .section-label {
    margin: 2rem 0 0.75rem;
  }

  .settings-card {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    backdrop-filter: blur(var(--glass-blur));
  }

  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-text-muted);
    flex-shrink: 0;
  }

  .status-dot--online {
    background: var(--color-green);
  }

  :global(.row-revoked) {
    opacity: 0.5;
  }
</style>
