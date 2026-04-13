<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { theme, themes } from "$stores/theme";
  import Pagination from "$components/ui/Pagination.svelte";

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
    // DATEV Lohnartennummern (Phase 4 — DATEV-03)
    datevNormalstundenNr?: number;
    datevUrlaubNr?: number;
    datevKrankNr?: number;
    datevSonderurlaubNr?: number;
  }

  interface SecurityConfig {
    twoFaEnabled: boolean;
    passwordMinLength: number;
    passwordRequireUpper: boolean;
    passwordRequireLower: boolean;
    passwordRequireDigit: boolean;
    passwordRequireSpecial: boolean;
    // Optional extended fields
    emailNotificationsEnabled?: boolean;
    emailOnLeaveRequest?: boolean;
    emailOnLeaveDecision?: boolean;
    emailOnOvertimeWarning?: boolean;
    emailOnMissingEntries?: boolean;
    emailOnClockOutReminder?: boolean;
    emailOnMonthClose?: boolean;
    sessionTimeoutMinutes?: number;
    refreshTokenDays?: number;
    rememberMeEnabled?: boolean;
    rememberMeDays?: number;
    maxSessionsPerUser?: number;
    loginMaxAttempts?: number;
    loginLockoutMinutes?: number;
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
  let datevNormalstundenNr = $state(100);
  let datevUrlaubNr = $state(300);
  let datevKrankNr = $state(200);
  let datevSonderurlaubNr = $state(302);
  let datevSaving = $state(false);
  let datevSaved = $state(false);
  let datevError = $state("");

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

  // Session-Management
  let sessionTimeoutMinutes = $state(60);
  let refreshTokenDays = $state(7);
  let rememberMeEnabled = $state(true);
  let rememberMeDays = $state(30);
  let maxSessionsPerUser = $state(0);
  let loginMaxAttempts = $state(5);
  let loginLockoutMinutes = $state(15);
  let sessionSaving = $state(false);
  let sessionSaved = $state(false);
  let sessionError = $state("");

  // Password policy (BSI)
  let pwMinLength = $state(12);
  let pwRequireUpper = $state(true);
  let pwRequireLower = $state(true);
  let pwRequireDigit = $state(true);
  let pwRequireSpecial = $state(true);
  let pwSaving = $state(false);
  let pwSaved = $state(false);
  let pwError = $state("");

  // E-Mail-Benachrichtigungen
  let emailEnabled = $state(false);
  let emailOnLeaveRequest = $state(true);
  let emailOnLeaveDecision = $state(true);
  let emailOnOvertimeWarning = $state(false);
  let emailOnMissingEntries = $state(false);
  let emailOnClockOutReminder = $state(false);
  let emailOnMonthClose = $state(true);
  let emailSaving = $state(false);
  let emailSaved = $state(false);
  let emailError = $state("");

  // NFC Terminals
  interface TerminalKey {
    id: string;
    name: string;
    keyPrefix: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }

  let terminalKeys: TerminalKey[] = $state([]);
  let tkPage = $state(1);
  let tkPageSize = $state(10);
  let pagedTerminalKeys = $derived(
    terminalKeys.slice((tkPage - 1) * tkPageSize, tkPage * tkPageSize),
  );
  let terminalLoading = $state(false);
  let newKeyName = $state("");
  let newKeyRaw = $state(""); // shown once after creation
  let showNewKey = $state(false);

  // API Keys
  interface ApiKeyEntry {
    id: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }
  let apiKeys: ApiKeyEntry[] = $state([]);
  let akPage = $state(1);
  let akPageSize = $state(10);
  let pagedApiKeys = $derived(apiKeys.slice((akPage - 1) * akPageSize, akPage * akPageSize));
  let newApiKeyName = $state("");
  let newApiKeyScopes = $state<string[]>(["read:employees", "read:time-entries"]);
  let newApiKeyRaw = $state("");
  let showNewApiKey = $state(false);
  let apiKeyLoading = $state(false);

  const API_SCOPES = [
    { scope: "read:employees", label: "Mitarbeiter lesen" },
    { scope: "read:time-entries", label: "Zeiteinträge lesen" },
    { scope: "write:time-entries", label: "Zeiteinträge schreiben" },
    { scope: "read:leave", label: "Abwesenheiten lesen" },
    { scope: "write:leave", label: "Abwesenheiten schreiben" },
    { scope: "read:reports", label: "Berichte lesen" },
    { scope: "read:overtime", label: "Überstunden lesen" },
    { scope: "admin", label: "Voller Zugriff" },
  ];

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
        defaultWeeklyHours: Number(cfg.defaultWeeklyHours),
        defaultMondayHours: Number(cfg.defaultMondayHours),
        defaultTuesdayHours: Number(cfg.defaultTuesdayHours),
        defaultWednesdayHours: Number(cfg.defaultWednesdayHours),
        defaultThursdayHours: Number(cfg.defaultThursdayHours),
        defaultFridayHours: Number(cfg.defaultFridayHours),
        defaultSaturdayHours: Number(cfg.defaultSaturdayHours),
        defaultSundayHours: Number(cfg.defaultSundayHours),
        overtimeThreshold: Number(cfg.overtimeThreshold),
        allowOvertimePayout: cfg.allowOvertimePayout,
        defaultVacationDays: Number(cfg.defaultVacationDays),
        carryOverDeadlineDay: cfg.carryOverDeadlineDay,
        carryOverDeadlineMonth: cfg.carryOverDeadlineMonth,
      };
      datevNormalstundenNr = cfg.datevNormalstundenNr ?? 100;
      datevUrlaubNr = cfg.datevUrlaubNr ?? 300;
      datevKrankNr = cfg.datevKrankNr ?? 200;
      datevSonderurlaubNr = cfg.datevSonderurlaubNr ?? 302;

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
        const sec = await api.get<SecurityConfig>("/settings/security");
        twoFaEnabled = sec.twoFaEnabled;
        pwMinLength = sec.passwordMinLength;
        pwRequireUpper = sec.passwordRequireUpper;
        pwRequireLower = sec.passwordRequireLower;
        pwRequireDigit = sec.passwordRequireDigit;
        pwRequireSpecial = sec.passwordRequireSpecial;
        emailEnabled = sec.emailNotificationsEnabled ?? false;
        emailOnLeaveRequest = sec.emailOnLeaveRequest ?? true;
        emailOnLeaveDecision = sec.emailOnLeaveDecision ?? true;
        emailOnOvertimeWarning = sec.emailOnOvertimeWarning ?? false;
        emailOnMissingEntries = sec.emailOnMissingEntries ?? false;
        emailOnClockOutReminder = sec.emailOnClockOutReminder ?? false;
        emailOnMonthClose = sec.emailOnMonthClose ?? true;
        sessionTimeoutMinutes = sec.sessionTimeoutMinutes ?? 60;
        refreshTokenDays = sec.refreshTokenDays ?? 7;
        rememberMeEnabled = sec.rememberMeEnabled ?? true;
        rememberMeDays = sec.rememberMeDays ?? 30;
        maxSessionsPerUser = sec.maxSessionsPerUser ?? 0;
        loginMaxAttempts = sec.loginMaxAttempts ?? 5;
        loginLockoutMinutes = sec.loginLockoutMinutes ?? 15;
      } catch {
        /* ignorieren */
      }

      try {
        const res = await api.get<{ keys: TerminalKey[] }>("/terminals");
        terminalKeys = res.keys;
      } catch (err) {
        console.error("Failed to load terminal keys:", err);
      }

      try {
        apiKeys = await api.get<ApiKeyEntry[]>("/api-keys");
      } catch {
        /* ignore */
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

  async function saveDatev() {
    if (!_gOtherFields) return; // guard: need full work-settings context to avoid partial overwrite
    datevSaving = true;
    datevError = "";
    datevSaved = false;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        datevNormalstundenNr,
        datevUrlaubNr,
        datevKrankNr,
        datevSonderurlaubNr,
      });
      datevSaved = true;
      setTimeout(() => (datevSaved = false), 3000);
    } catch (e: unknown) {
      datevError = e instanceof Error ? e.message : "Fehler";
    } finally {
      datevSaving = false;
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

  async function saveSessionConfig() {
    sessionSaving = true;
    sessionSaved = false;
    sessionError = "";
    try {
      await api.put("/settings/security", {
        sessionTimeoutMinutes,
        refreshTokenDays,
        rememberMeEnabled,
        rememberMeDays,
        maxSessionsPerUser,
        loginMaxAttempts,
        loginLockoutMinutes,
      });
      sessionSaved = true;
      setTimeout(() => (sessionSaved = false), 3000);
    } catch (e: unknown) {
      sessionError = e instanceof Error ? e.message : "Fehler";
    } finally {
      sessionSaving = false;
    }
  }

  async function savePasswordPolicy() {
    pwSaving = true;
    pwSaved = false;
    pwError = "";
    try {
      await api.put("/settings/security", {
        passwordMinLength: pwMinLength,
        passwordRequireUpper: pwRequireUpper,
        passwordRequireLower: pwRequireLower,
        passwordRequireDigit: pwRequireDigit,
        passwordRequireSpecial: pwRequireSpecial,
      });
      pwSaved = true;
      setTimeout(() => (pwSaved = false), 3000);
    } catch (e: unknown) {
      pwError = e instanceof Error ? e.message : "Fehler";
    } finally {
      pwSaving = false;
    }
  }

  async function saveEmailConfig() {
    emailSaving = true;
    emailSaved = false;
    emailError = "";
    try {
      await api.put("/settings/security", {
        emailNotificationsEnabled: emailEnabled,
        emailOnLeaveRequest,
        emailOnLeaveDecision,
        emailOnOvertimeWarning,
        emailOnMissingEntries,
        emailOnClockOutReminder,
        emailOnMonthClose,
      });
      emailSaved = true;
      setTimeout(() => (emailSaved = false), 3000);
    } catch (e: unknown) {
      emailError = e instanceof Error ? e.message : "Fehler";
    } finally {
      emailSaving = false;
    }
  }

  async function createApiKey() {
    if (!newApiKeyName.trim() || newApiKeyScopes.length === 0) return;
    apiKeyLoading = true;
    try {
      const res = await api.post<ApiKeyEntry & { rawKey: string }>("/api-keys", {
        name: newApiKeyName.trim(),
        scopes: newApiKeyScopes,
      });
      newApiKeyRaw = res.rawKey;
      showNewApiKey = true;
      newApiKeyName = "";
      apiKeys = await api.get<ApiKeyEntry[]>("/api-keys");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Fehler");
    } finally {
      apiKeyLoading = false;
    }
  }

  async function revokeApiKey(id: string) {
    try {
      await api.delete(`/api-keys/${id}`);
      apiKeys = await api.get<ApiKeyEntry[]>("/api-keys");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Fehler");
    }
  }

  function toggleScope(scope: string) {
    if (newApiKeyScopes.includes(scope)) {
      newApiKeyScopes = newApiKeyScopes.filter((s) => s !== scope);
    } else {
      newApiKeyScopes = [...newApiKeyScopes, scope];
    }
  }

  async function createTerminalKey() {
    if (!newKeyName.trim()) return;
    terminalLoading = true;
    try {
      const res = await api.post<{ rawKey: string }>("/terminals", { name: newKeyName.trim() });
      newKeyRaw = res.rawKey;
      showNewKey = true;
      newKeyName = "";
      // Refresh list
      const list = await api.get<{ keys: TerminalKey[] }>("/terminals");
      terminalKeys = list.keys;
    } catch (err) {
      console.error("Failed to create terminal key:", err);
    } finally {
      terminalLoading = false;
    }
  }

  async function revokeTerminalKey(id: string) {
    try {
      await api.delete(`/terminals/${id}`);
      const list = await api.get<{ keys: TerminalKey[] }>("/terminals");
      terminalKeys = list.keys;
    } catch (err) {
      console.error("Failed to revoke terminal key:", err);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
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
  <div class="card sys-card card-animate">
    <!-- Erscheinungsbild -->
    <div class="sys-section">
      <h3 class="sys-title">Erscheinungsbild</h3>
      <div class="form-group">
        <span class="form-label">Theme</span>
        <div class="theme-picker" role="radiogroup" aria-label="Theme auswählen">
          {#each themes as t (t.id)}
            <button
              class="theme-dot"
              type="button"
              aria-checked={$theme === t.id ? "true" : "false"}
              aria-label={t.label}
              title="Theme: {t.label}"
              onclick={() => theme.set(t.id)}
            >
              <span class="theme-dot-inner" style="background-color: {t.color}"></span>
            </button>
          {/each}
        </div>
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
            {#each STATES as s (s.prisma)}
              <option value={s.prisma}>{s.label}</option>
            {/each}
          </select>
          <p class="form-hint text-muted">Bestimmt gesetzliche Feiertage.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="g-timezone">Zeitzone</label>
          <select id="g-timezone" bind:value={gTimezone} class="form-input">
            {#each TIMEZONE_OPTIONS as tz (tz)}
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
            aria-label="2-Faktor-Authentifizierung aktivieren"
            checked={twoFaEnabled}
            onchange={toggleTwoFa}
            disabled={twoFaSaving}
          />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>

    <hr class="sys-divider" />

    <!-- Session-Management -->
    <div class="sys-section">
      <h3 class="sys-title">Session-Management</h3>
      {#if sessionError}
        <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
          <span>⚠</span><span>{sessionError}</span>
        </div>
      {/if}
      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label" for="session-timeout">Inaktivitäts-Timeout (Minuten)</label>
          <input
            id="session-timeout"
            type="number"
            min="0"
            max="480"
            bind:value={sessionTimeoutMinutes}
            class="form-input"
          />
          <p class="form-hint text-muted">
            0 = deaktiviert. Benutzer wird nach Inaktivität ausgeloggt.
          </p>
        </div>
        <div class="form-group">
          <label class="form-label" for="refresh-days">Session-Dauer (Tage)</label>
          <input
            id="refresh-days"
            type="number"
            min="1"
            max="90"
            bind:value={refreshTokenDays}
            class="form-input"
          />
          <p class="form-hint text-muted">
            Wie lange ein Login ohne "Angemeldet bleiben" gültig ist.
          </p>
        </div>
      </div>
      <div class="toggle-row" style="margin-top:0.75rem">
        <div class="toggle-info">
          <span class="toggle-row-label">"Angemeldet bleiben" erlauben</span>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            aria-label="&quot;Angemeldet bleiben&quot; erlauben"
            bind:checked={rememberMeEnabled}
          />
          <span class="switch-slider"></span>
        </label>
      </div>
      {#if rememberMeEnabled}
        <div class="settings-grid" style="margin-top:0.5rem">
          <div class="form-group">
            <label class="form-label" for="remember-days">"Angemeldet bleiben" Dauer (Tage)</label>
            <input
              id="remember-days"
              type="number"
              min="1"
              max="365"
              bind:value={rememberMeDays}
              class="form-input"
            />
          </div>
        </div>
      {/if}
      <div class="settings-grid" style="margin-top:0.75rem">
        <div class="form-group">
          <label class="form-label" for="max-sessions">Max. gleichzeitige Sessions</label>
          <input
            id="max-sessions"
            type="number"
            min="0"
            max="20"
            bind:value={maxSessionsPerUser}
            class="form-input"
          />
          <p class="form-hint text-muted">
            0 = unbegrenzt. Älteste Session wird bei Überschreitung beendet.
          </p>
        </div>
      </div>
      <div class="settings-grid" style="margin-top:0.75rem">
        <div class="form-group">
          <label class="form-label" for="login-max-attempts">Max. Fehlversuche bis Sperre</label>
          <input
            id="login-max-attempts"
            type="number"
            min="1"
            max="20"
            bind:value={loginMaxAttempts}
            class="form-input"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="login-lockout-min">Sperrzeit (Minuten)</label>
          <input
            id="login-lockout-min"
            type="number"
            min="1"
            max="1440"
            bind:value={loginLockoutMinutes}
            class="form-input"
          />
          <p class="form-hint text-muted">
            Nach Ablauf wird der Zähler zurückgesetzt. Admin kann manuell entsperren.
          </p>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick={saveSessionConfig} disabled={sessionSaving}>
          {sessionSaving ? "Speichern…" : "Speichern"}
        </button>
        {#if sessionSaved}
          <span class="saved-hint">✓ Gespeichert</span>
        {/if}
      </div>
    </div>

    <hr class="sys-divider" />

    <!-- Passwort-Richtlinie (BSI) -->
    <div class="sys-section">
      <h3 class="sys-title">Passwort-Richtlinie (BSI)</h3>
      {#if pwError}
        <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
          <span>⚠</span><span>{pwError}</span>
        </div>
      {/if}
      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label" for="pw-min-length">Mindestlänge</label>
          <input
            id="pw-min-length"
            type="number"
            min="8"
            max="128"
            bind:value={pwMinLength}
            class="form-input"
          />
          <p class="form-hint text-muted">BSI empfiehlt mindestens 12 Zeichen.</p>
        </div>
      </div>
      <div class="toggle-row" style="margin-top:0.75rem">
        <div class="toggle-info">
          <span class="toggle-row-label">Großbuchstabe erforderlich</span>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            aria-label="Großbuchstabe erforderlich"
            bind:checked={pwRequireUpper}
          />
          <span class="switch-slider"></span>
        </label>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-row-label">Kleinbuchstabe erforderlich</span>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            aria-label="Kleinbuchstabe erforderlich"
            bind:checked={pwRequireLower}
          />
          <span class="switch-slider"></span>
        </label>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-row-label">Ziffer erforderlich</span>
        </div>
        <label class="switch">
          <input type="checkbox" aria-label="Ziffer erforderlich" bind:checked={pwRequireDigit} />
          <span class="switch-slider"></span>
        </label>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-row-label">Sonderzeichen erforderlich</span>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            aria-label="Sonderzeichen erforderlich"
            bind:checked={pwRequireSpecial}
          />
          <span class="switch-slider"></span>
        </label>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick={savePasswordPolicy} disabled={pwSaving}>
          {pwSaving ? "Speichern…" : "Speichern"}
        </button>
        {#if pwSaved}
          <span class="saved-hint">✓ Gespeichert</span>
        {/if}
      </div>
    </div>

    <hr class="sys-divider" />

    <!-- E-Mail-Benachrichtigungen -->
    <div class="sys-section">
      <h3 class="sys-title">E-Mail-Benachrichtigungen</h3>
      {#if emailError}
        <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
          <span>⚠</span><span>{emailError}</span>
        </div>
      {/if}
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-row-label">E-Mail-Benachrichtigungen aktivieren</span>
          <p class="form-hint text-muted">
            Sendet zusätzlich zur In-App-Benachrichtigung eine E-Mail. SMTP muss konfiguriert sein.
          </p>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            aria-label="E-Mail-Benachrichtigungen aktivieren"
            bind:checked={emailEnabled}
          />
          <span class="switch-slider"></span>
        </label>
      </div>
      {#if emailEnabled}
        <h4 class="sys-subtitle" style="margin-top:1rem">Benachrichtigungstypen</h4>
        <div class="toggle-row">
          <span class="toggle-row-label">Neuer Urlaubsantrag</span>
          <label class="switch"
            ><input
              type="checkbox"
              aria-label="Benachrichtigung: Neuer Urlaubsantrag"
              bind:checked={emailOnLeaveRequest}
            /><span class="switch-slider"></span></label
          >
        </div>
        <div class="toggle-row">
          <span class="toggle-row-label">Urlaub genehmigt / abgelehnt</span>
          <label class="switch"
            ><input
              type="checkbox"
              aria-label="Benachrichtigung: Urlaub genehmigt / abgelehnt"
              bind:checked={emailOnLeaveDecision}
            /><span class="switch-slider"></span></label
          >
        </div>
        <div class="toggle-row">
          <span class="toggle-row-label">Überstunden-Warnung</span>
          <label class="switch"
            ><input
              type="checkbox"
              aria-label="Benachrichtigung: Überstunden-Warnung"
              bind:checked={emailOnOvertimeWarning}
            /><span class="switch-slider"></span></label
          >
        </div>
        <div class="toggle-row">
          <span class="toggle-row-label">Fehlende Zeiteinträge</span>
          <label class="switch"
            ><input
              type="checkbox"
              aria-label="Benachrichtigung: Fehlende Zeiteinträge"
              bind:checked={emailOnMissingEntries}
            /><span class="switch-slider"></span></label
          >
        </div>
        <div class="toggle-row">
          <span class="toggle-row-label">Vergessene Stempelung</span>
          <label class="switch"
            ><input
              type="checkbox"
              aria-label="Benachrichtigung: Vergessene Stempelung"
              bind:checked={emailOnClockOutReminder}
            /><span class="switch-slider"></span></label
          >
        </div>
        <div class="toggle-row">
          <span class="toggle-row-label">Monatsabschluss</span>
          <label class="switch"
            ><input
              type="checkbox"
              aria-label="Benachrichtigung: Monatsabschluss"
              bind:checked={emailOnMonthClose}
            /><span class="switch-slider"></span></label
          >
        </div>
      {/if}
      <div class="settings-actions">
        <button class="btn btn-primary" onclick={saveEmailConfig} disabled={emailSaving}>
          {emailSaving ? "Speichern…" : "Speichern"}
        </button>
        {#if emailSaved}
          <span class="saved-hint">✓ Gespeichert</span>
        {/if}
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
          <p class="form-hint">
            Gmail/Google: <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noopener">App-Passwort</a
            > verwenden (2FA erforderlich). Outlook: App-Passwort in den Sicherheitseinstellungen.
          </p>
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

    <hr class="sys-divider" />

    <!-- NFC-Terminals -->
    <div class="sys-section">
      <h3 class="sys-title">NFC-Terminals</h3>
      <p class="text-muted" style="margin-bottom: 1rem;">
        API-Schlüssel für NFC-Terminals verwalten. Jedes Terminal benötigt einen eigenen Schlüssel.
      </p>

      {#if showNewKey}
        <div class="alert alert-success" style="margin: 1rem 0;">
          <div>
            <strong>Neuer Schlüssel erstellt!</strong>
            <p style="margin: 0.5rem 0;">
              Kopieren Sie den Schlüssel jetzt — er wird nicht erneut angezeigt:
            </p>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              <code
                style="flex: 1; padding: 0.5rem; background: var(--color-bg-subtle); border-radius: var(--radius-sm); word-break: break-all; font-size: 0.8125rem;"
                >{newKeyRaw}</code
              >
              <button class="btn btn-sm btn-ghost" onclick={() => copyToClipboard(newKeyRaw)}
                >Kopieren</button
              >
            </div>
            <button
              class="btn btn-sm btn-ghost"
              style="margin-top: 0.5rem;"
              onclick={() => {
                showNewKey = false;
                newKeyRaw = "";
              }}>Schließen</button
            >
          </div>
        </div>
      {/if}

      <div style="display: flex; gap: 0.5rem; margin: 1rem 0;">
        <input
          type="text"
          class="form-input"
          bind:value={newKeyName}
          placeholder="Terminal-Name (z.B. Kasse 1)"
          style="flex: 1;"
        />
        <button
          class="btn btn-primary"
          onclick={createTerminalKey}
          disabled={terminalLoading || !newKeyName.trim()}
        >
          Schlüssel erstellen
        </button>
      </div>

      {#if terminalKeys.length > 0}
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Schlüssel</th>
                <th>Zuletzt verwendet</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each pagedTerminalKeys as key (key.id)}
                <tr class:row-revoked={key.revokedAt}>
                  <td>{key.name}</td>
                  <td><code style="font-size: 0.8125rem;">{key.keyPrefix}</code></td>
                  <td
                    >{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString("de-DE") : "Nie"}</td
                  >
                  <td>
                    {#if key.revokedAt}
                      <span class="badge badge-red">Widerrufen</span>
                    {:else}
                      <span class="badge badge-green">Aktiv</span>
                    {/if}
                  </td>
                  <td>
                    {#if !key.revokedAt}
                      <button
                        class="btn btn-sm btn-ghost text-red"
                        onclick={() => revokeTerminalKey(key.id)}>Widerrufen</button
                      >
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <Pagination total={terminalKeys.length} bind:page={tkPage} bind:pageSize={tkPageSize} />
        </div>
      {:else}
        <p class="text-muted">Keine Terminal-Schlüssel vorhanden.</p>
      {/if}
    </div>
  </div>

  <!-- ── API Keys ──────────────────────────────────────────────────────── -->
  <div class="section-label">
    <h2 class="section-header">API Keys</h2>
    <p class="text-muted">Schlüssel für externe Integrationen (Lohnsoftware, Automations)</p>
  </div>

  <div class="card card-body settings-card card-animate">
    <div class="sys-section">
      {#if showNewApiKey}
        <div class="alert alert-success" style="margin-bottom:1rem;">
          <div>
            <strong>API Key erstellt!</strong>
            <p style="margin:0.5rem 0">
              Kopieren Sie den Schlüssel jetzt — er wird nicht erneut angezeigt:
            </p>
            <div style="display:flex;gap:0.5rem;align-items:center">
              <code
                style="flex:1;padding:0.5rem;background:var(--color-bg-subtle);border-radius:var(--radius-sm);word-break:break-all;font-size:0.8125rem"
                >{newApiKeyRaw}</code
              >
              <button
                class="btn btn-sm btn-ghost"
                onclick={() => navigator.clipboard.writeText(newApiKeyRaw)}>Kopieren</button
              >
            </div>
            <button
              class="btn btn-sm btn-ghost"
              style="margin-top:0.5rem"
              onclick={() => {
                showNewApiKey = false;
                newApiKeyRaw = "";
              }}>Schließen</button
            >
          </div>
        </div>
      {/if}

      <div style="margin-bottom:1rem">
        <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem">
          <input
            type="text"
            class="form-input"
            bind:value={newApiKeyName}
            placeholder="Name (z.B. DATEV Export)"
            style="flex:1"
          />
          <button
            class="btn btn-primary"
            onclick={createApiKey}
            disabled={apiKeyLoading || !newApiKeyName.trim() || newApiKeyScopes.length === 0}
          >
            Key erstellen
          </button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:0.375rem">
          {#each API_SCOPES as s (s.scope)}
            <button
              class="btn btn-sm"
              class:btn-primary={newApiKeyScopes.includes(s.scope)}
              class:btn-ghost={!newApiKeyScopes.includes(s.scope)}
              onclick={() => toggleScope(s.scope)}>{s.label}</button
            >
          {/each}
        </div>
      </div>

      {#if apiKeys.length > 0}
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Letzter Zugriff</th><th></th></tr>
            </thead>
            <tbody>
              {#each pagedApiKeys as key (key.id)}
                <tr class:inactive={!!key.revokedAt}>
                  <td>{key.name}</td>
                  <td><code>{key.keyPrefix}…</code></td>
                  <td style="font-size:0.75rem">{key.scopes.join(", ")}</td>
                  <td
                    >{key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleDateString("de-DE")
                      : "Nie"}</td
                  >
                  <td>
                    {#if !key.revokedAt}
                      <button
                        class="btn btn-sm btn-ghost"
                        style="color:var(--color-red)"
                        onclick={() => revokeApiKey(key.id)}>Widerrufen</button
                      >
                    {:else}
                      <span class="text-muted" style="font-size:0.75rem">Widerrufen</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <Pagination total={apiKeys.length} bind:page={akPage} bind:pageSize={akPageSize} />
        </div>
      {:else}
        <p class="text-muted">Keine API Keys vorhanden.</p>
      {/if}
    </div>
  </div>

  <!-- ── DATEV Export ─────────────────────────────────────────────────── -->
  <div class="section-label">
    <h2 class="section-header">DATEV Export</h2>
    <p class="text-muted">Lohnartennummern für den DATEV LODAS ASCII-Export konfigurieren</p>
  </div>

  <div class="card card-body settings-card card-animate">
    {#if datevError}
      <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
        <span>⚠</span><span>{datevError}</span>
      </div>
    {/if}
    {#if datevSaved}
      <div class="alert alert-success" style="margin-bottom:1rem;">
        DATEV-Konfiguration gespeichert.
      </div>
    {/if}

    <div class="form-grid">
      <div class="form-group">
        <label class="form-label" for="datev-normal">Normalstunden</label>
        <input
          id="datev-normal"
          type="number"
          min="1"
          max="9999"
          step="1"
          bind:value={datevNormalstundenNr}
          class="form-input"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="datev-urlaub">Urlaub</label>
        <input
          id="datev-urlaub"
          type="number"
          min="1"
          max="9999"
          step="1"
          bind:value={datevUrlaubNr}
          class="form-input"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="datev-krank">Krank / AU</label>
        <input
          id="datev-krank"
          type="number"
          min="1"
          max="9999"
          step="1"
          bind:value={datevKrankNr}
          class="form-input"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="datev-sonder">Sonderurlaub</label>
        <input
          id="datev-sonder"
          type="number"
          min="1"
          max="9999"
          step="1"
          bind:value={datevSonderurlaubNr}
          class="form-input"
        />
      </div>
    </div>

    <div style="margin-top:1rem; display:flex; justify-content:flex-end;">
      <button class="btn btn-primary" onclick={saveDatev} disabled={datevSaving}>
        {datevSaving ? "Speichert…" : "Speichern"}
      </button>
    </div>
  </div>

  <!-- ── Phorest-Integration ─────────────────────────────────────────────── -->
  <div class="section-label">
    <h2 class="section-header">Phorest-Integration</h2>
    <p class="text-muted">Schichten aus Phorest Salon-Software importieren</p>
  </div>

  <div class="card card-body settings-card card-animate">
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
  .theme-picker {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-top: 0.5rem;
  }
  .theme-dot {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 3px;
    background: none;
    cursor: pointer;
    transition:
      border-color 150ms ease,
      transform 150ms ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .theme-dot[aria-checked="true"] {
    border-color: var(--color-brand);
  }
  .theme-dot:hover {
    transform: scale(1.1);
  }
  .theme-dot:focus-visible {
    outline: 2px solid var(--color-brand);
    outline-offset: 2px;
  }
  .theme-dot-inner {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    display: block;
  }

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

  .sys-subtitle {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.5rem;
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

  .row-revoked {
    opacity: 0.5;
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

  .section-label {
    margin-bottom: 1rem;
  }

  .settings-card {
    margin-bottom: 2rem;
  }

  @media (max-width: 640px) {
    .smtp-grid {
      grid-template-columns: 1fr;
    }

    .form-grid {
      grid-template-columns: 1fr;
    }

    .inline-fields {
      flex-direction: column;
      gap: 1rem;
    }

    .sys-section {
      padding: 1.25rem 1rem;
    }
  }
</style>
