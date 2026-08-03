<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import { toasts } from "$stores/toast";

  // Phase 85.1-03 — extracted from admin/system/+page.svelte (D-10: eigener Admin-Tab).
  // Phorest
  let phBusinessId = $state("");
  let phBranchId = $state("");
  let phUsername = $state("");
  let phPassword = $state("");
  let phConfigured = $state(false);
  let phSaving = $state(false);
  let phSaved = $state(false);
  let phError = $state("");
  let phTesting = $state(false);
  let phTestResult = $state("");
  let phTestOk = $state<boolean | null>(null); // null = noch kein Ergebnis; Block B alert-Ton
  let phAutoSync = $state(false);
  let phSyncCron = $state("0 3 * * *");
  let phSyncStart = $state("");
  let phSyncEnd = $state("");
  let phSyncing = $state(false);
  let phSyncWindowDays = $state(7); // SS-05 Zeitfenster (Tage) — auto + manuell
  let phSyncError = $state(""); // Block C: Sync-Fehler/SUSPECT-Alert
  // Phase 85.1-03 (D-01) — Vor-/Nachbereitungszeit puffer (tenant-global, 0-30 Min.)
  let phPrepMinutes = $state(0);
  let phWrapupMinutes = $state(0);

  // ── Block A: Staff-Zuordnung (mapping table) ──────────────────────────────
  interface PhEmployee {
    id: string;
    firstName: string;
    lastName: string;
  }
  interface PhStaffItem {
    phorestStaffId: string;
    name: string;
    email: string | null;
    savedEmployeeId: string | null;
    suggestedEmployeeId: string | null;
  }
  interface PhMappingRow {
    phorestStaffId: string;
    name: string;
    email: string | null;
    selectedEmployeeId: string; // "" = keine Auswahl
    savedEmployeeId: string | null; // persistierte Zuordnung (autoritativ)
    savingRow: boolean;
  }
  let phEmployees: PhEmployee[] = $state([]);
  let phMappingRows: PhMappingRow[] = $state([]);
  let phMappingLoading = $state(false);
  let phMapPage = $state(1);
  let phMapPageSize = $state(10);
  let phRemoveConfirm = $state<{ open: boolean; phorestStaffId: string; name: string }>({
    open: false,
    phorestStaffId: "",
    name: "",
  });
  let phUnmappedCount = $derived(phMappingRows.filter((r) => !r.savedEmployeeId).length);
  let phPagedRows = $derived(
    phMappingRows.slice((phMapPage - 1) * phMapPageSize, phMapPage * phMapPageSize),
  );

  // ── Block C: Sync-Observability ───────────────────────────────────────────
  interface PhSyncRun {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    status: string; // RUNNING | SUCCESS | ERROR | SUSPECT
    created: number;
    updated: number;
    cancelled: number;
    unmapped: number;
    error: string | null;
    // Phase 85.1-03 (D-08) — BS-übersprungene + Phorest-Master-ersetzte Schichten
    skippedVocationalSchool: number;
    replaced: number;
  }
  let phLatestRun: PhSyncRun | null = $state(null);
  let phRunHistory: PhSyncRun[] = $state([]);
  let phRunsTotal = $state(0);
  let phRunsLoading = $state(false);
  let phHistoryOpen = $state(false);
  let phHistPage = $state(1);
  let phHistPageSize = $state(10);

  function phRunBadgeClass(status: string): string {
    if (status === "SUCCESS") return "badge-green";
    if (status === "RUNNING") return "badge-gray";
    if (status === "SUSPECT") return "badge-yellow"; // verdächtig (warn-getönt)
    return "badge-red"; // ERROR + jeder unbekannte Status → Fehler-getönt
  }
  function phRunBadgeLabel(status: string): string {
    if (status === "SUCCESS") return "Erfolg";
    if (status === "RUNNING") return "Läuft…";
    if (status === "SUSPECT") return "Verdächtig";
    return "Fehler";
  }

  onMount(async () => {
    try {
      const ph = await api.get<{
        configured: boolean;
        phorestBusinessId: string | null;
        phorestBranchId: string | null;
        phorestUsername: string | null;
        phorestBaseUrl: string | null;
        phorestAutoSync: boolean;
        phorestSyncCron: string | null;
        phorestSyncWindowDays: number | null;
        phorestPrepMinutes: number | null;
        phorestWrapupMinutes: number | null;
      }>("/integrations/phorest/config");
      phConfigured = ph.configured;
      phBusinessId = ph.phorestBusinessId ?? "";
      phBranchId = ph.phorestBranchId ?? "";
      phUsername = ph.phorestUsername ?? "";
      phAutoSync = ph.phorestAutoSync ?? false;
      phSyncCron = ph.phorestSyncCron ?? "0 3 * * *";
      phSyncWindowDays = ph.phorestSyncWindowDays ?? 7;
      phPrepMinutes = ph.phorestPrepMinutes ?? 0;
      phWrapupMinutes = ph.phorestWrapupMinutes ?? 0;
      // Von/Bis bleiben leer: das Zeitfenster (Tage) ist der Default für den
      // manuellen Sync, eine explizite Range ist nur ein optionaler Override.
      // SS-01/SS-05: wenn konfiguriert, Mapping-Tabelle + Observability laden
      if (phConfigured) {
        void loadPhEmployees();
        void loadPhMapping();
        void loadPhSyncRuns();
      }
    } catch {
      /* ignorieren */
    }
  });

  async function savePhorest() {
    phSaving = true;
    phError = "";
    phSaved = false;
    try {
      await api.put("/integrations/phorest/config", {
        phorestBusinessId: phBusinessId,
        phorestBranchId: phBranchId,
        phorestUsername: phUsername,
        phorestPassword: phPassword,
        phorestAutoSync: phAutoSync,
        phorestSyncCron: phSyncCron,
        phorestSyncWindowDays: phSyncWindowDays,
        phorestPrepMinutes: phPrepMinutes,
        phorestWrapupMinutes: phWrapupMinutes,
      });
      phConfigured = true;
      phSaved = true;
      setTimeout(() => (phSaved = false), 3000);
    } catch (e: unknown) {
      phError = e instanceof Error ? e.message : "Fehler";
    } finally {
      phSaving = false;
    }
  }

  async function testPhorest() {
    phTesting = true;
    phTestResult = "";
    phTestOk = null;
    try {
      const res = await api.post<{
        ok: boolean;
        reason?: string;
        message?: string;
        staffCount?: number;
        branchName?: string;
      }>("/integrations/phorest/test", {});
      // Block B: distinct alert-Ton; API liefert für auth-invalid vs unreachable
      // bereits die passende deutsche Meldung (SS-02).
      phTestOk = res.ok;
      if (res.ok) {
        const branch = res.branchName ? `Branch „${res.branchName}", ` : "";
        phTestResult = `Verbindung erfolgreich — ${branch}${res.staffCount ?? "?"} Mitarbeiter gefunden.`;
      } else {
        phTestResult = res.message ?? "Verbindung fehlgeschlagen.";
      }
    } catch (e: unknown) {
      phTestOk = false;
      phTestResult = e instanceof Error ? e.message : "Fehler";
    } finally {
      phTesting = false;
    }
  }

  // ── Block A: Staff-Zuordnung ──────────────────────────────────────────────
  async function loadPhEmployees() {
    try {
      const res = await api.get<PhEmployee[] | { employees: PhEmployee[] }>("/employees?limit=500");
      phEmployees = Array.isArray(res) ? res : (res.employees ?? []);
    } catch {
      /* nicht fatal — Dropdown bleibt leer */
    }
  }

  async function loadPhMapping() {
    phMappingLoading = true;
    try {
      const res = await api.get<{ staff?: PhStaffItem[]; error?: string }>(
        "/integrations/phorest/staff",
      );
      const staff = res.staff ?? [];
      phMappingRows = staff.map((s) => ({
        phorestStaffId: s.phorestStaffId,
        name: s.name,
        email: s.email,
        savedEmployeeId: s.savedEmployeeId ?? null,
        selectedEmployeeId: s.savedEmployeeId ?? s.suggestedEmployeeId ?? "",
        savingRow: false,
      }));
    } catch {
      phMappingRows = [];
    } finally {
      phMappingLoading = false;
    }
  }

  function phRowStatus(row: PhMappingRow): "saved" | "suggested" | "none" {
    if (row.selectedEmployeeId && row.selectedEmployeeId === row.savedEmployeeId) return "saved";
    if (row.selectedEmployeeId) return "suggested";
    return "none";
  }

  async function savePhMapping(row: PhMappingRow) {
    if (!row.selectedEmployeeId) return;
    row.savingRow = true;
    try {
      await api.post("/integrations/phorest/mappings", {
        phorestStaffId: row.phorestStaffId,
        employeeId: row.selectedEmployeeId,
      });
      row.savedEmployeeId = row.selectedEmployeeId;
      toasts.success("Zuordnung gespeichert.");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Zuordnung fehlgeschlagen.");
    } finally {
      row.savingRow = false;
    }
  }

  function askRemovePhMapping(row: PhMappingRow) {
    const emp = phEmployees.find((e) => e.id === row.savedEmployeeId);
    phRemoveConfirm = {
      open: true,
      phorestStaffId: row.phorestStaffId,
      name: emp ? `${emp.firstName} ${emp.lastName}` : row.name,
    };
  }

  async function confirmRemovePhMapping() {
    const staffId = phRemoveConfirm.phorestStaffId;
    try {
      await api.delete(`/integrations/phorest/mappings/${staffId}`);
      const row = phMappingRows.find((r) => r.phorestStaffId === staffId);
      if (row) row.savedEmployeeId = null;
      toasts.success("Zuordnung aufgehoben.");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Aufheben fehlgeschlagen.");
    }
  }

  // ── Block C: Sync-Observability ───────────────────────────────────────────
  async function loadPhSyncRuns() {
    phRunsLoading = true;
    try {
      const res = await api.get<{
        latest: PhSyncRun | null;
        history: PhSyncRun[];
        total: number;
      }>(`/integrations/phorest/sync-runs?limit=${phHistPageSize}&page=${phHistPage - 1}`);
      phLatestRun = res.latest;
      phRunHistory = res.history ?? [];
      phRunsTotal = res.total ?? 0;
    } catch {
      /* nicht fatal */
    } finally {
      phRunsLoading = false;
    }
  }

  async function syncPhorest() {
    phSyncing = true;
    phSyncError = "";
    phError = "";
    // Optimistisch: letzten Lauf auf „Läuft…" setzen, bis der Refresh kommt.
    if (phLatestRun) phLatestRun = { ...phLatestRun, status: "RUNNING" };
    // Zeitfenster (Tage) ist der Default; eine explizite Von/Bis-Range ist ein
    // optionaler Override. Ohne Range: heute … heute + phSyncWindowDays.
    let startDate = phSyncStart;
    let endDate = phSyncEnd;
    if (!phSyncStart || !phSyncEnd) {
      const today = new Date();
      const end = new Date(today);
      end.setDate(end.getDate() + phSyncWindowDays);
      startDate = today.toISOString().split("T")[0];
      endDate = end.toISOString().split("T")[0];
    }
    try {
      const res = await api.post<{
        runId: string;
        status: "SUCCESS" | "ERROR" | "SUSPECT";
        created: number;
        updated: number;
        cancelled: number;
        unmapped: number;
        error?: string;
      }>("/integrations/phorest/sync-shifts", {
        startDate,
        endDate,
      });
      if (res.status === "SUCCESS") {
        toasts.success(
          `${res.created} Schichten importiert · ${res.cancelled} abgesagt · ${res.unmapped} ohne Zuordnung`,
        );
      } else {
        // ERROR oder SUSPECT (Guardrail): Fehler-Alert mit Grund rendern.
        phSyncError = `Synchronisation fehlgeschlagen: ${res.error ?? "Unbekannter Fehler"}. Es wurden keine Schichten abgesagt. Bitte erneut versuchen.`;
        toasts.error("Synchronisation nicht erfolgreich.");
      }
      await loadPhSyncRuns();
      await loadPhMapping();
    } catch (e: unknown) {
      phSyncError = e instanceof Error ? e.message : "Sync fehlgeschlagen";
      await loadPhSyncRuns();
    } finally {
      phSyncing = false;
    }
  }
