<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { toasts } from "$stores/toast";
  import { tenantFeatures } from "$stores/tenant-features";

  // ── Tabs (Phase 58: tabbed config layout) ──────────────────────────────────
  const TABS = [
    { id: "allgemein", label: "Allgemein" },
    { id: "arbeitszeit", label: "Arbeitszeit" },
    { id: "sicherheit", label: "Sicherheit" },
    { id: "kommunikation", label: "Kommunikation" },
    { id: "integration", label: "Integration" },
  ];
  let activeTab = $state<string>("allgemein");

  interface TenantConfig {
    tenantName?: string;
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
    // MONTHLY_HOURS: Feiertage reduzieren Monatsstunden-Soll (Phase 15)
    monthlyHoursHolidayDeduction?: boolean;
    // ArbZG § 4 — Auto-Pausen (Pflege hier, nicht mehr auf /admin/vacation)
    autoBreakEnabled?: boolean;
    defaultBreakStart?: string | null;
    // Phase 64/65 — Konfigurierbare Pausendauer (ArbZG §4 Floor: 30/45 Min)
    defaultBreakOver6h?: number;
    defaultBreakOver9h?: number;
    // Phase 49.2 — FLEXTIME Kernarbeitszeit-Defaults
    defaultCoreStart?: string | null;
    defaultCoreEnd?: string | null;
    defaultCoreDays?: number[];
    // Phase 47.3 / 49.4 — Verfügbarkeits-System Feature-Toggle
    availabilityEnabled?: boolean;
    // Phase 49.5 — Standard-Arbeitstage (0=So..6=Sa)
    defaultWorkDays?: number[];
    // Phase 58 — Ladenöffnungszeiten (moved from /admin/shifts)
    storeHours?: StoreHourEntry[];
    shiftStoreHoursMode?: "STRICT" | "DAY_ONLY" | "OFF";
    // Phase 67.2 — Auto-Cleanup für Berufsschultag-Schichten (Plan 04 backend hook,
    // Plan 05 surfaces toggle here). Wenn true (Default): künftige Shifts auf neuen
    // BS-Tagen werden vom Generator weich-gelöscht; in der Vergangenheit nur markiert.
    vocationalSchoolAutoCleanupShifts?: boolean;
    // Phase 76.29 — Monatsabschluss mit Lücken + Rückwirkende Einträge
    closeMonthWithGapsAllowed?: boolean;
    retroEntryWindowDays?: number;
    // Phase 76.31 D-06 / 76.35 — 4-layer bsSlot* override (TenantConfig layer)
    bsSlotFirstLongDayMinutes?: number | null;
    bsSlotSecondLongDayMinutes?: number | null;
    bsSlotShortDayMinutes?: number | null;
    bsSlotBlockWeekMinutes?: number | null;
  }

  interface StoreHourEntry {
    day: number; // 0..6 (Mo..So)
    open: string;
    close: string;
    closed?: boolean;
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

  // Federal state + tenant name
  let gFederalState = $state("NIEDERSACHSEN");
  let gTenantName = $state("");
  let _gOtherFields: Omit<TenantConfig, "federalState"> | null = null;
  let stateSaving = $state(false);
  let stateSaved = $state(false);
  let stateError = $state("");

  // DATEV Lohnartennummern moved to /admin/export (Phase 58) — TenantConfig fields
  // datevNormalstundenNr / datevUrlaubNr / datevKrankNr / datevSonderurlaubNr live there.

  // ── Phase 58: Ladenöffnungszeiten (moved from /admin/shifts) ─────────────
  const DAY_NAMES_LONG = [
    "Montag",
    "Dienstag",
    "Mittwoch",
    "Donnerstag",
    "Freitag",
    "Samstag",
    "Sonntag",
  ];
  let storeHours: StoreHourEntry[] = $state([]);
  let shiftStoreHoursMode: "STRICT" | "DAY_ONLY" | "OFF" = $state("DAY_ONLY");
  let storeHoursSaving = $state(false);
  let storeHoursMsg = $state("");

  function normalizeStoreHours(raw: StoreHourEntry[] | undefined): StoreHourEntry[] {
    const fallback: StoreHourEntry[] = [
      { day: 0, open: "08:00", close: "20:00" },
      { day: 1, open: "08:00", close: "20:00" },
      { day: 2, open: "08:00", close: "20:00" },
      { day: 3, open: "08:00", close: "20:00" },
      { day: 4, open: "08:00", close: "20:00" },
      { day: 5, open: "08:00", close: "20:00" },
      { day: 6, open: "08:00", close: "20:00", closed: true },
    ];
    if (!raw || !Array.isArray(raw) || raw.length !== 7) return fallback;
    return [...raw].sort((a, b) => a.day - b.day);
  }

  async function saveStoreHours() {
    if (!_gOtherFields) return; // guard: need full work-settings context
    storeHoursSaving = true;
    storeHoursMsg = "";
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        storeHours,
        shiftStoreHoursMode,
      });
      storeHoursMsg = "Gespeichert.";
      toasts.success("Ladenöffnungszeiten aktualisiert.");
    } catch (e: unknown) {
      storeHoursMsg = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
      toasts.error(storeHoursMsg);
    } finally {
      storeHoursSaving = false;
      setTimeout(() => (storeHoursMsg = ""), 2500);
    }
  }

  // Phase 15: MONTHLY_HOURS holiday deduction toggle
  let monthlyHoursHolidayDeduction = $state(false);
  let holidayDeductionSaving = $state(false);

  // ArbZG § 4 — Auto-Pausen (moved from /admin/vacation in v1.6.5)
  let autoBreakEnabled = $state(false);
  let defaultBreakStart = $state("12:00");
  let autoBreakSaving = $state(false);
  let autoBreakSaved = $state(false);
  let autoBreakError = $state("");

  // Phase 65 — Tenant-Default Pausendauer (BREAK-05)
  let defaultBreakOver6h = $state(30);
  let defaultBreakOver9h = $state(45);
  let breakDefaultsSaving = $state(false);
  let breakDefaultsSaved = $state(false);
  let breakDefaultsError = $state("");

  // Phase 47.3 / 49.4 — Verfügbarkeits-System Feature-Toggle
  let availabilityEnabled = $state(true);
  let availabilitySaving = $state(false);

  // Phase 67.2 (Plan 05) — Auto-Cleanup für Berufsschultag-Schichten Toggle
  let vocationalSchoolAutoCleanupShifts = $state(true);
  let vsAutoCleanupSaving = $state(false);

  // Phase 76.29 — Monatsabschluss mit Lücken (toggle) + Rückwirkende Einträge (number)
  let closeMonthWithGapsAllowed = $state(true);
  let closeMonthWithGapsSaving = $state(false);
  let retroEntryWindowDays = $state(10);
  let retroWindowSaving = $state(false);
  let retroWindowSaved = $state(false);
  let retroWindowError = $state("");

  // Phase 76.35 — Berufsschule Zeitgutschrift (bsSlot* TenantConfig overrides).
  // Empty string = inherited (no explicit tenant override); numeric string = explicit value.
  // Bounds mirror the server Zod schema (vocational-school-constants.ts):
  //   daily slots [240..600 min], block week [1200..3000 min].
  const BS_DAILY_MIN = 240;
  const BS_DAILY_MAX = 600;
  const BS_BLOCK_MIN = 1200;
  const BS_BLOCK_MAX = 3000;

  let bsSlotFirstLong = $state(""); // bsSlotFirstLongDayMinutes — "" = inherited
  let bsSlotSecondLong = $state(""); // bsSlotSecondLongDayMinutes
  let bsSlotShortDay = $state(""); // bsSlotShortDayMinutes
  let bsSlotBlockWeek = $state(""); // bsSlotBlockWeekMinutes

  let bsSlotSaving = $state(false);
  let bsSlotSaved = $state(false);
  let bsSlotError = $state("");
  let bsSlotWarnings = $state<string[]>([]);

  // Stunden-hints (derive from the raw input strings)
  let bsSlotFirstLongHint = $derived(
    bsSlotFirstLong !== "" && Number.isFinite(Number(bsSlotFirstLong))
      ? `= ${(Number(bsSlotFirstLong) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`
      : "",
  );
  let bsSlotSecondLongHint = $derived(
    bsSlotSecondLong !== "" && Number.isFinite(Number(bsSlotSecondLong))
      ? `= ${(Number(bsSlotSecondLong) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`
      : "",
  );
  let bsSlotShortDayHint = $derived(
    bsSlotShortDay !== "" && Number.isFinite(Number(bsSlotShortDay))
      ? `= ${(Number(bsSlotShortDay) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`
      : "",
  );
  let bsSlotBlockWeekHint = $derived(
    bsSlotBlockWeek !== "" && Number.isFinite(Number(bsSlotBlockWeek))
      ? `= ${(Number(bsSlotBlockWeek) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`
      : "",
  );

  // Phase 49.5 — Standard-Arbeitstage (Mo-Fr default)
  let defaultWorkDays = $state<number[]>([1, 2, 3, 4, 5]);
  let workDaysSaving = $state(false);
  let workDaysSaved = $state(false);
  let workDaysError = $state("");

  // Phase 49.2 — FLEXTIME Kernarbeitszeit-Defaults
  let defaultCoreStart = $state("");
  let defaultCoreEnd = $state("");
  let defaultCoreDays = $state<number[]>([]);
  let coreDefaultsSaving = $state(false);
  let coreDefaultsSaved = $state(false);
  let coreDefaultsError = $state("");

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

  onMount(async () => {
    try {
      const cfg = await api.get<TenantConfig>("/settings/work");
      gFederalState = cfg.federalState ?? "NIEDERSACHSEN";
      gTenantName = cfg.tenantName ?? "";
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
      monthlyHoursHolidayDeduction = cfg.monthlyHoursHolidayDeduction ?? false;
      // ArbZG § 4 — Auto-Pausen (moved from /admin/vacation in v1.6.5)
      autoBreakEnabled = cfg.autoBreakEnabled ?? false;
      defaultBreakStart = cfg.defaultBreakStart ?? "12:00";
      // Phase 65 — Hydrate tenant break defaults (defaults match Phase 64 BREAK-08 = ArbZG floor)
      defaultBreakOver6h = cfg.defaultBreakOver6h ?? 30;
      defaultBreakOver9h = cfg.defaultBreakOver9h ?? 45;
      // Phase 47.3 — Verfügbarkeits-System Feature-Toggle (default on)
      availabilityEnabled = cfg.availabilityEnabled ?? true;

      // Phase 67.2 (Plan 05) — load tenant-wide BS-Shift-Auto-Cleanup toggle
      vocationalSchoolAutoCleanupShifts = cfg.vocationalSchoolAutoCleanupShifts ?? true;
      // Phase 76.29 — Monatsabschluss mit Lücken + Rückwirkende Einträge
      closeMonthWithGapsAllowed = cfg.closeMonthWithGapsAllowed ?? true;
      retroEntryWindowDays = cfg.retroEntryWindowDays ?? 10;
      // Phase 76.35 — bsSlot* tenant overrides: null/undefined = inherited (empty string)
      bsSlotFirstLong =
        cfg.bsSlotFirstLongDayMinutes != null ? String(cfg.bsSlotFirstLongDayMinutes) : "";
      bsSlotSecondLong =
        cfg.bsSlotSecondLongDayMinutes != null ? String(cfg.bsSlotSecondLongDayMinutes) : "";
      bsSlotShortDay = cfg.bsSlotShortDayMinutes != null ? String(cfg.bsSlotShortDayMinutes) : "";
      bsSlotBlockWeek =
        cfg.bsSlotBlockWeekMinutes != null ? String(cfg.bsSlotBlockWeekMinutes) : "";
      // Phase 49.2 — FLEXTIME Kernarbeitszeit-Defaults
      defaultCoreStart = cfg.defaultCoreStart ?? "";
      defaultCoreEnd = cfg.defaultCoreEnd ?? "";
      defaultCoreDays = Array.isArray(cfg.defaultCoreDays) ? [...cfg.defaultCoreDays] : [];
      // Phase 49.5 — Standard-Arbeitstage
      defaultWorkDays =
        Array.isArray(cfg.defaultWorkDays) && cfg.defaultWorkDays.length > 0
          ? [...cfg.defaultWorkDays]
          : [1, 2, 3, 4, 5];
      // Phase 58 — Ladenöffnungszeiten (moved from /admin/shifts)
      storeHours = normalizeStoreHours(cfg.storeHours);
      shiftStoreHoursMode = cfg.shiftStoreHoursMode ?? "DAY_ONLY";

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
        tenantName: gTenantName,
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

  // saveDatev moved to /admin/export (Phase 58).

  async function saveHolidayDeduction() {
    if (!_gOtherFields) return; // guard: need full work-settings context to avoid partial overwrite
    holidayDeductionSaving = true;
    const newValue = !monthlyHoursHolidayDeduction; // capture desired state once
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        monthlyHoursHolidayDeduction: newValue,
      });
      monthlyHoursHolidayDeduction = newValue; // commit only after success
    } catch {
      // revert on error — state unchanged because we did not assign yet
    } finally {
      holidayDeductionSaving = false;
    }
  }

  // ArbZG § 4 — Auto-Pausen-Toggle (moved from /admin/vacation in v1.6.5).
  // When enabled, the time-entries pipeline deducts 30min (>6h) / 45min (>9h)
  // breaks on clock-out (apps/api/src/routes/time-entries.ts:400,641,909).
  async function toggleAutoBreak() {
    if (!_gOtherFields) return;
    autoBreakSaving = true;
    autoBreakError = "";
    autoBreakSaved = false;
    const newValue = !autoBreakEnabled;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        autoBreakEnabled: newValue,
        defaultBreakStart: newValue ? defaultBreakStart : null,
      });
      autoBreakEnabled = newValue;
      autoBreakSaved = true;
      setTimeout(() => (autoBreakSaved = false), 2500);
    } catch (e: unknown) {
      autoBreakError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      autoBreakSaving = false;
    }
  }

  async function saveDefaultBreakStart() {
    if (!_gOtherFields) return;
    if (!autoBreakEnabled) return; // No-op when toggle is off — field would be cleared anyway.
    if (!/^\d{2}:\d{2}$/.test(defaultBreakStart)) {
      autoBreakError = "Format HH:MM erwartet.";
      return;
    }
    autoBreakSaving = true;
    autoBreakError = "";
    autoBreakSaved = false;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        autoBreakEnabled: true,
        defaultBreakStart,
      });
      autoBreakSaved = true;
      setTimeout(() => (autoBreakSaved = false), 2500);
    } catch (e: unknown) {
      autoBreakError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      autoBreakSaving = false;
    }
  }

  // Phase 65 — Persist Tenant-Default Pausendauer (BREAK-05, mirrors saveDefaultBreakStart pattern)
  async function saveBreakDefaults() {
    if (!_gOtherFields) return;
    // Client-side native range check; server is authoritative (Phase 64 D-07)
    if (
      !Number.isFinite(defaultBreakOver6h) ||
      defaultBreakOver6h < 30 ||
      defaultBreakOver6h > 120
    ) {
      breakDefaultsError = "Pause >6h muss zwischen 30 und 120 Minuten liegen.";
      return;
    }
    if (
      !Number.isFinite(defaultBreakOver9h) ||
      defaultBreakOver9h < 45 ||
      defaultBreakOver9h > 180
    ) {
      breakDefaultsError = "Pause >9h muss zwischen 45 und 180 Minuten liegen.";
      return;
    }
    breakDefaultsSaving = true;
    breakDefaultsError = "";
    breakDefaultsSaved = false;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        autoBreakEnabled,
        defaultBreakStart: autoBreakEnabled ? defaultBreakStart : null,
        defaultBreakOver6h: Math.trunc(defaultBreakOver6h),
        defaultBreakOver9h: Math.trunc(defaultBreakOver9h),
      });
      breakDefaultsSaved = true;
      setTimeout(() => (breakDefaultsSaved = false), 2500);
    } catch (e: unknown) {
      // Server message is German + user-friendly (Phase 64 D-07) — surface verbatim
      breakDefaultsError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      breakDefaultsSaving = false;
    }
  }

  // Phase 47.3 / 49.4 — Tenant Feature-Toggle: Verfügbarkeits-System
  async function saveAvailabilityEnabled() {
    if (!_gOtherFields) return;
    availabilitySaving = true;
    const newValue = !availabilityEnabled;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        availabilityEnabled: newValue,
      });
      availabilityEnabled = newValue;
      tenantFeatures.applyLocal(newValue); // propagate to Sidebar + BottomTabBar
    } catch {
      // revert: state unchanged
    } finally {
      availabilitySaving = false;
    }
  }

  // Phase 67.2 (Plan 05) — Tenant Feature-Toggle: BS-Shift-Auto-Cleanup.
  // Mirrors saveAvailabilityEnabled exactly; the backend reads
  // TenantConfig.vocationalSchoolAutoCleanupShifts in shift-cleanup.ts.
  async function saveVocationalSchoolAutoCleanupShifts() {
    if (!_gOtherFields) return;
    vsAutoCleanupSaving = true;
    const newValue = !vocationalSchoolAutoCleanupShifts;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        vocationalSchoolAutoCleanupShifts: newValue,
      });
      vocationalSchoolAutoCleanupShifts = newValue;
    } catch {
      // revert: state unchanged — toggle bounces back since we never wrote the new value
    } finally {
      vsAutoCleanupSaving = false;
    }
  }

  // Phase 76.29 — Monatsabschluss mit Lücken toggle
  async function saveCloseMonthWithGaps() {
    if (!_gOtherFields) return;
    closeMonthWithGapsSaving = true;
    const newValue = !closeMonthWithGapsAllowed;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        closeMonthWithGapsAllowed: newValue,
      });
      closeMonthWithGapsAllowed = newValue;
      toasts.success("Einstellung gespeichert.");
    } catch {
      // revert: state unchanged — toggle bounces back since we never wrote
    } finally {
      closeMonthWithGapsSaving = false;
    }
  }

  // Phase 76.29 — Rückwirkende Einträge Selbstbearbeitungsfenster (onblur)
  async function saveRetroEntryWindowDays() {
    if (!_gOtherFields) return;
    retroWindowError = "";
    retroWindowSaved = false;
    const val = Math.trunc(retroEntryWindowDays);
    if (!Number.isFinite(val) || val < 1 || val > 90) {
      retroWindowError = "Bitte gib einen Wert zwischen 1 und 90 Tagen ein.";
      return;
    }
    retroWindowSaving = true;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        retroEntryWindowDays: val,
      });
      retroEntryWindowDays = val;
      retroWindowSaved = true;
      setTimeout(() => (retroWindowSaved = false), 2500);
    } catch (e: unknown) {
      retroWindowError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      retroWindowSaving = false;
    }
  }

  // Phase 76.35 — Berufsschule Zeitgutschrift speichern.
  // Client-side bounds mirror the server Zod schema (vocational-school-constants.ts).
  // An empty string field sends explicit null → clears the tenant override so resolution
  // delegates down to the per-employee daily-Soll fallback.
  async function saveBsSlots() {
    if (!_gOtherFields) return;
    bsSlotError = "";
    bsSlotSaved = false;
    bsSlotWarnings = [];

    // Client-side validation — only reject values that are outside bounds;
    // empty string is valid (means "inherit / clear override").
    const parseSlot = (
      raw: string,
      min: number,
      max: number,
      label: string,
    ): number | null | "error" => {
      if (raw === "") return null; // explicit null → clear override
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        bsSlotError = `${label}: Bitte eine ganze Zahl eingeben.`;
        return "error";
      }
      if (n < min || n > max) {
        bsSlotError = `${label}: Wert muss zwischen ${min} und ${max} Minuten liegen.`;
        return "error";
      }
      return n;
    };

    const v1 = parseSlot(bsSlotFirstLong, BS_DAILY_MIN, BS_DAILY_MAX, "1. Langtag");
    if (v1 === "error") return;
    const v2 = parseSlot(bsSlotSecondLong, BS_DAILY_MIN, BS_DAILY_MAX, "2. Langtag");
    if (v2 === "error") return;
    const v3 = parseSlot(bsSlotShortDay, BS_DAILY_MIN, BS_DAILY_MAX, "Kurztag");
    if (v3 === "error") return;
    const v4 = parseSlot(bsSlotBlockWeek, BS_BLOCK_MIN, BS_BLOCK_MAX, "Blockunterricht-Woche");
    if (v4 === "error") return;

    bsSlotSaving = true;
    try {
      const res = await api.put<{
        warnings?: string[];
        bsSlotFirstLongDayMinutes?: number | null;
        bsSlotSecondLongDayMinutes?: number | null;
        bsSlotShortDayMinutes?: number | null;
        bsSlotBlockWeekMinutes?: number | null;
      }>("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        bsSlotFirstLongDayMinutes: v1,
        bsSlotSecondLongDayMinutes: v2,
        bsSlotShortDayMinutes: v3,
        bsSlotBlockWeekMinutes: v4,
      });
      // Surface SC-3 over-crediting warnings (non-blocking)
      if (res.warnings && res.warnings.length > 0) {
        bsSlotWarnings = res.warnings;
      }
      bsSlotSaved = true;
      setTimeout(() => (bsSlotSaved = false), 3000);
    } catch (e: unknown) {
      bsSlotError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      bsSlotSaving = false;
    }
  }

  // Phase 49.5 — Standard-Arbeitstage speichern
  function toggleDefaultWorkDay(dow: number) {
    defaultWorkDays = defaultWorkDays.includes(dow)
      ? defaultWorkDays.filter((d) => d !== dow)
      : [...defaultWorkDays, dow].sort((a, b) => a - b);
  }

  async function saveDefaultWorkDays() {
    if (!_gOtherFields) return;
    workDaysError = "";
    workDaysSaved = false;
    if (defaultWorkDays.length === 0) {
      workDaysError = "Mindestens ein Arbeitstag muss aktiv sein.";
      return;
    }
    workDaysSaving = true;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        federalState: gFederalState,
        timezone: gTimezone,
        defaultWorkDays,
      });
      workDaysSaved = true;
      setTimeout(() => (workDaysSaved = false), 3000);
    } catch (e) {
      workDaysError = e instanceof Error ? e.message : "Fehler beim Speichern";
    } finally {
      workDaysSaving = false;
    }
  }

  async function saveCoreDefaults() {
    coreDefaultsSaving = true;
    coreDefaultsError = "";
    coreDefaultsSaved = false;
    try {
      await api.put("/settings/work", {
        defaultCoreStart: defaultCoreStart || null,
        defaultCoreEnd: defaultCoreEnd || null,
        defaultCoreDays,
      });
      coreDefaultsSaved = true;
      setTimeout(() => (coreDefaultsSaved = false), 3000);
    } catch (e: unknown) {
      coreDefaultsError = e instanceof Error ? e.message : "Fehler";
    } finally {
      coreDefaultsSaving = false;
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
</script>

<!-- Phase 73-05 (D-05): data-testid surface for admin-system flows.
     `display: contents` keeps SectionStack's layout intact while giving E2E
     specs a stable page-root selector + the active tab as data-attribute. -->
<div data-testid="admin-system-page" data-active-tab={activeTab} style="display: contents;">
  <SectionStack
    eyebrow="System"
    title="Allgemein"
    sub="Tenant-Einstellungen, Sicherheit & Benachrichtigungen"
    tabs={TABS}
    bind:activeTab
    animate
  >
    {#snippet tabContent(currentTab)}
      {#if loading}
        <div class="sys-loading-placeholder"></div>
      {:else if error}
        <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
      {:else if currentTab === "allgemein"}
        <!-- ── Erscheinungsbild ─────────────────────────────────────────────── -->
        <Section title="Erscheinungsbild" sub="Theme & Branding">
          <p class="sys-note">
            Theme, Modus und Dichte werden jetzt auf der eigenen Seite
            <a href="/admin/themes">Themes &amp; Branding</a> verwaltet.
          </p>
        </Section>

        <!-- ── Unternehmen & Region ─────────────────────────────────────────── -->
        <Section title="Unternehmen & Region" sub="Firmenname, Bundesland & Zeitzone">
          {#snippet footer()}
            <button
              class="btn btn-primary"
              onclick={saveFederalState}
              disabled={stateSaving}
              data-testid="admin-system-region-save"
            >
              {#if stateSaving}<Spinner />{/if}
              Speichern
            </button>
            {#if stateSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
          {/snippet}
          {#if stateError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{stateError}</span>
            </div>
          {/if}
          <div class="form-group" style="margin-bottom: 1rem;">
            <label class="form-label" for="g-tenant-name">Firmenname</label>
            <input
              id="g-tenant-name"
              type="text"
              bind:value={gTenantName}
              class="form-input"
              placeholder="Name des Unternehmens"
              data-testid="admin-system-region-tenantName"
            />
            <p class="form-hint text-muted">Wird in PDF-Exporten als Überschrift verwendet.</p>
          </div>
          <div class="inline-fields">
            <div class="form-group">
              <label class="form-label" for="g-federal-state">Bundesland</label>
              <select
                id="g-federal-state"
                bind:value={gFederalState}
                class="form-input federal-state-select"
                data-testid="admin-system-region-federalState"
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
        </Section>

        <!-- ── Ladenöffnungszeiten (Phase 58 — moved from /admin/shifts) ────── -->
        <Section
          title="Ladenöffnungszeiten"
          sub="Wochentägliche Öffnungs- und Schließzeiten. Schichtplanung warnt bei Konflikten."
        >
          {#snippet footer()}
            <button
              type="button"
              class="btn btn-primary sm"
              onclick={saveStoreHours}
              disabled={storeHoursSaving}
            >
              {storeHoursSaving ? "Speichern …" : "Öffnungszeiten speichern"}
            </button>
            {#if storeHoursMsg}
              <span class="cfg-muted cfg-msg">{storeHoursMsg}</span>
            {/if}
          {/snippet}

          <div class="cfg-table cfg-hours-table">
            <div class="cfg-row cfg-row--head cfg-row--hours">
              <div>Wochentag</div>
              <div>Geschlossen</div>
              <div>Öffnung</div>
              <div>Schließung</div>
            </div>
            {#each storeHours as h, idx (h.day)}
              <div class="cfg-row cfg-row--hours">
                <div class="cfg-cell-name">{DAY_NAMES_LONG[h.day]}</div>
                <div>
                  <input
                    id="hours-closed-{idx}"
                    type="checkbox"
                    checked={h.closed ?? false}
                    onchange={(e) =>
                      (storeHours[idx] = {
                        ...h,
                        closed: (e.currentTarget as HTMLInputElement).checked,
                      })}
                  />
                </div>
                <div>
                  <input
                    class="form-input"
                    type="time"
                    value={h.open}
                    disabled={h.closed ?? false}
                    onchange={(e) =>
                      (storeHours[idx] = {
                        ...h,
                        open: (e.currentTarget as HTMLInputElement).value,
                      })}
                  />
                </div>
                <div>
                  <input
                    class="form-input"
                    type="time"
                    value={h.close}
                    disabled={h.closed ?? false}
                    onchange={(e) =>
                      (storeHours[idx] = {
                        ...h,
                        close: (e.currentTarget as HTMLInputElement).value,
                      })}
                  />
                </div>
              </div>
            {/each}
          </div>

          <div class="cfg-section-title">Schicht-Zeiten an Öffnungszeiten binden</div>
          <div class="cfg-mode-options">
            <label class="cfg-mode-option">
              <input
                type="radio"
                name="shiftStoreHoursMode"
                value="DAY_ONLY"
                checked={shiftStoreHoursMode === "DAY_ONLY"}
                onchange={() => (shiftStoreHoursMode = "DAY_ONLY")}
              />
              <span>
                <strong>Nur geschlossene Tage blockieren</strong> (Standard) — Schichten dürfen vor Öffnung
                beginnen / nach Schließung enden (Vor- &amp; Nachbereitung). An geschlossenen Tagen ist
                keine Schicht möglich.
              </span>
            </label>
            <label class="cfg-mode-option">
              <input
                type="radio"
                name="shiftStoreHoursMode"
                value="STRICT"
                checked={shiftStoreHoursMode === "STRICT"}
                onchange={() => (shiftStoreHoursMode = "STRICT")}
              />
              <span>
                <strong>Strikt</strong> — Schichten müssen vollständig in den Öffnungszeiten liegen.
              </span>
            </label>
            <label class="cfg-mode-option">
              <input
                type="radio"
                name="shiftStoreHoursMode"
                value="OFF"
                checked={shiftStoreHoursMode === "OFF"}
                onchange={() => (shiftStoreHoursMode = "OFF")}
              />
              <span>
                <strong>Deaktiviert</strong> — keine Bindung an Öffnungszeiten.
              </span>
            </label>
          </div>
        </Section>

        <!-- ── Features (Phase 47.3 / 49.4) ─────────────────────────────────── -->
        <Section title="Features" sub="Tenant-weite Feature-Toggles">
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label">Verfügbarkeits-System aktiviert</span>
              <p class="form-hint text-muted">
                {#if availabilityEnabled}
                  Mitarbeiter pflegen ihre Verfügbarkeit selbst (Sidebar &amp; BottomTab zeigen
                  „Verfügbarkeit"). Auto-Generierung &amp; Woche-Kopieren respektieren „Nicht
                  verfügbar"; Manager können bei UNAVAILABLE per ConfirmDialog überschreiben (mit
                  Audit-Eintrag).
                {:else}
                  Deaktiviert. „Verfügbarkeit"-Navigation ist ausgeblendet, Resolver &amp; Auto-Gen
                  ignorieren EmployeeAvailability-Markierungen. Bereits angelegte
                  Verfügbarkeits-Daten bleiben in der DB erhalten.
                {/if}
              </p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                aria-label="Verfügbarkeits-System aktivieren"
                checked={availabilityEnabled}
                onchange={saveAvailabilityEnabled}
                disabled={availabilitySaving}
              />
              <span class="switch-slider"></span>
            </label>
          </div>

          <!-- Phase 67.2 (Plan 05) — Tenant-weiter Toggle für BS-Shift-Auto-Cleanup.
             Default ON: Generator entfernt künftige Shifts auf neuen BS-Tagen automatisch
             (Vergangenheit wird nur markiert). OFF: Shifts werden ausschließlich als
             Konflikt markiert, kein Auto-Soft-Delete. -->
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label"
                >Schichten auf Berufsschultagen automatisch entfernen</span
              >
              <p class="form-hint text-muted">
                {#if vocationalSchoolAutoCleanupShifts}
                  Aktiv: Wenn der Generator neue Berufsschultage anlegt, werden zukünftige Schichten
                  auf diesen Tagen automatisch entfernt (Soft-Delete, wiederherstellbar unter <a
                    href="/shifts/conflicts">/shifts/conflicts</a
                  >). Schichten in der Vergangenheit werden nur als Konflikt markiert.
                {:else}
                  Deaktiviert: Schichten auf neuen Berufsschultagen werden ausschließlich als
                  Konflikt markiert. Manuelle Bereinigung erforderlich.
                {/if}
              </p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                aria-label="BS-Shift-Auto-Cleanup aktivieren"
                checked={vocationalSchoolAutoCleanupShifts}
                onchange={saveVocationalSchoolAutoCleanupShifts}
                disabled={vsAutoCleanupSaving}
              />
              <span class="switch-slider"></span>
            </label>
          </div>

          <!-- Phase 49.5 — Standard-Arbeitstage/Woche (Anzahl) -->
          <div class="workdays-section">
            <div class="toggle-info" style="margin-bottom: 0.5rem;">
              <span class="toggle-row-label">Standard-Arbeitstage pro Woche</span>
              <p class="form-hint text-muted">
                Wie viele Arbeitstage hat eine Vollzeit-Woche bei euch? Unabhängig vom AZ-Modell —
                wird für Urlaubsverbrauch und Pro-Rata-Berechnung verwendet. Default-Reihenfolge
                Mo–Fr (Mo–Sa bei 6, Mo–So bei 7). Pro MA überschreibbar unter
                <a href="/admin/vacation">Urlaub &amp; Zeiten</a>.
              </p>
            </div>
            <div class="workdays-row" style="align-items: center;">
              <input
                type="number"
                min="1"
                max="7"
                step="1"
                class="form-input"
                style="max-width: 6rem;"
                aria-label="Anzahl Arbeitstage pro Woche"
                value={defaultWorkDays.length}
                oninput={(ev) => {
                  const n = Math.max(
                    1,
                    Math.min(7, Number((ev.target as HTMLInputElement).value) || 0),
                  );
                  const canonical = [1, 2, 3, 4, 5, 6, 0];
                  defaultWorkDays = canonical.slice(0, n).sort((a, b) => a - b);
                }}
              />
              <span class="form-hint" style="margin: 0;">Tage</span>
            </div>
            <div class="workdays-actions">
              <button
                class="btn btn-primary btn-sm"
                onclick={saveDefaultWorkDays}
                disabled={workDaysSaving || defaultWorkDays.length === 0}
              >
                {#if workDaysSaving}<Spinner />{/if}
                Speichern
              </button>
              {#if workDaysSaved}<span class="saved-hint">✓ Gespeichert</span>{/if}
              {#if workDaysError}<span class="error-hint">{workDaysError}</span>{/if}
            </div>
          </div>
        </Section>
      {:else if currentTab === "arbeitszeit"}
        <!-- ── Arbeitszeit ──────────────────────────────────────────────────── -->
        <Section title="Arbeitszeit" sub="Monatsstunden & Feiertagsabzug">
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label">Feiertage kürzen Monatsstunden-Soll</span>
              <p class="form-hint text-muted">
                Feiertage auf Arbeitstagen von Monatsstunden-Mitarbeitern reduzieren das
                Monats-Soll. Formel: Budget ÷ (Arbeitstage − Feiertage auf Arbeitstagen)
              </p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                aria-label="Feiertagsabzug für Monatsstunden aktivieren"
                checked={monthlyHoursHolidayDeduction}
                onchange={saveHolidayDeduction}
                disabled={holidayDeductionSaving}
              />
              <span class="switch-slider"></span>
            </label>
          </div>
        </Section>

        <!-- ── Automatische Pausen (§ 4 ArbZG) ──────────────────────────────── -->
        <Section
          title="Pausen automatisch abziehen"
          sub="Pflicht-Pausen nach § 4 ArbZG (>6h: 30 Min., >9h: 45 Min.)"
        >
          {#if autoBreakError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{autoBreakError}</span>
            </div>
          {/if}
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label">Pausen automatisch abziehen</span>
              <p class="form-hint text-muted">
                Beim Ausstempeln wird die gesetzliche Pflichtpause automatisch als Pausen-Eintrag
                angelegt und von der gestempelten Arbeitszeit abgezogen — 30 Min. ab 6h
                Bruttoarbeitszeit, 45 Min. ab 9h. Wirkt auf neue Einträge ab Aktivierung.
              </p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                aria-label="Pausen automatisch abziehen"
                checked={autoBreakEnabled}
                onchange={toggleAutoBreak}
                disabled={autoBreakSaving}
                data-testid="admin-system-pausendauer-autoBreakEnabled"
              />
              <span class="switch-slider"></span>
            </label>
          </div>
          {#if autoBreakEnabled}
            <div class="form-group" style="margin-top: 1rem;">
              <label class="form-label" for="sys-break-start">Standard-Pausenbeginn</label>
              <input
                id="sys-break-start"
                type="time"
                bind:value={defaultBreakStart}
                onchange={saveDefaultBreakStart}
                class="form-input modal-input-sm"
                disabled={autoBreakSaving}
              />
              <p class="form-hint text-muted">
                Vorgeschlagene Uhrzeit, ab der die automatische Pause gelegt wird. Liegt sie
                außerhalb des gestempelten Zeitraums, fällt das System auf die Tagesmitte zurück.
              </p>
            </div>
          {/if}
          <!-- Phase 65 — Tenant-Default Pausendauer (BREAK-05, D-01..D-03)
             Always visible (not gated on autoBreakEnabled): admins should
             be able to pre-configure the defaults so that turning Auto-Pause ON
             later picks them up. Each input is independently saved on blur. -->
          <div class="form-group" style="margin-top: 1rem;">
            <label class="form-label" for="sys-break-over6h">Pause &gt;6h (Min)</label>
            <input
              id="sys-break-over6h"
              type="number"
              min="30"
              max="120"
              step="1"
              bind:value={defaultBreakOver6h}
              onblur={saveBreakDefaults}
              class="form-input modal-input-sm"
              disabled={breakDefaultsSaving}
              data-testid="admin-system-pausendauer-over6h"
            />
            <p class="form-hint text-muted">ArbZG-Minimum: 30 Min</p>
          </div>
          <div class="form-group" style="margin-top: 1rem;">
            <label class="form-label" for="sys-break-over9h">Pause &gt;9h (Min)</label>
            <input
              id="sys-break-over9h"
              type="number"
              min="45"
              max="180"
              step="1"
              bind:value={defaultBreakOver9h}
              onblur={saveBreakDefaults}
              class="form-input modal-input-sm"
              disabled={breakDefaultsSaving}
              data-testid="admin-system-pausendauer-over9h"
            />
            <p class="form-hint text-muted">ArbZG-Minimum: 45 Min</p>
          </div>
          {#if breakDefaultsError}
            <div class="alert alert-error" role="alert" style="margin-top: 0.75rem;">
              <span>⚠</span><span>{breakDefaultsError}</span>
            </div>
          {/if}
          {#if breakDefaultsSaved}<span class="saved-hint">✓ Gespeichert</span>{/if}
          {#if autoBreakSaved}<span class="saved-hint">✓ Gespeichert</span>{/if}
        </Section>

        <!-- ── Kernarbeitszeit-Defaults (Gleitzeit) ─────────────────────────── -->
        <Section
          title="Kernarbeitszeit-Defaults (Gleitzeit)"
          sub="Standard-Kernzeit für neue Gleitzeit-Mitarbeiter"
        >
          {#snippet footer()}
            <button
              class="btn btn-primary"
              onclick={saveCoreDefaults}
              disabled={coreDefaultsSaving}
            >
              {coreDefaultsSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if coreDefaultsSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
          {/snippet}
          {#if coreDefaultsError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{coreDefaultsError}</span>
            </div>
          {/if}
          <p class="form-hint text-muted" style="margin-bottom: 1rem;">
            Standard-Kernarbeitszeit für neue Gleitzeit-Mitarbeiter. Beim Anlegen wird vorbelegt,
            kann pro Mitarbeiter überschrieben werden.
          </p>
          <div class="core-defaults-row">
            <div class="form-group">
              <label class="form-label" for="def-core-start">Kernzeitbeginn</label>
              <input
                id="def-core-start"
                type="time"
                bind:value={defaultCoreStart}
                class="form-input modal-input-sm"
                placeholder="—"
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="def-core-end">Kernzeitende</label>
              <input
                id="def-core-end"
                type="time"
                bind:value={defaultCoreEnd}
                class="form-input modal-input-sm"
                placeholder="—"
              />
            </div>
          </div>
          <div class="form-group" style="margin-top: 0.75rem;">
            <label class="form-label">Standard-Kernzeit-Tage</label>
            <div class="weekday-chips" role="group" aria-label="Standard-Kerntage">
              {#each [{ value: 1, label: "Mo" }, { value: 2, label: "Di" }, { value: 3, label: "Mi" }, { value: 4, label: "Do" }, { value: 5, label: "Fr" }, { value: 6, label: "Sa" }, { value: 0, label: "So" }] as day (day.value)}
                <button
                  type="button"
                  class="wd-chip"
                  class:wd-chip--active={defaultCoreDays.includes(day.value)}
                  onclick={() => {
                    if (defaultCoreDays.includes(day.value)) {
                      defaultCoreDays = defaultCoreDays.filter((d) => d !== day.value);
                    } else {
                      defaultCoreDays = [...defaultCoreDays, day.value];
                    }
                  }}>{day.label}</button
                >
              {/each}
            </div>
            <p class="form-hint text-muted">
              Leer lassen für keine Tenant-Defaults (Gleitzeit-MA starten ohne Kernzeit-Vorauswahl).
            </p>
          </div>
        </Section>

        <!-- ── Monatsabschluss mit Lücken (Phase 76.29 CFG-01) ───────────────── -->
        <Section
          title="Monatsabschluss mit Lücken"
          sub="Erlaubt den Abschluss von Monaten mit fehlenden Zeiteinträgen"
        >
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label">Abschluss trotz fehlender Einträge erlauben</span>
              <p class="form-hint text-muted">
                Wenn aktiviert, können Monate auch dann abgeschlossen werden, wenn Arbeitstage ohne
                Zeiterfassung vorliegen. Fehlende Tage werden als 0h gegen das volle Soll gewertet.
              </p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                aria-label="Monatsabschluss mit Lücken erlauben"
                checked={closeMonthWithGapsAllowed}
                onchange={saveCloseMonthWithGaps}
                disabled={closeMonthWithGapsSaving}
                data-testid="admin-system-arbeitszeit-closeMonthWithGapsAllowed"
              />
              <span class="switch-slider"></span>
            </label>
          </div>
        </Section>

        <!-- ── Rückwirkende Einträge — Selbstbearbeitungsfenster (Phase 76.29) ── -->
        <Section
          title="Rückwirkende Einträge"
          sub="Frist für eigenständige Bearbeitung vergangener Zeiteinträge"
        >
          {#if retroWindowError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{retroWindowError}</span>
            </div>
          {/if}
          <div class="form-group">
            <label class="form-label" for="sys-retro-window">Selbstbearbeitungsfenster (Tage)</label
            >
            <input
              id="sys-retro-window"
              type="number"
              min="1"
              max="90"
              step="1"
              bind:value={retroEntryWindowDays}
              onblur={saveRetroEntryWindowDays}
              class="form-input modal-input-sm"
              disabled={retroWindowSaving}
              data-testid="admin-system-arbeitszeit-retroEntryWindowDays"
            />
            <p class="form-hint text-muted">
              Mitarbeiter können Einträge bis zu N Tage rückwirkend selbst bearbeiten. Ältere
              Einträge erfordern einen Antrag mit Genehmigung durch einen Manager. Gesetzlicher
              Referenzwert (ArbZG-Referentenentwurf 2023): 7 Tage. Standard: 10 Tage.
            </p>
          </div>
          {#if retroWindowSaved}
            <span class="saved-hint">✓ Gespeichert</span>
          {/if}
        </Section>
        <!-- ── Berufsschule — Zeitgutschrift (Phase 76.35) ─────────────────── -->
        <Section
          title="Berufsschule — Zeitgutschrift"
          sub="Tenant-weite Zeitgutschrift-Slots für Berufsschultage (§ 15 Abs. 2 BBiG)"
        >
          {#snippet footer()}
            <button
              class="btn btn-primary"
              onclick={saveBsSlots}
              disabled={bsSlotSaving}
              data-testid="admin-system-bsslot-save"
            >
              {#if bsSlotSaving}<Spinner />{/if}
              Speichern
            </button>
            {#if bsSlotSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
            <div class="alert alert-info bs-revision-alert" role="alert">
              <span>ℹ</span><span>Änderungen wirken nur auf offene und künftige Monate.</span>
            </div>
          {/snippet}

          <p class="form-hint text-muted" style="margin-bottom: 1.25rem;">
            Überschreibt den systemweiten Fallback für alle Mitarbeitenden dieses Mandanten. Leer
            lassen = Wert wird vom Tages-Soll des Mitarbeiters geerbt (kein expliziter
            Tenant-Override). Tages-Slots: 240–600 Min (4–10 h). Blockunterricht-Woche: 1200–3000
            Min (20–50 h).
          </p>

          {#if bsSlotError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{bsSlotError}</span>
            </div>
          {/if}

          {#if bsSlotWarnings.length > 0}
            {#each bsSlotWarnings as w (w)}
              <div class="alert alert-warning" role="alert" style="margin-bottom: 0.75rem;">
                <span>⚠</span><span>{w}</span>
              </div>
            {/each}
          {/if}

          <!-- 1. Langtag -->
          <div class="form-group bs-slot-group">
            <label class="form-label" for="bs-slot-first-long">
              1. Berufsschul-Langtag (Minuten)
            </label>
            <div class="bs-slot-input-row">
              <input
                id="bs-slot-first-long"
                type="number"
                min={BS_DAILY_MIN}
                max={BS_DAILY_MAX}
                step="1"
                class="form-input modal-input-sm"
                bind:value={bsSlotFirstLong}
                placeholder="Erbt aus: Tages-Soll"
                data-testid="admin-system-bsslot-firstLong"
              />
              {#if bsSlotFirstLongHint}
                <span class="bs-slot-hint">{bsSlotFirstLongHint}</span>
              {/if}
              {#if bsSlotFirstLong !== ""}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm bs-clear-btn"
                  onclick={() => (bsSlotFirstLong = "")}
                  title="Auf Vorgabe zurücksetzen"
                  aria-label="1. Langtag auf Vorgabe zurücksetzen"
                >
                  × Erben
                </button>
              {/if}
            </div>
            {#if bsSlotFirstLong === ""}
              <p class="form-hint text-muted">Erbt aus: Tages-Soll des Mitarbeiters</p>
            {/if}
          </div>

          <!-- 2. Langtag -->
          <div class="form-group bs-slot-group">
            <label class="form-label" for="bs-slot-second-long">
              2. Berufsschul-Langtag (Minuten)
            </label>
            <div class="bs-slot-input-row">
              <input
                id="bs-slot-second-long"
                type="number"
                min={BS_DAILY_MIN}
                max={BS_DAILY_MAX}
                step="1"
                class="form-input modal-input-sm"
                bind:value={bsSlotSecondLong}
                placeholder="Erbt aus: Tages-Soll"
                data-testid="admin-system-bsslot-secondLong"
              />
              {#if bsSlotSecondLongHint}
                <span class="bs-slot-hint">{bsSlotSecondLongHint}</span>
              {/if}
              {#if bsSlotSecondLong !== ""}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm bs-clear-btn"
                  onclick={() => (bsSlotSecondLong = "")}
                  title="Auf Vorgabe zurücksetzen"
                  aria-label="2. Langtag auf Vorgabe zurücksetzen"
                >
                  × Erben
                </button>
              {/if}
            </div>
            {#if bsSlotSecondLong === ""}
              <p class="form-hint text-muted">Erbt aus: Tages-Soll des Mitarbeiters</p>
            {/if}
          </div>

          <!-- Kurztag -->
          <div class="form-group bs-slot-group">
            <label class="form-label" for="bs-slot-short-day">
              Berufsschul-Kurztag (Minuten)
            </label>
            <div class="bs-slot-input-row">
              <input
                id="bs-slot-short-day"
                type="number"
                min={BS_DAILY_MIN}
                max={BS_DAILY_MAX}
                step="1"
                class="form-input modal-input-sm"
                bind:value={bsSlotShortDay}
                placeholder="Erbt aus: Tages-Soll"
                data-testid="admin-system-bsslot-shortDay"
              />
              {#if bsSlotShortDayHint}
                <span class="bs-slot-hint">{bsSlotShortDayHint}</span>
              {/if}
              {#if bsSlotShortDay !== ""}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm bs-clear-btn"
                  onclick={() => (bsSlotShortDay = "")}
                  title="Auf Vorgabe zurücksetzen"
                  aria-label="Kurztag auf Vorgabe zurücksetzen"
                >
                  × Erben
                </button>
              {/if}
            </div>
            {#if bsSlotShortDay === ""}
              <p class="form-hint text-muted">Erbt aus: Tages-Soll des Mitarbeiters</p>
            {/if}
          </div>

          <!-- Blockunterricht-Woche -->
          <div class="form-group bs-slot-group">
            <label class="form-label" for="bs-slot-block-week">
              Blockunterricht-Woche (Minuten)
            </label>
            <div class="bs-slot-input-row">
              <input
                id="bs-slot-block-week"
                type="number"
                min={BS_BLOCK_MIN}
                max={BS_BLOCK_MAX}
                step="1"
                class="form-input modal-input-sm"
                bind:value={bsSlotBlockWeek}
                placeholder="Erbt aus: Wochenstunden-Soll"
                data-testid="admin-system-bsslot-blockWeek"
              />
              {#if bsSlotBlockWeekHint}
                <span class="bs-slot-hint">{bsSlotBlockWeekHint}</span>
              {/if}
              {#if bsSlotBlockWeek !== ""}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm bs-clear-btn"
                  onclick={() => (bsSlotBlockWeek = "")}
                  title="Auf Vorgabe zurücksetzen"
                  aria-label="Blockunterricht-Woche auf Vorgabe zurücksetzen"
                >
                  × Erben
                </button>
              {/if}
            </div>
            {#if bsSlotBlockWeek === ""}
              <p class="form-hint text-muted">Erbt aus: Wochenstunden-Soll des Mitarbeiters</p>
            {/if}
          </div>
        </Section>
      {:else if currentTab === "sicherheit"}
        <!-- ── Sicherheit / 2FA ─────────────────────────────────────────────── -->
        <Section title="Sicherheit" sub="Zwei-Faktor-Authentifizierung">
          {#if twoFaError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
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
                data-testid="admin-system-sicherheit-twoFaEnabled"
              />
              <span class="switch-slider"></span>
            </label>
          </div>
        </Section>

        <!-- ── Session-Management ───────────────────────────────────────────── -->
        <Section title="Session-Management" sub="Timeouts & Sperrzeiten">
          {#if sessionError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{sessionError}</span>
            </div>
          {/if}

          <div class="opt-stack">
            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="session-timeout">Inaktivitäts-Timeout</label>
                <p class="opt-hint">0 = deaktiviert. Benutzer wird nach Inaktivität ausgeloggt.</p>
              </div>
              <div class="opt-control">
                <input
                  id="session-timeout"
                  type="number"
                  min="0"
                  max="480"
                  bind:value={sessionTimeoutMinutes}
                  class="form-input opt-input-num"
                />
                <span class="opt-unit">Min.</span>
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="refresh-days">Session-Dauer</label>
                <p class="opt-hint">Wie lange ein Login ohne „Angemeldet bleiben" gültig ist.</p>
              </div>
              <div class="opt-control">
                <input
                  id="refresh-days"
                  type="number"
                  min="1"
                  max="90"
                  bind:value={refreshTokenDays}
                  class="form-input opt-input-num"
                />
                <span class="opt-unit">Tage</span>
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">„Angemeldet bleiben" erlauben</span>
                <p class="opt-hint">
                  Benutzer können beim Login angemeldet bleiben über mehrere Sitzungen hinweg.
                </p>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="„Angemeldet bleiben&quot; erlauben"
                  bind:checked={rememberMeEnabled}
                />
                <span class="switch-slider"></span>
              </label>
            </div>

            {#if rememberMeEnabled}
              <div class="opt-row opt-row--nested">
                <div class="opt-info">
                  <label class="opt-label" for="remember-days">„Angemeldet bleiben" Dauer</label>
                  <p class="opt-hint">Maximale Geltungsdauer der „Angemeldet bleiben"-Sitzung.</p>
                </div>
                <div class="opt-control">
                  <input
                    id="remember-days"
                    type="number"
                    min="1"
                    max="365"
                    bind:value={rememberMeDays}
                    class="form-input opt-input-num"
                  />
                  <span class="opt-unit">Tage</span>
                </div>
              </div>
            {/if}

            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="max-sessions">Max. gleichzeitige Sessions</label>
                <p class="opt-hint">
                  0 = unbegrenzt. Älteste Session wird bei Überschreitung beendet.
                </p>
              </div>
              <div class="opt-control">
                <input
                  id="max-sessions"
                  type="number"
                  min="0"
                  max="20"
                  bind:value={maxSessionsPerUser}
                  class="form-input opt-input-num"
                />
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="login-max-attempts"
                  >Max. Fehlversuche bis Sperre</label
                >
                <p class="opt-hint">
                  Anzahl falscher Login-Versuche bis das Konto temporär gesperrt wird.
                </p>
              </div>
              <div class="opt-control">
                <input
                  id="login-max-attempts"
                  type="number"
                  min="1"
                  max="20"
                  bind:value={loginMaxAttempts}
                  class="form-input opt-input-num"
                />
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="login-lockout-min">Sperrzeit nach Fehlversuchen</label
                >
                <p class="opt-hint">
                  Nach Ablauf wird der Zähler zurückgesetzt. Admin kann manuell entsperren.
                </p>
              </div>
              <div class="opt-control">
                <input
                  id="login-lockout-min"
                  type="number"
                  min="1"
                  max="1440"
                  bind:value={loginLockoutMinutes}
                  class="form-input opt-input-num"
                />
                <span class="opt-unit">Min.</span>
              </div>
            </div>
          </div>

          {#snippet footer()}
            <button
              class="btn btn-primary"
              onclick={saveSessionConfig}
              disabled={sessionSaving}
              data-testid="admin-system-session-save"
            >
              {sessionSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if sessionSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
          {/snippet}
        </Section>

        <!-- ── Passwort-Richtlinie ──────────────────────────────────────────── -->
        <Section title="Passwort-Richtlinie" sub="BSI-konforme Komplexitätsregeln">
          {#if pwError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{pwError}</span>
            </div>
          {/if}

          <div class="opt-stack">
            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="pw-min-length">Mindestlänge</label>
                <p class="opt-hint">BSI empfiehlt mindestens 12 Zeichen.</p>
              </div>
              <div class="opt-control">
                <input
                  id="pw-min-length"
                  type="number"
                  min="8"
                  max="128"
                  bind:value={pwMinLength}
                  class="form-input opt-input-num"
                  data-testid="admin-system-password-minLength"
                />
                <span class="opt-unit">Zeichen</span>
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">Großbuchstabe erforderlich</span>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="Großbuchstabe erforderlich"
                  bind:checked={pwRequireUpper}
                />
                <span class="switch-slider"></span>
              </label>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">Kleinbuchstabe erforderlich</span>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="Kleinbuchstabe erforderlich"
                  bind:checked={pwRequireLower}
                />
                <span class="switch-slider"></span>
              </label>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">Ziffer erforderlich</span>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="Ziffer erforderlich"
                  bind:checked={pwRequireDigit}
                />
                <span class="switch-slider"></span>
              </label>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">Sonderzeichen erforderlich</span>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="Sonderzeichen erforderlich"
                  bind:checked={pwRequireSpecial}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
          </div>

          {#snippet footer()}
            <button
              class="btn btn-primary"
              onclick={savePasswordPolicy}
              disabled={pwSaving}
              data-testid="admin-system-password-save"
            >
              {pwSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if pwSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
          {/snippet}
        </Section>
      {:else if currentTab === "kommunikation"}
        <!-- ── E-Mail-Benachrichtigungen ────────────────────────────────────── -->
        <Section title="E-Mail-Benachrichtigungen" sub="Welche Ereignisse per E-Mail melden">
          {#if emailError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{emailError}</span>
            </div>
          {/if}
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label">E-Mail-Benachrichtigungen aktivieren</span>
              <p class="form-hint text-muted">
                Sendet zusätzlich zur In-App-Benachrichtigung eine E-Mail. SMTP muss konfiguriert
                sein.
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
            <h4 class="sys-subtitle" style="margin-top: 1rem;">Benachrichtigungstypen</h4>
            <div class="toggle-row">
              <span class="toggle-row-label">Neuer Urlaubsantrag</span>
              <label class="switch">
                <input
                  type="checkbox"
                  aria-label="Benachrichtigung: Neuer Urlaubsantrag"
                  bind:checked={emailOnLeaveRequest}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
            <div class="toggle-row">
              <span class="toggle-row-label">Urlaub genehmigt / abgelehnt</span>
              <label class="switch">
                <input
                  type="checkbox"
                  aria-label="Benachrichtigung: Urlaub genehmigt / abgelehnt"
                  bind:checked={emailOnLeaveDecision}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
            <div class="toggle-row">
              <span class="toggle-row-label">Überstunden-Warnung</span>
              <label class="switch">
                <input
                  type="checkbox"
                  aria-label="Benachrichtigung: Überstunden-Warnung"
                  bind:checked={emailOnOvertimeWarning}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
            <div class="toggle-row">
              <span class="toggle-row-label">Fehlende Zeiteinträge</span>
              <label class="switch">
                <input
                  type="checkbox"
                  aria-label="Benachrichtigung: Fehlende Zeiteinträge"
                  bind:checked={emailOnMissingEntries}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
            <div class="toggle-row">
              <span class="toggle-row-label">Vergessene Stempelung</span>
              <label class="switch">
                <input
                  type="checkbox"
                  aria-label="Benachrichtigung: Vergessene Stempelung"
                  bind:checked={emailOnClockOutReminder}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
            <div class="toggle-row">
              <span class="toggle-row-label" translate="no">Monatsabschluss</span>
              <label class="switch">
                <input
                  type="checkbox"
                  aria-label="Benachrichtigung: Monatsabschluss"
                  bind:checked={emailOnMonthClose}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
          {/if}
          {#snippet footer()}
            <button class="btn btn-primary" onclick={saveEmailConfig} disabled={emailSaving}>
              {emailSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if emailSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
          {/snippet}
        </Section>

        <!-- ── E-Mail / SMTP ────────────────────────────────────────────────── -->
        <Section title="E-Mail / SMTP" sub="Postausgangsserver konfigurieren">
          {#if smtpError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{smtpError}</span>
            </div>
          {/if}
          {#if smtpSaved}
            <div class="alert alert-success" role="alert" style="margin-bottom: 1rem;">
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

          {#snippet footer()}
            <button class="btn btn-primary" onclick={saveSmtp} disabled={smtpSaving}>
              {smtpSaving ? "Speichern…" : "SMTP speichern"}
            </button>
          {/snippet}

          <div class="smtp-test-section">
            <span class="form-label">Testmail senden</span>
            <div class="smtp-test-row">
              <input
                type="email"
                bind:value={smtpTestEmail}
                class="form-input"
                placeholder="test@example.com"
                style="max-width: 280px;"
              />
              <button
                class="btn btn-ghost"
                onclick={testSmtp}
                disabled={smtpTesting || !smtpTestEmail}
              >
                {smtpTesting ? "Senden…" : "Testmail senden"}
              </button>
            </div>
            {#if smtpTestResult}
              <p class="smtp-test-success">✓ {smtpTestResult}</p>
            {/if}
            {#if smtpTestError}
              <p class="smtp-test-error">⚠ {smtpTestError}</p>
            {/if}
          </div>
        </Section>
      {:else if currentTab === "integration"}
        <!-- ── NFC-Terminals ────────────────────────────────────────────────── -->
        <Section title="NFC-Terminals" sub="API-Schlüssel für stationäre Geräte">
          {#if showNewKey}
            <div class="alert alert-success" style="margin-bottom: 1rem;">
              <div>
                <strong>Neuer Schlüssel erstellt!</strong>
                <p style="margin: 0.5rem 0;">
                  Kopieren Sie den Schlüssel jetzt — er wird nicht erneut angezeigt:
                </p>
                <div class="key-display">
                  <code class="key-code">{newKeyRaw}</code>
                  <button class="btn btn-ghost btn-sm" onclick={() => copyToClipboard(newKeyRaw)}
                    >Kopieren</button
                  >
                </div>
                <button
                  class="btn btn-ghost btn-sm"
                  style="margin-top: 0.5rem;"
                  onclick={() => {
                    showNewKey = false;
                    newKeyRaw = "";
                  }}>Schließen</button
                >
              </div>
            </div>
          {/if}

          <div class="inline-create">
            <input
              type="text"
              class="form-input"
              bind:value={newKeyName}
              placeholder="Terminal-Name (z.B. Kasse 1)"
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
                      <td><code class="inline-code">{key.keyPrefix}</code></td>
                      <td
                        >{key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleString("de-DE")
                          : "Nie"}</td
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
                            class="btn btn-sm btn-ghost btn-danger-ghost"
                            onclick={() => revokeTerminalKey(key.id)}>Widerrufen</button
                          >
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <Pagination
                total={terminalKeys.length}
                bind:page={tkPage}
                bind:pageSize={tkPageSize}
              />
            </div>
          {:else}
            <p class="text-muted">Keine Terminal-Schlüssel vorhanden.</p>
          {/if}
        </Section>

        <!-- ── API Keys ─────────────────────────────────────────────────────── -->
        <Section title="API Keys" sub="Schlüssel für externe Integrationen">
          {#if showNewApiKey}
            <div class="alert alert-success" style="margin-bottom: 1rem;">
              <div>
                <strong>API Key erstellt!</strong>
                <p style="margin: 0.5rem 0;">
                  Kopieren Sie den Schlüssel jetzt — er wird nicht erneut angezeigt:
                </p>
                <div class="key-display">
                  <code class="key-code">{newApiKeyRaw}</code>
                  <button
                    class="btn btn-ghost btn-sm"
                    onclick={() => navigator.clipboard.writeText(newApiKeyRaw)}>Kopieren</button
                  >
                </div>
                <button
                  class="btn btn-ghost btn-sm"
                  style="margin-top: 0.5rem;"
                  onclick={() => {
                    showNewApiKey = false;
                    newApiKeyRaw = "";
                  }}>Schließen</button
                >
              </div>
            </div>
          {/if}

          <div class="api-key-create">
            <div class="inline-create">
              <input
                type="text"
                class="form-input"
                bind:value={newApiKeyName}
                placeholder="Name (z.B. DATEV Export)"
              />
              <button
                class="btn btn-primary"
                onclick={createApiKey}
                disabled={apiKeyLoading || !newApiKeyName.trim() || newApiKeyScopes.length === 0}
              >
                Key erstellen
              </button>
            </div>
            <div class="scope-chips">
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
                  <tr
                    ><th>Name</th><th>Prefix</th><th>Scopes</th><th>Letzter Zugriff</th><th
                    ></th></tr
                  >
                </thead>
                <tbody>
                  {#each pagedApiKeys as key (key.id)}
                    <tr class:row-revoked={!!key.revokedAt}>
                      <td>{key.name}</td>
                      <td><code class="inline-code">{key.keyPrefix}…</code></td>
                      <td class="scope-cell">{key.scopes.join(", ")}</td>
                      <td>
                        {key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleDateString("de-DE")
                          : "Nie"}
                      </td>
                      <td>
                        {#if !key.revokedAt}
                          <button
                            class="btn btn-sm btn-ghost btn-danger-ghost"
                            onclick={() => revokeApiKey(key.id)}>Widerrufen</button
                          >
                        {:else}
                          <span class="text-muted revoked-label">Widerrufen</span>
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
        </Section>
      {/if}
    {/snippet}
  </SectionStack>
</div>

<style>
  /* Loading placeholder while settings are fetching */
  .sys-loading-placeholder {
    height: 220px;
  }

  .settings-actions--end {
    justify-content: flex-end;
  }

  .sys-note {
    font-size: 0.875rem;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }
  .sys-note a {
    color: var(--brand);
    text-decoration: underline;
  }
  .sys-note a:hover {
    color: var(--brand-dark);
  }

  .sys-subtitle {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 1rem 0 0.5rem;
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

  .core-defaults-row {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    align-items: flex-start;
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
    color: var(--text);
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
    background-color: var(--border);
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
    background-color: var(--bg-card);
    border-radius: 50%;
    transition: transform 0.2s;
    box-shadow: var(--shadow-sm);
  }
  .switch input:checked + .switch-slider {
    background-color: var(--brand);
  }
  .switch input:checked + .switch-slider::before {
    transform: translateX(22px);
  }

  .smtp-test-section {
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
  }
  .smtp-test-success {
    color: var(--good);
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }
  .smtp-test-error {
    color: var(--bad);
    margin-top: 0.5rem;
    font-size: 0.875rem;
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
    background: var(--good-soft);
    color: var(--good);
    padding: 0.1rem 0.4rem;
    border-radius: var(--r-sm);
    margin-left: 0.5rem;
    vertical-align: middle;
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

  .saved-hint {
    color: var(--good);
    font-weight: 500;
    font-size: 0.9375rem;
  }
  .error-hint {
    color: var(--bad);
    font-size: 0.9375rem;
  }

  /* Phase 49.5 — Standard-Arbeitstage UI */
  .workdays-section {
    border-top: 1px solid var(--border);
    margin-top: 1rem;
    padding-top: 1rem;
  }
  .workdays-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }
  .workday-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    padding: 0.4rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--bg-card);
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.875rem;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
  }
  .workday-chip:hover {
    border-color: var(--brand);
  }
  .workday-chip--active {
    background: var(--brand-soft);
    border-color: var(--brand);
    color: var(--brand);
  }
  .workday-chip input {
    display: none;
  }
  .workdays-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* Weekday chip selector (shared between vacation modal and core-defaults section) */
  .weekday-chips {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-top: 0.375rem;
    margin-bottom: 0.375rem;
  }

  .wd-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.5rem;
    height: 2rem;
    padding: 0 0.625rem;
    border-radius: var(--r-pill);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s,
      border-color 0.15s;
    border: 1.5px solid var(--border);
    background: transparent;
    color: var(--text-muted);
  }

  .wd-chip--active {
    background: var(--brand);
    border-color: var(--brand);
    color: #fff;
  }

  .wd-chip:hover:not(.wd-chip--active) {
    border-color: var(--brand);
    color: var(--brand);
  }

  .modal-input-sm {
    max-width: 180px;
  }

  .federal-state-select {
    min-width: 220px;
  }

  .row-revoked {
    opacity: 0.5;
  }

  .table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* ── Option stack — one option per row, label/hint left, control right.
     Used by Sicherheit / Session-Management / Passwort-Richtlinie to avoid
     the chaotic mix of 2-column form-grids and stacked toggle-rows. ───── */
  .opt-stack {
    display: flex;
    flex-direction: column;
  }
  .opt-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--border);
  }
  .opt-row:last-child {
    border-bottom: none;
  }
  .opt-row--nested {
    padding-left: 1.25rem;
    border-left: 2px solid var(--brand-soft);
    margin-left: 0.25rem;
  }
  .opt-info {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .opt-label {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text);
    line-height: 1.4;
  }
  .opt-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }
  .opt-control {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .opt-control-switch {
    flex-shrink: 0;
  }
  .opt-input-num {
    width: 96px;
    text-align: right;
  }
  .opt-unit {
    font-size: 0.8125rem;
    color: var(--text-muted);
    min-width: 36px;
  }

  @media (max-width: 640px) {
    .opt-row {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }
    .opt-control {
      justify-content: flex-end;
    }
  }

  /* ── Ladenöffnungszeiten (Phase 58 — copied from shifts page CSS) ──────── */
  .cfg-table {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 14px 0;
  }
  .cfg-row {
    display: grid;
    grid-template-columns: 1.5fr 0.8fr 1fr 1fr;
    align-items: center;
    gap: 12px;
    padding: 8px 4px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }
  .cfg-row--head {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border);
  }
  .cfg-row:last-child {
    border-bottom: none;
  }
  .cfg-cell-name {
    font-weight: 600;
    color: var(--text);
  }
  .cfg-muted {
    color: var(--text-muted);
    font-size: 13.5px;
  }
  .cfg-msg {
    font-style: italic;
  }
  .cfg-section-title {
    margin: 24px 0 8px;
    font-weight: 600;
    font-size: 0.9375rem;
    color: var(--text);
  }
  .cfg-mode-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }
  .cfg-mode-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-card);
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text);
    transition: border-color 0.12s var(--ease);
  }
  .cfg-mode-option:hover {
    border-color: var(--brand);
  }
  .cfg-mode-option input {
    margin-top: 2px;
  }
  .cfg-mode-option strong {
    color: var(--text);
  }

  /* Inline create row (NFC/API key creation) */
  .inline-create {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .inline-create .form-input {
    flex: 1;
  }

  /* Key display (after creation, shown once) */
  .key-display {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .key-code {
    flex: 1;
    padding: 0.5rem;
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    word-break: break-all;
    font-size: 0.8125rem;
    font-family: var(--font-mono);
    color: var(--text);
  }
  .inline-code {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--text);
  }

  /* API key scope chips */
  .api-key-create {
    margin-bottom: 1rem;
  }
  .scope-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .scope-cell {
    font-size: 0.75rem;
  }
  .revoked-label {
    font-size: 0.75rem;
  }

  /* Danger ghost button: ghost styling with --bad color */
  .btn-danger-ghost {
    color: var(--bad);
  }

  @media (max-width: 640px) {
    .smtp-grid {
      grid-template-columns: 1fr;
    }

    .inline-fields {
      flex-direction: column;
      gap: 1rem;
    }

    .inline-create {
      flex-direction: column;
    }
  }

  /* ── Berufsschule Zeitgutschrift (Phase 76.35) ──────────────────────────── */
  .bs-slot-group {
    margin-bottom: 1.25rem;
  }

  .bs-slot-input-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
  }

  .bs-slot-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .bs-clear-btn {
    font-size: 0.8125rem;
    color: var(--text-muted);
    padding: 0.25rem 0.625rem;
    min-height: unset;
    height: 2rem;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: transparent;
    cursor: pointer;
    transition:
      color 0.12s var(--ease),
      border-color 0.12s var(--ease);
  }

  .bs-clear-btn:hover {
    color: var(--bad);
    border-color: var(--bad);
  }

  .bs-revision-alert {
    margin-top: 0.75rem;
    width: 100%;
  }
</style>
