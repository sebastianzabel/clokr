<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { theme, themes } from "$stores/theme";

  interface TenantConfig {
    federalState: string;
    timezone: string;
    defaultWeeklyHours: number;
    defaultMondayHours: number;
    defaultTuesdayHours: number;
    defaultWednesdayHours: number;
    defaultThursdayHours: number;
    defaultFridayHours: number;
    defaultSaturdayHours: number;
    defaultSundayHours: number;
    overtimeThreshold: number;
    allowOvertimePayout: boolean;
    defaultVacationDays: number;
    carryOverDeadlineDay: number;
    carryOverDeadlineMonth: number;
  }

  const STATES: { prisma: string; label: string }[] = [
    { prisma: "NIEDERSACHSEN", label: "Niedersachsen" },
    { prisma: "BADEN_WUERTTEMBERG", label: "Baden-Württemberg" },
    { prisma: "BAYERN", label: "Bayern" },
    { prisma: "BERLIN", label: "Berlin" },
    { prisma: "BRANDENBURG", label: "Brandenburg" },
    { prisma: "BREMEN", label: "Bremen" },
    { prisma: "HAMBURG", label: "Hamburg" },
    { prisma: "HESSEN", label: "Hessen" },
    { prisma: "MECKLENBURG_VORPOMMERN", label: "Mecklenburg-Vorpommern" },
    { prisma: "NORDRHEIN_WESTFALEN", label: "Nordrhein-Westfalen" },
    { prisma: "RHEINLAND_PFALZ", label: "Rheinland-Pfalz" },
    { prisma: "SCHLESWIG_HOLSTEIN", label: "Schleswig-Holstein" },
    { prisma: "SAARLAND", label: "Saarland" },
    { prisma: "SACHSEN", label: "Sachsen" },
    { prisma: "SACHSEN_ANHALT", label: "Sachsen-Anhalt" },
    { prisma: "THUERINGEN", label: "Thüringen" },
  ];

  let loading = $state(true);
  let error = $state("");

  // Federal state
  let gFederalState = $state("NIEDERSACHSEN");
  let _gOtherFields: Omit<TenantConfig, "federalState"> | null = null;
  let stateSaving = $state(false);
  let stateSaved = $state(false);
  let stateError = $state("");

  // SMTP
  let smtpHost = $state("");
  let smtpPort = $state(587);
  let smtpUser = $state("");
  let smtpPassword = $state("");
  let smtpFromEmail = $state("");
  let smtpFromName = $state("");
  let smtpSecure = $state(false);
  let smtpPasswordSet = $state(false);
  let smtpSaving = $state(false);
  let smtpSaved = $state(false);
  let smtpError = $state("");
  let smtpTestEmail = $state("");
  let smtpTesting = $state(false);
  let smtpTestResult = $state("");
  let smtpTestError = $state("");

  // Timezone
  let gTimezone = $state("Europe/Berlin");
  const TIMEZONE_OPTIONS = [
    "Europe/Berlin",
    "Europe/Vienna",
    "Europe/Zurich",
    "Europe/Amsterdam",
    "Europe/Brussels",
    "Europe/Luxembourg",
    "Europe/Paris",
    "Europe/London",
    "Europe/Warsaw",
    "Europe/Prague",
    "Europe/Rome",
    "Europe/Madrid",
    "Europe/Stockholm",
    "Europe/Copenhagen",
    "Europe/Helsinki",
    "Europe/Athens",
    "Europe/Istanbul",
    "Europe/Moscow",
    "America/New_York",
    "America/Chicago",
    "America/Los_Angeles",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "UTC",
  ];

  // 2FA
  let twoFaEnabled = $state(false);
  let twoFaSaving = $state(false);
  let twoFaError = $state("");

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
  let phAutoSync = $state(false);
  let phSyncCron = $state("0 3 * * *");
  let phSyncStart = $state("");
  let phSyncEnd = $state("");
  let phSyncing = $state(false);
  let phSyncResult: { created: number; skipped: number; unmapped: number; errors: number } | null =
    $state(null);

  onMount(async () => {
    try {
      const cfg = await api.get<TenantConfig>("/settings/work");
      gFederalState = cfg.federalState ?? "NIEDERSACHSEN";
      gTimezone = cfg.timezone ?? "Europe/Berlin";
      _gOtherFields = {
        defaultWeeklyHours: cfg.defaultWeeklyHours,
        defaultMondayHours: cfg.defaultMondayHours,
        defaultTuesdayHours: cfg.defaultTuesdayHours,
        defaultWednesdayHours: cfg.defaultWednesdayHours,
        defaultThursdayHours: cfg.defaultThursdayHours,
        defaultFridayHours: cfg.defaultFridayHours,
        defaultSaturdayHours: cfg.defaultSaturdayHours,
        defaultSundayHours: cfg.defaultSundayHours,
        overtimeThreshold: cfg.overtimeThreshold,
        allowOvertimePayout: cfg.allowOvertimePayout,
        defaultVacationDays: cfg.defaultVacationDays,
        carryOverDeadlineDay: cfg.carryOverDeadlineDay,
        carryOverDeadlineMonth: cfg.carryOverDeadlineMonth,
      };

      try {
        const smtp = await api.get<{
          smtpHost: string | null;
          smtpPort: number | null;
          smtpUser: string | null;
          smtpPasswordSet: boolean;
          smtpFromEmail: string | null;
          smtpFromName: string | null;
          smtpSecure: boolean;
        }>("/settings/smtp");
        smtpHost = smtp.smtpHost ?? "";
        smtpPort = smtp.smtpPort ?? 587;
        smtpUser = smtp.smtpUser ?? "";
        smtpPasswordSet = smtp.smtpPasswordSet;
        smtpFromEmail = smtp.smtpFromEmail ?? "";
        smtpFromName = smtp.smtpFromName ?? "";
        smtpSecure = smtp.smtpSecure ?? false;
      } catch {
        /* ignorieren */
      }

      try {
        const sec = await api.get<{ twoFaEnabled: boolean }>("/settings/security");
        twoFaEnabled = sec.twoFaEnabled;
      } catch {
        /* ignorieren */
      }

      try {
        const ph = await api.get<{
          configured: boolean;
          phorestBusinessId: string | null;
          phorestBranchId: string | null;
          phorestUsername: string | null;
          phorestBaseUrl: string | null;
          phorestAutoSync: boolean;
          phorestSyncCron: string | null;
        }>("/integrations/phorest/config");
        phConfigured = ph.configured;
        phBusinessId = ph.phorestBusinessId ?? "";
        phBranchId = ph.phorestBranchId ?? "";
        phUsername = ph.phorestUsername ?? "";
        phAutoSync = ph.phorestAutoSync ?? false;
        phSyncCron = ph.phorestSyncCron ?? "0 3 * * *";
        // Set default sync range to current week
        const now = new Date();
        const dow = now.getDay();
        const mon = new Date(now);
        mon.setDate(mon.getDate() - (dow === 0 ? 6 : dow - 1));
        const sun = new Date(mon);
        sun.setDate(sun.getDate() + 6);
        phSyncStart = mon.toISOString().split("T")[0];
        phSyncEnd = sun.toISOString().split("T")[0];
      } catch {
        /* ignorieren */
      }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  });

  async function saveFederalState() {
    if (!_gOtherFields) return;
    stateSaving = true;
    stateError = "";
    stateSaved = false;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
      });
      stateSaved = true;
      setTimeout(() => (stateSaved = false), 3000);
    } catch (e: unknown) {
      stateError = e instanceof Error ? e.message : "Fehler";
    } finally {
      stateSaving = false;
    }
  }

  async function saveSmtp() {
    smtpSaving = true;
    smtpError = "";
    smtpSaved = false;
    try {
      const body: Record<string, unknown> = {
        smtpHost,
        smtpPort,
        smtpUser,
        smtpFromEmail,
        smtpFromName,
        smtpSecure,
      };
      if (smtpPassword) body.smtpPassword = smtpPassword;
      await api.put("/settings/smtp", body);
      smtpPassword = "";
      smtpPasswordSet = true;
      smtpSaved = true;
      setTimeout(() => (smtpSaved = false), 3000);
    } catch (e: unknown) {
      smtpError = e instanceof Error ? e.message : "Fehler";
    } finally {
      smtpSaving = false;
    }
  }

  async function testSmtp() {
    smtpTesting = true;
    smtpTestResult = "";
    smtpTestError = "";
    try {
      await api.post("/settings/smtp/test", { email: smtpTestEmail });
      smtpTestResult = "Testmail erfolgreich gesendet.";
    } catch (e: unknown) {
      smtpTestError = e instanceof Error ? e.message : "SMTP-Fehler";
    } finally {
      smtpTesting = false;
    }
  }

  async function toggleTwoFa() {
    twoFaSaving = true;
    twoFaError = "";
    try {
      await api.put("/settings/security", { twoFaEnabled: !twoFaEnabled });
      twoFaEnabled = !twoFaEnabled;
    } catch (e: unknown) {
      twoFaError = e instanceof Error ? e.message : "Fehler";
    } finally {
      twoFaSaving = false;
    }
  }

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
      });
      phConfigured = true;
      phSaved = true;
    } catch (e: unknown) {
      phError = e instanceof Error ? e.message : "Fehler";
    } finally {
      phSaving = false;
    }
  }

  async function testPhorest() {
    phTesting = true;
    phTestResult = "";
    try {
      const res = await api.post<{ success: boolean; message?: string; error?: string }>(
        "/integrations/phorest/test",
        {},
      );
      phTestResult = res.success ? `✅ ${res.message}` : `❌ ${res.error}`;
    } catch (e: unknown) {
      phTestResult = `❌ ${e instanceof Error ? e.message : "Fehler"}`;
    } finally {
      phTesting = false;
    }
  }

  async function syncPhorest() {
    phSyncing = true;
    phSyncResult = null;
    phError = "";
    try {
      const res = await api.post<{
        created: number;
        skipped: number;
        unmapped: number;
        errors: number;
      }>("/integrations/phorest/sync-shifts", {
        startDate: phSyncStart,
        endDate: phSyncEnd,
      });
      phSyncResult = res;
    } catch (e: unknown) {
      phError = e instanceof Error ? e.message : "Sync fehlgeschlagen";
    } finally {
      phSyncing = false;
    }
  }