</script>

<svelte:head><title>Phorest – Clokr</title></svelte:head>

<SectionStack
  eyebrow="System"
  title="Phorest"
  sub="Schichten aus Salon-Software importieren"
  animate
>
  <!-- ── Phorest-Integration ──────────────────────────────────────────── -->
  <Section title="Phorest-Integration" sub="Schichten aus Salon-Software importieren">
    {#if phError}
      <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
        <span>⚠</span><span>{phError}</span>
      </div>
    {/if}
    {#if phSaved}
      <div class="alert alert-success" role="alert" style="margin-bottom: 1rem;">
        <span>✓</span><span>Phorest-Konfiguration gespeichert.</span>
      </div>
    {/if}

    <div class="form-grid">
      <div class="form-group">
        <label class="form-label" for="ph-biz">Business ID</label>
        <input
          id="ph-biz"
          type="text"
          bind:value={phBusinessId}
          class="form-input"
          placeholder="z.B. abc123def456"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="ph-branch">Branch ID</label>
        <input
          id="ph-branch"
          type="text"
          bind:value={phBranchId}
          class="form-input"
          placeholder="z.B. branch-001"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="ph-user">API-Benutzername (E-Mail)</label>
        <input
          id="ph-user"
          type="text"
          bind:value={phUsername}
          class="form-input"
          placeholder="api@salon.de"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="ph-pass">API-Passwort</label>
        <input
          id="ph-pass"
          type="password"
          bind:value={phPassword}
          class="form-input"
          placeholder="••••••••"
        />
      </div>
    </div>

    <!-- Phase 85.1-03 (D-01) — Vor-/Nachbereitungszeit (tenant-global, 0-30 Min.) -->
    <h4 class="sys-subtitle">Vor-/Nachbereitungszeit</h4>
    <p class="text-muted ph-empty-msg">
      Phorest hält die buchbare Zeit fest — die tatsächliche Arbeitszeit beginnt früher und endet
      später. Dieser Puffer wird bei jedem Import auf die gespeicherte Schicht angewendet.
    </p>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label" for="ph-prep-min">Vorbereitungszeit (Min.)</label>
        <input
          id="ph-prep-min"
          type="number"
          min="0"
          max="30"
          bind:value={phPrepMinutes}
          class="form-input"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="ph-wrapup-min">Nachbereitungszeit (Min.)</label>
        <input
          id="ph-wrapup-min"
          type="number"
          min="0"
          max="30"
          bind:value={phWrapupMinutes}
          class="form-input"
        />
      </div>
    </div>

    {#snippet footer()}
      <button class="btn btn-primary" onclick={savePhorest} disabled={phSaving}>
        {phSaving ? "Speichern…" : "Konfiguration speichern"}
      </button>
      <button class="btn btn-outline" onclick={testPhorest} disabled={phTesting || !phConfigured}>
        {phTesting ? "Teste…" : "Verbindung testen"}
      </button>
    {/snippet}

    {#if phTestResult}
      <div
        class="alert {phTestOk ? 'alert-success' : 'alert-error'} ph-test-alert"
        role={phTestOk ? "status" : "alert"}
      >
        <span>{phTestOk ? "✓" : "✕"}</span><span>{phTestResult}</span>
      </div>
    {/if}

    {#if phConfigured}
      <hr class="ph-divider" />

      <!-- ── Block A: Staff-Zuordnung ──────────────────────────────── -->
      <h4 class="sys-subtitle">Staff-Zuordnung</h4>
      {#if phUnmappedCount > 0}
        <div class="alert alert-warning" role="alert" style="margin-bottom: 0.75rem;">
          <span>⚠</span>
          <span>
            {phUnmappedCount} Phorest-Mitarbeiter ohne Zuordnung. Ihre Schichten werden übersprungen,
            bis Sie sie einem clokr-Mitarbeiter zuordnen.
          </span>
        </div>
      {/if}
      {#if phMappingLoading}
        <div class="skeleton skeleton-text ph-skel"></div>
      {:else if phMappingRows.length > 0}
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Phorest-Mitarbeiter</th>
                <th>E-Mail</th>
                <th>Phorest-ID</th>
                <th>clokr-Mitarbeiter</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each phPagedRows as row (row.phorestStaffId)}
                <tr>
                  <td>{row.name}</td>
                  <td>{row.email ?? "—"}</td>
                  <td><code class="mono-sm">{row.phorestStaffId}</code></td>
                  <td>
                    <select class="form-input ph-map-select" bind:value={row.selectedEmployeeId}>
                      <option value="">Mitarbeiter auswählen…</option>
                      {#each phEmployees as emp (emp.id)}
                        <option value={emp.id}>{emp.firstName} {emp.lastName}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    {#if phRowStatus(row) === "saved"}
                      <span class="badge badge-green">Zugeordnet</span>
                    {:else if phRowStatus(row) === "suggested"}
                      <span class="badge badge-blue">Vorschlag</span>
                    {:else}
                      <span class="badge badge-gray">Nicht zugeordnet</span>
                    {/if}
                  </td>
                  <td>
                    <div class="ph-row-actions">
                      <button
                        class="btn btn-sm btn-primary"
                        onclick={() => savePhMapping(row)}
                        disabled={row.savingRow ||
                          !row.selectedEmployeeId ||
                          row.selectedEmployeeId === row.savedEmployeeId}
                      >
                        {row.savingRow ? "Speichern…" : "Zuordnung speichern"}
                      </button>
                      {#if row.savedEmployeeId}
                        <button
                          class="btn btn-sm btn-ghost btn-danger-text"
                          onclick={() => askRemovePhMapping(row)}
                        >
                          Aufheben
                        </button>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <Pagination
            total={phMappingRows.length}
            bind:page={phMapPage}
            bind:pageSize={phMapPageSize}
          />
        </div>
      {:else}
        <p class="text-muted ph-empty-msg">
          Keine Phorest-Mitarbeiter gefunden. Prüfen Sie Branch-ID und Zugangsdaten.
        </p>
      {/if}

      <hr class="ph-divider" />

      <h4 class="sys-subtitle">Automatischer Sync</h4>
      <label class="toggle-label" style="margin-bottom: 1rem;">
        <input type="checkbox" bind:checked={phAutoSync} class="toggle-cb" />
        <span>
          <strong>Auto-Sync aktivieren</strong><br />
          <span class="text-muted ph-sync-hint"
            >Schichten werden automatisch aus Phorest importiert (nächste 7 Tage).</span
          >
        </span>
      </label>

      {#if phAutoSync}
        <div class="form-group ph-cron-group">
          <label class="form-label" for="ph-cron">Zeitplan</label>
          <select id="ph-cron" bind:value={phSyncCron} class="form-input">
            <option value="0 3 * * *">Täglich um 03:00</option>
            <option value="0 */6 * * *">Alle 6 Stunden</option>
            <option value="0 */2 * * *">Alle 2 Stunden</option>
            <option value="0 0 * * 1">Wöchentlich (Montag 00:00)</option>
          </select>
          <p class="form-hint text-muted">
            Zeitplan wird beim Speichern der Konfiguration aktiviert.
          </p>
        </div>
      {/if}

      <!-- ── Block C: Manueller Sync + Observability ───────────────── -->
      <h4 class="sys-subtitle">Manueller Sync</h4>
      <div class="form-group ph-window-group">
        <label class="form-label" for="ph-window">Zeitfenster (Tage)</label>
        <input
          id="ph-window"
          type="number"
          min="1"
          max="90"
          bind:value={phSyncWindowDays}
          class="form-input"
        />
        <p class="form-hint text-muted">
          Gilt für automatischen und manuellen Sync. Standard: 7 Tage. Wird beim Speichern der
          Konfiguration übernommen.
        </p>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label" for="ph-sync-start">Von</label>
          <input id="ph-sync-start" type="date" bind:value={phSyncStart} class="form-input" />
        </div>
        <div class="form-group">
          <label class="form-label" for="ph-sync-end">Bis</label>
          <input id="ph-sync-end" type="date" bind:value={phSyncEnd} class="form-input" />
        </div>
      </div>
      <p class="form-hint text-muted">
        Optional. Ohne Angabe wird das Zeitfenster oben verwendet (heute bis heute +
        {phSyncWindowDays} Tage).
      </p>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick={syncPhorest} disabled={phSyncing}>
          {phSyncing ? "Synchronisiere…" : "Jetzt synchronisieren"}
        </button>
      </div>

      {#if phSyncError}
        <div class="alert alert-error" role="alert" style="margin-top: 0.75rem;">
          <span>✕</span><span>{phSyncError}</span>
        </div>
      {/if}

      <h4 class="sys-subtitle">Letzter Lauf</h4>
      {#if phRunsLoading && !phLatestRun}
        <div class="skeleton skeleton-text ph-skel"></div>
      {:else if phLatestRun}
        <div class="ph-run-panel">
          <div class="ph-run-head">
            <span class="ph-run-time"
              >{new Date(phLatestRun.startedAt).toLocaleString("de-DE")}</span
            >
            <span class="badge {phRunBadgeClass(phLatestRun.status)}"
              >{phRunBadgeLabel(phLatestRun.status)}</span
            >
          </div>
          <div class="ph-sync-result">
            <strong>{phLatestRun.created}</strong> importiert ·
            <strong>{phLatestRun.cancelled}</strong> abgesagt ·
            <strong>{phLatestRun.unmapped}</strong> ohne Zuordnung ·
            <strong>{phLatestRun.skippedVocationalSchool ?? 0}</strong> BS übersprungen ·
            <strong>{phLatestRun.replaced ?? 0}</strong> ersetzt ·
            <strong>{phLatestRun.status === "ERROR" ? 1 : 0}</strong> Fehler
          </div>
          {#if phLatestRun.status === "ERROR" && phLatestRun.error}
            <div class="alert alert-error" role="alert" style="margin-top: 0.5rem;">
              <span>✕</span><span>{phLatestRun.error}</span>
            </div>
          {:else if phLatestRun.status === "SUSPECT" && phLatestRun.error}
            <div class="alert alert-warning" role="alert" style="margin-top: 0.5rem;">
              <span>⚠</span><span>{phLatestRun.error}</span>
            </div>
          {/if}
        </div>
      {:else}
        <p class="text-muted ph-empty-msg">
          Noch kein Sync-Lauf. Starten Sie einen manuellen Sync.
        </p>
      {/if}

      {#if phRunsTotal > 0}
        <button
          class="btn btn-sm btn-ghost ph-history-toggle"
          onclick={() => {
            phHistoryOpen = !phHistoryOpen;
            if (phHistoryOpen) void loadPhSyncRuns();
          }}
        >
          {phHistoryOpen ? "Verlauf ausblenden" : "Verlauf anzeigen"}
        </button>
        {#if phHistoryOpen}
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Zeitpunkt</th>
                  <th>Status</th>
                  <th>Importiert</th>
                  <th>Abgesagt</th>
                  <th>Ohne Zuordnung</th>
                  <th>BS übersprungen</th>
                  <th>Ersetzt</th>
                </tr>
              </thead>
              <tbody>
                {#each phRunHistory as run (run.id)}
                  <tr>
                    <td
                      ><span class="mono-sm">{new Date(run.startedAt).toLocaleString("de-DE")}</span
                      ></td
                    >
                    <td
                      ><span class="badge {phRunBadgeClass(run.status)}"
                        >{phRunBadgeLabel(run.status)}</span
                      ></td
                    >
                    <td>{run.created}</td>
                    <td>{run.cancelled}</td>
                    <td>{run.unmapped}</td>
                    <td>{run.skippedVocationalSchool ?? 0}</td>
                    <td>{run.replaced ?? 0}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <Pagination
              total={phRunsTotal}
              bind:page={phHistPage}
              bind:pageSize={phHistPageSize}
              onChange={() => loadPhSyncRuns()}
            />
          </div>
        {/if}
      {/if}
    {/if}
  </Section>
</SectionStack>

<!-- ── Phorest: Zuordnung aufheben (danger) ──────────────────────────────── -->
<ConfirmDialog
  bind:open={phRemoveConfirm.open}
  title="Zuordnung aufheben?"
  description={`Die Verbindung zwischen dem Phorest-Mitarbeiter und ${phRemoveConfirm.name} wird getrennt. Künftige Schichten dieses Mitarbeiters werden dann nicht mehr importiert.`}
  confirmLabel="Aufheben"
  danger
  onConfirm={confirmRemovePhMapping}
/>

<style>
  /* Duplicated from admin/system/+page.svelte — these utility classes are
     also used by other (still-present) sections there, so they are copied
     rather than moved (Phase 85.1-03 extraction). */
  .sys-subtitle {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 1rem 0 0.5rem;
  }

  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 500;
    margin-top: 0.375rem;
  }

  .toggle-cb {
    width: 16px;
    height: 16px;
    accent-color: var(--brand);
  }

  .table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  /* Same pattern as admin/integrations/+page.svelte's "Aufheben" action. */
  .btn-danger-text {
    color: var(--bad);
  }

  /* Phorest integration extras — moved verbatim from admin/system/+page.svelte. */
  .ph-divider {
    margin: 1.5rem 0;
    border: none;
    border-top: 1px solid var(--border);
  }
  .ph-test-alert {
    margin-top: 0.75rem;
  }
  .ph-sync-hint {
    font-size: 0.8125rem;
  }
  .ph-cron-group {
    max-width: 320px;
    margin-bottom: 1.25rem;
  }
  .ph-window-group {
    max-width: 320px;
    margin-bottom: 1.25rem;
  }
  .ph-sync-result {
    margin-top: 1rem;
    padding: 0.75rem 1rem;
    background: var(--bg-subtle);
    border-radius: var(--r-md);
    font-size: 0.875rem;
    color: var(--text);
  }
  /* Block A/C helpers */
  .mono-sm {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .ph-map-select {
    min-width: 200px;
  }
  .ph-row-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .ph-empty-msg {
    margin: 0.75rem 0;
    font-size: 0.875rem;
  }
  .ph-skel {
    height: 3rem;
    margin: 0.75rem 0;
  }
  .ph-run-panel {
    margin-top: 0.5rem;
  }
  .ph-run-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }
  .ph-run-time {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .ph-history-toggle {
    margin-top: 1rem;
  }

  .settings-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  @media (max-width: 640px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