</script>

<svelte:head>
  <title>System – Clokr</title>
</svelte:head>

{#if loading}
  <div class="card card-body" style="height:220px;"></div>
{:else if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{:else}
  <!-- ── Systemeinstellungen ─────────────────────────────────────────────── -->
  <div class="card sys-card">
    <!-- Erscheinungsbild -->
    <div class="sys-section">
      <h3 class="sys-title">Erscheinungsbild</h3>
      <div class="form-group" style="max-width:320px;">
        <label class="form-label" for="theme-select">Theme</label>
        <select
          id="theme-select"
          class="form-input"
          value={$theme}
          onchange={(e) => theme.set(e.currentTarget.value as typeof $theme)}
        >
          {#each themes as t}
            <option value={t.id}>{t.label}</option>
          {/each}
        </select>
      </div>
    </div>

    <hr class="sys-divider" />

    <!-- Zeitzone + Bundesland -->
    <div class="sys-section">
      <h3 class="sys-title">Region & Zeitzone</h3>
      {#if stateError}
        <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
          <span>⚠</span><span>{stateError}</span>
        </div>
      {/if}
      <div class="inline-fields">
        <div class="form-group">
          <label class="form-label" for="g-federal-state">Bundesland</label>
          <select
            id="g-federal-state"
            bind:value={gFederalState}
            class="form-input federal-state-select"
          >
            {#each STATES as s}
              <option value={s.prisma}>{s.label}</option>
            {/each}
          </select>
          <p class="form-hint text-muted">Bestimmt gesetzliche Feiertage.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="g-timezone">Zeitzone</label>
          <select id="g-timezone" bind:value={gTimezone} class="form-input">
            {#each TIMEZONE_OPTIONS as tz}
              <option value={tz}>{tz}</option>
            {/each}
          </select>
          <p class="form-hint text-muted">Zuordnung von Zeitstempeln zu Tagen.</p>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick={saveFederalState} disabled={stateSaving}>
          {stateSaving ? "Speichern…" : "Speichern"}
        </button>
        {#if stateSaved}
          <span class="saved-hint">✓ Gespeichert</span>
        {/if}
      </div>
    </div>

    <hr class="sys-divider" />

    <!-- Sicherheit / 2FA -->
    <div class="sys-section">
      <h3 class="sys-title">Sicherheit</h3>
      {#if twoFaError}
        <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
          <span>⚠</span><span>{twoFaError}</span>
        </div>
      {/if}
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-row-label">2-Faktor-Authentifizierung (E-Mail OTP)</span>
          <p class="form-hint text-muted">
            Nach dem Login wird ein 6-stelliger Code per E-Mail gesendet.
          </p>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            checked={twoFaEnabled}
            onchange={toggleTwoFa}
            disabled={twoFaSaving}
          />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>

    <hr class="sys-divider" />

    <!-- E-Mail / SMTP -->
    <div class="sys-section">
      <h3 class="sys-title">E-Mail / SMTP</h3>
      {#if smtpError}
        <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
          <span>⚠</span><span>{smtpError}</span>
        </div>
      {/if}
      {#if smtpSaved}
        <div class="alert alert-success" role="alert" style="margin-bottom:1rem;">
          <span>✓</span><span>SMTP gespeichert.</span>
        </div>
      {/if}

      <div class="smtp-grid">
        <div class="form-group">
          <label class="form-label" for="smtp-host">SMTP-Host</label>
          <input
            id="smtp-host"
            type="text"
            bind:value={smtpHost}
            class="form-input"
            placeholder="smtp.example.com"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="smtp-port">Port</label>
          <input
            id="smtp-port"
            type="number"
            bind:value={smtpPort}
            class="form-input"
            placeholder="587"
            min="1"
            max="65535"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="smtp-user">Benutzername</label>
          <input
            id="smtp-user"
            type="text"
            bind:value={smtpUser}
            class="form-input"
            placeholder="user@example.com"
            autocomplete="off"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="smtp-pass">
            Passwort
            {#if smtpPasswordSet}<span class="badge-saved">gespeichert</span>{/if}
          </label>
          <input
            id="smtp-pass"
            type="password"
            bind:value={smtpPassword}
            class="form-input"
            placeholder="Unverändert lassen"
            autocomplete="new-password"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="smtp-from-email">Von E-Mail</label>
          <input
            id="smtp-from-email"
            type="email"
            bind:value={smtpFromEmail}
            class="form-input"
            placeholder="noreply@clokr.de"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="smtp-from-name">Von Name</label>
          <input
            id="smtp-from-name"
            type="text"
            bind:value={smtpFromName}
            class="form-input"
            placeholder="Clokr"
          />
        </div>
        <div class="form-group form-group--full">
          <label class="toggle-label">
            <input type="checkbox" bind:checked={smtpSecure} class="toggle-cb" />
            <span>TLS/SSL (Port 465)</span>
          </label>
        </div>
      </div>

      <div class="settings-actions">
        <button class="btn btn-primary" onclick={saveSmtp} disabled={smtpSaving}>
          {smtpSaving ? "Speichern…" : "SMTP speichern"}
        </button>
      </div>

      <div class="smtp-test-section">
        <span class="form-label">Testmail senden</span>
        <div class="smtp-test-row">
          <input
            type="email"
            bind:value={smtpTestEmail}
            class="form-input"
            placeholder="test@example.com"
            style="max-width:280px;"
          />
          <button class="btn btn-ghost" onclick={testSmtp} disabled={smtpTesting || !smtpTestEmail}>
            {smtpTesting ? "Senden…" : "Testmail senden"}
          </button>
        </div>
        {#if smtpTestResult}
          <p class="text-success" style="margin-top:0.5rem;font-size:0.875rem;">
            ✓ {smtpTestResult}
          </p>
        {/if}
        {#if smtpTestError}
          <p class="text-danger" style="margin-top:0.5rem;font-size:0.875rem;">⚠ {smtpTestError}</p>
        {/if}
      </div>
    </div>
  </div>

  <!-- ── Phorest-Integration ─────────────────────────────────────────────── -->
  <div class="section-label">
    <h2>Phorest-Integration</h2>
    <p class="text-muted">Schichten aus Phorest Salon-Software importieren</p>
  </div>

  <div class="card card-body settings-card">
    {#if phError}
      <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
        <span>⚠</span><span>{phError}</span>
      </div>
    {/if}
    {#if phSaved}
      <div class="alert alert-success" style="margin-bottom:1rem;">
        Phorest-Konfiguration gespeichert.
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

    <div style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-top:0.5rem;">
      <button class="btn btn-primary" onclick={savePhorest} disabled={phSaving}>
        {phSaving ? "Speichern…" : "Konfiguration speichern"}
      </button>
      <button class="btn btn-ghost" onclick={testPhorest} disabled={phTesting || !phConfigured}>
        {phTesting ? "Teste…" : "Verbindung testen"}
      </button>
    </div>

    {#if phTestResult}
      <p style="margin-top:0.75rem; font-size:0.875rem;">{phTestResult}</p>
    {/if}

    {#if phConfigured}
      <hr style="margin: 1.5rem 0; border-color: var(--color-border);" />

      <h3 style="font-size: 0.9375rem; font-weight: 600; margin-bottom: 0.75rem;">
        Automatischer Sync
      </h3>
      <label class="toggle-label" style="margin-bottom: 1rem;">
        <input type="checkbox" bind:checked={phAutoSync} class="toggle-cb" />
        <span>
          <strong>Auto-Sync aktivieren</strong><br />
          <span class="text-muted" style="font-size:0.8125rem;"
            >Schichten werden automatisch aus Phorest importiert (nächste 7 Tage).</span
          >
        </span>
      </label>

      {#if phAutoSync}
        <div class="form-group" style="max-width: 320px; margin-bottom: 1.25rem;">
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

      <h3 style="font-size: 0.9375rem; font-weight: 600; margin-bottom: 0.75rem;">
        Manueller Sync
      </h3>
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
      <button
        class="btn btn-primary"
        onclick={syncPhorest}
        disabled={phSyncing || !phSyncStart || !phSyncEnd}
      >
        {phSyncing ? "Synchronisiere…" : "Schichten importieren"}
      </button>
      <p class="form-hint text-muted">
        Mitarbeiter werden automatisch per E-Mail oder Name zugeordnet.
      </p>

      {#if phSyncResult}
        <div
          style="margin-top:1rem; padding:0.75rem 1rem; background: var(--color-bg-subtle); border-radius: var(--radius-md); font-size: 0.875rem;"
        >
          <strong>{phSyncResult.created}</strong> Schichten importiert,
          <strong>{phSyncResult.skipped}</strong> übersprungen (bereits vorhanden),
          <strong>{phSyncResult.unmapped}</strong> ohne Zuordnung,
          <strong>{phSyncResult.errors}</strong> Fehler
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .sys-card {
    padding: 0;
    margin-bottom: 2rem;
  }
  .sys-section {
    padding: 1.5rem 1.75rem;
  }
  .sys-divider {
    border: none;
    border-top: 1px solid var(--color-border-subtle);
    margin: 0;
  }
  .sys-title {
    font-size: 1.0625rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: var(--color-text-heading);
  }

  .inline-fields {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .inline-fields .form-group {
    min-width: 200px;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
  }
  .toggle-info {
    flex: 1;
  }
  .toggle-row-label {
    font-size: 1rem;
    font-weight: 500;
    color: var(--color-text);
  }

  .switch {
    position: relative;
    display: inline-block;
    width: 48px;
    height: 26px;
    flex-shrink: 0;
  }
  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .switch-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background-color: var(--gray-300);
    border-radius: 26px;
    transition: background-color 0.2s;
  }
  .switch-slider::before {
    content: "";
    position: absolute;
    height: 20px;
    width: 20px;
    left: 3px;
    bottom: 3px;
    background-color: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }
  .switch input:checked + .switch-slider {
    background-color: var(--color-brand);
  }
  .switch input:checked + .switch-slider::before {
    transform: translateX(22px);
  }

  .smtp-test-section {
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--color-border-subtle);
  }

  .form-hint {
    font-size: 0.8125rem;
    margin-top: 0.25rem;
  }

  .smtp-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .form-group--full {
    grid-column: 1 / -1;
  }

  .settings-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.5rem;
    align-items: center;
  }

  .section-divider {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 1.5rem 0;
  }

  .smtp-test-row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-top: 0.75rem;
    flex-wrap: wrap;
  }

  .badge-saved {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 600;
    background: #dcfce7;
    color: #166534;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    margin-left: 0.5rem;
    vertical-align: middle;
  }

  .text-success {
    color: #166534;
  }
  .text-danger {
    color: #991b1b;
  }

  .alert-success {
    background: #f0fdf4;
    color: #166534;
    border: 1px solid #bbf7d0;
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
    accent-color: var(--color-brand);
  }

  .saved-hint {
    color: var(--color-green, #16a34a);
    font-weight: 500;
    font-size: 0.9375rem;
  }

  .federal-state-select {
    min-width: 220px;
  }

  .modal-section-heading {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text-heading);
    margin-bottom: 0.5rem;
  }

  .alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
  }
  .alert-error {
    background: #fef2f2;
    color: #991b1b;
    border: 1px solid #fecaca;
  }
</style>
