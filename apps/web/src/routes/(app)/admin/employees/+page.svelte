<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { employeeAdminRights, salonAdminRights } from "$lib/page-rights";
  import { api } from "$api/client";
  import { salonContext } from "$stores/salon-context";
  import {
    createRoleAssignment,
    listAssignablePeople,
    listRoleAssignments,
    loadAssignmentChoices,
    type AccessRole,
    type AssignablePerson,
    type AssignmentDraft,
    type AssignmentScope,
    type RoleAssignment,
  } from "$lib/api/roles";
  import PersonRoleAssignments from "$lib/components/admin/roles/PersonRoleAssignments.svelte";
  import {
    berechtigungenTabHref,
    draftFailureMessage,
    draftLabel,
    draftsSavedMessage,
    postAssignmentDrafts,
  } from "$lib/roles/assignment-drafts";
  import { toasts } from "$stores/toast";
  import { hasPermission } from "$lib/permissions";
  import {
    CREATE_DEFAULT_ROLE_NAME,
    NO_ASSIGNMENT_LABEL,
    assignedRoleNames,
    assignmentLabel,
    groupAssignmentsByUser,
  } from "$lib/roles/assignment-label";
  import {
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    withSalonId,
  } from "$lib/salons/page-scope";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import DataTable, {
    type DataTableColumn,
    type DataTableSort,
  } from "$components/ui/DataTable.svelte";
  import { urlState } from "$lib/table/url-state";
  import { downloadCsv, rowsToCsv } from "$lib/table/csv-export";
  import {
    alreadyHoldsAssignment,
    bulkSummaryText,
    runPerPerson,
    type BulkKind,
  } from "$lib/employees/bulk-actions";
  import BulkPreviewDialog from "$components/ui/BulkPreviewDialog.svelte";
  import Note from "$components/ui/Note.svelte";
  import BulkRoleDialog from "$lib/components/employees/BulkRoleDialog.svelte";
  import { listUrlSchema, sortEmployees } from "$lib/employees/list-url-state";
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DeactivateEmployeeDialog from "$lib/components/admin/DeactivateEmployeeDialog.svelte";
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import TableToolbar, { type ToolbarFilter } from "$components/ui/TableToolbar.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import HomeSalonField from "$lib/components/employees/HomeSalonField.svelte";
  import {
    homeSalonOptions,
    homeSalonPayload,
    offerHomeSalonChoice,
    type SalonRef,
  } from "$lib/employees/salon-assignments";
  import {
    type EmployeeClassification,
    CLASSIFICATION_OPTIONS,
    CLASSIFICATION_LABELS,
    applyDefaults,
    isOverridden,
  } from "$lib/employee-classification";
  import {
    statutoryMinimumFiveDayWeek,
    MISSING_BIRTH_DATE_HINT,
  } from "$lib/statutory-minimum-vacation";
  import { vacationBaseDefaultFor, annualVacationDaysPayload } from "$lib/vacation-base-default";
  import {
    buildUsualWorkDaysPayload,
    usualWorkDaysShortfall,
    usualWorkDaysMissing,
  } from "$lib/utils/work-schedule";

  import {
    employmentState,
    localCalendarDay,
    type EmploymentKind,
  } from "$lib/employees/employment-state";

  type InvitationStatus = "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";

  // A type alias, not an interface: DataTable's row generic wants an index-signature-compatible type.
  type Employee = {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    hireDate: string;
    exitDate: string | null;
    nfcCardId: string | null;
    birthDate: string | null;
    // Personalstruktur (Phase 41) — coverageWeight is Decimal serialized as string by Prisma JSON
    classification: EmployeeClassification;
    coverageWeight: string | number;
    requiresSupervision: boolean;
    userId: string;
    user: {
      email: string;
      isActive: boolean;
      lastLoginAt: string | null;
    };
    invitationStatus: InvitationStatus;
    workSchedule: { type: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED" } | null;
  };

  let employees: Employee[] = $state([]);
  let loading = $state(true);
  // Issue #558 D-11: the header salon narrows the list. The page decides only through
  // `salonPageFilter` (never the store's raw selection) and reloads from an effect that reads
  // primitive deriveds only.
  const contextLoaded = $derived($salonContext.loaded);
  const pageSalonId = $derived(salonPageFilter($salonContext));
  const scopeLabel = $derived(salonScopeLabel($salonContext));
  let salonRejected = $state(false);
  // Plain let: an older response never overwrites a newer one (not reactive on purpose).
  let listGeneration = 0;
  let error = $state("");

  // Create modal
  let createOpen = $state(false);
  let creating = $state(false);
  let createError = $state("");
  let createEmailError = $state("");
  let cFirstName = $state("");
  let cLastName = $state("");
  let cEmail = $state("");
  let cEmployeeNumber = $state("");
  let cHireDate = $state(new Date().toISOString().split("T")[0]);
  // Role drafts of the create dialog (Issue #580, D-580-03): every new person gets the default
  // role for the whole company from the API; further roles are drafted here and posted once the
  // person exists.
  const CREATE_FIXED_ROWS: { roleName: string; scope: AssignmentScope }[] = [
    { roleName: CREATE_DEFAULT_ROLE_NAME, scope: { type: "TENANT" } },
  ];
  let cDrafts = $state<AssignmentDraft[]>([]);
  let createRoles = $state<AccessRole[]>([]);
  let createMandantRoleIds = $state<string[]>([]);
  let createPeople = $state<AssignablePerson[]>([]);
  let createRoleChoicesFailed = $state(false);
  let createPersonName = $derived(`${cFirstName} ${cLastName}`.trim() || "Neue Person");
  let cScheduleType = $state<"FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED">(
    "FIXED_SCHEDULE",
  );
  let cWeeklyHours = $state(40);
  let cMonthlyHours = $state<number | null>(null);
  // Phase 436 Plan 02 (D-06) — SHIFT_BASED-only contract day count + übliche Arbeitstage.
  // Without a contract field on create, POST would default to 5 and reject any Angabe
  // below 5 days — exactly the issue's 4-day case (see this plan's <action>).
  let cContractWorkDays = $state<number>(5);
  let cUsualWorkDays = $state<number[]>([]);
  // Issue #481 R5 — a SHIFT_BASED contract cannot be created without (enough) übliche Arbeitstage.
  let createBlockedByUsualWorkDays = $derived(
    cScheduleType === "SHIFT_BASED" &&
      (usualWorkDaysMissing(cScheduleType, cUsualWorkDays) ||
        usualWorkDaysShortfall(cUsualWorkDays, cContractWorkDays) > 0),
  );
  // Issue #86 (AC-86-1) — the Stammsalon is required in a tenant with several active salons. The
  // salon list is read only for a caller who may list salons; null = not available, then no field
  // is offered and the server's own German error answers a missing Stammsalon.
  let createSalons = $state<SalonRef[] | null>(null);
  let cHomeSalonId = $state("");
  let createBlockedByHomeSalon = $derived(
    createSalons !== null &&
      offerHomeSalonChoice(true, homeSalonOptions(createSalons).length) &&
      cHomeSalonId === "",
  );
  let cUsePassword = $state(false);
  let cPassword = $state("");
  // Phase 49.2 — FLEXTIME Kernarbeitszeit fields + tenant defaults for pre-fill
  let cCoreStart = $state("");
  let cCoreEnd = $state("");
  let cCoreDays = $state<number[]>([]);
  let tenantDefaultCoreStart = $state("");
  let tenantDefaultCoreEnd = $state("");
  let tenantDefaultCoreDays = $state<number[]>([]);
  // Personalstruktur (Phase 41)
  let cClassification: EmployeeClassification = $state("VOLLZEIT");
  let cCoverageWeight = $state(1.0);
  let cRequiresSupervision = $state(false);
  // Issue #482: per-person vacation base value; null = the classification's own Standard,
  // resolved server-side (resolveVacationBaseDays()).
  let cAnnualVacationDays = $state<number | null>(null);
  // Issue #435 (D-01/D-11) — tenant defaults loaded onMount, for the create-dialog pre-fill.
  let tenantDefaultVacationDays = $state<number | null>(null);
  let tenantDefaultApprenticeVacationDays = $state<number | null>(null);
  let cBirthDate = $state("");
  // The last value refreshVacationPrefill itself wrote — distinguishes "still the suggestion"
  // from "the admin typed something", so a later classification/birth-date change only re-fills
  // while the field still holds the form's own suggestion (never overwrites a typed value).
  let cVacationPrefill = $state<number | null>(null);
  // Without a birth date the adult minimum (§ 3 BUrlG) still applies — never "no minimum".
  let cBirthMinimum = $derived(
    statutoryMinimumFiveDayWeek(cBirthDate || null, Number(cHireDate.slice(0, 4))),
  );

  // ── Personalstruktur override badges (Phase 41 DD-03) ────────────────────
  // Reactive: re-evaluate when classification or the field itself changes.
  let cCoverageOverridden = $derived(
    isOverridden(cClassification, "coverageWeight", cCoverageWeight),
  );
  let cSupervisionOverridden = $derived(
    isOverridden(cClassification, "requiresSupervision", cRequiresSupervision),
  );

  // Issue #482 (G-7 display mirror) — proposes the classification's own Standard (Azubi-Standard
  // or Unternehmensstandard), raised to the legal minimum (§ 19 JArbSchG with a birth date, else
  // § 3 BUrlG); never overwrites a value the admin typed.
  function refreshVacationPrefill() {
    const base = vacationBaseDefaultFor(
      cClassification,
      tenantDefaultVacationDays,
      tenantDefaultApprenticeVacationDays,
    );
    const next = base === null ? null : Math.max(base, cBirthMinimum.days);
    if (cAnnualVacationDays === null || cAnnualVacationDays === cVacationPrefill) {
      cAnnualVacationDays = next;
    }
    cVacationPrefill = next;
  }

  function onCreateClassificationChange() {
    const def = applyDefaults(cClassification);
    cCoverageWeight = def.coverageWeight;
    cRequiresSupervision = def.requiresSupervision;
    refreshVacationPrefill();
  }
  function resetCoverage() {
    cCoverageWeight = applyDefaults(cClassification).coverageWeight;
  }
  function resetSupervision() {
    cRequiresSupervision = applyDefaults(cClassification).requiresSupervision;
  }

  // Controls follow the caller's permissions (Issue #538); the API refuses anything beyond them.
  let rights = $derived(employeeAdminRights($authStore.user));
  let canCreate = $derived(rights.canCreate);
  let canManageAccess = $derived(rights.canManageAccess);
  let canAssignRoles = $derived(rights.canAssignRoles);
  let canReadRoles = $derived(hasPermission($authStore.user, "role:read:ZUGEWIESEN"));
  let showActions = $derived(rights.showActions);
  let canReadSalons = $derived(salonAdminRights($authStore.user).canRead);

  async function loadCreateSalons() {
    if (!canReadSalons) {
      createSalons = null;
      return;
    }
    try {
      const res = await api.get<{ salons: SalonRef[] }>("/salons");
      createSalons = res.salons;
    } catch {
      // Without the list no choice is offered; the API still answers a missing Stammsalon.
      createSalons = null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function isAnonymized(emp: Employee): boolean {
    // Sentinel set by DELETE /employees/:id anonymization flow (CLAUDE.md / DSGVO)
    return emp.firstName === "Gelöscht" && emp.lastName.startsWith("GELÖSCHT-");
  }

  // The stored role assignments per user id, with their scope (Issue #538, #580 D-580-05), loaded
  // only for a caller who may manage role assignments; null = not offered (column, filter and count
  // are hidden). GET /employees itself carries no role data. Labels come from the one formatter.
  let assignmentsByUser = $state<Record<string, RoleAssignment[]> | null>(null);
  let assignmentPeople = $state<AssignablePerson[]>([]);
  // Names of a person scope come from the whole-tenant people list, never from the filtered list.
  let assignmentCtx = $derived({
    salons: $salonContext.salons,
    salonsLoaded: $salonContext.loaded,
    people: assignmentPeople,
  });

  // Filters
  // Issue #843 (D-843-01 block 6, D-843-11): the search text and the sort live in the URL through
  // urlState() with an allow-list schema (q, sort, dir); the salon key and every other foreign query
  // key of the URL stay untouched. `filterSearch` is the RAW input text (so a typed trailing space
  // survives the parser's trim); the URL carries the parsed value.
  const listUrl = urlState(listUrlSchema);
  const urlQuery = $derived(listUrl.read().q);
  const listSort = $derived(listUrl.read());
  let filterSearch = $state(listUrl.read().q);
  // Values written to the URL whose echo has not come back yet. A fast typist produces "a", "ab"
  // before the first navigation lands; the echo of "a" must not overwrite the input with "a".
  let pendingEchoes: string[] = [];
  function onSearchInput(value: string) {
    filterSearch = value;
    const next = listUrlSchema.q.parse(value);
    if (next === listUrl.read().q) return;
    pendingEchoes = [...pendingEchoes, next];
    listUrl.write({ q: next });
  }
  $effect(() => {
    const q = urlQuery;
    untrack(() => {
      const index = pendingEchoes.indexOf(q);
      if (index >= 0) {
        pendingEchoes = pendingEchoes.slice(index + 1);
        return;
      }
      // A change the page did not write itself (back/forward, a link): the input follows the URL.
      pendingEchoes = [];
      if (listUrlSchema.q.parse(filterSearch) !== q) filterSearch = q;
    });
  });
  // The cycle none -> asc -> desc -> none of a column head; „none“ is the default (name, ascending).
  const tableSort = $derived<DataTableSort>({ key: listSort.sort, dir: listSort.dir });
  function onSort(next: DataTableSort | null) {
    if (next === null) listUrl.write({ sort: "name", dir: "asc" });
    else listUrl.write({ sort: next.key as "name" | "hire", dir: next.dir });
  }
  let filterRole = $state("");
  let filterStatus = $state<"active" | "pending" | "expired" | "inactive" | "">("");
  // Employment filter (Issue #86, AC-86-6): "" lists everyone, so ended employees stay visible.
  let filterEmployment = $state<EmploymentKind | "">("");
  let showAnonymized = $state(false);
  // Browser-local calendar day: the web has no tenant-local "today" helper.
  const today = localCalendarDay();

  // Pagination
  let empPage = $state(1);
  let empPageSize = $state(10);

  let filteredEmployees = $derived(
    employees.filter((emp) => {
      // Hide anonymized employees by default
      if (!showAnonymized && isAnonymized(emp)) return false;
      if (filterSearch) {
        const q = filterSearch.toLowerCase();
        const match =
          `${emp.firstName} ${emp.lastName} ${emp.user.email} ${emp.employeeNumber}`.toLowerCase();
        if (!match.includes(q)) return false;
      }
      if (filterRole && !(roleNamesOf(emp) ?? []).includes(filterRole)) return false;
      if (filterEmployment && employmentState(emp.exitDate, today).kind !== filterEmployment)
        return false;
      if (filterStatus) {
        if (filterStatus === "active" && !emp.user.isActive) return false;
        if (filterStatus === "pending" && (emp.user.isActive || emp.invitationStatus !== "PENDING"))
          return false;
        if (filterStatus === "expired" && (emp.user.isActive || emp.invitationStatus !== "EXPIRED"))
          return false;
        if (
          filterStatus === "inactive" &&
          (emp.user.isActive ||
            emp.invitationStatus === "PENDING" ||
            emp.invitationStatus === "EXPIRED")
        )
          return false;
      }
      return true;
    }),
  );

  // The sort runs over the whole filtered list, before the page is cut out of it.
  let sortedEmployees = $derived(sortEmployees(filteredEmployees, listSort.sort, listSort.dir));
  let pagedEmployees = $derived(
    sortedEmployees.slice((empPage - 1) * empPageSize, empPage * empPageSize),
  );
  // „keine Treffer“ (not „noch nichts da“) whenever the search or a filter is on.
  let filtersActive = $derived(
    Boolean(filterSearch.trim() || filterRole || filterStatus || filterEmployment),
  );
  function resetFilters() {
    onSearchInput("");
    filterRole = "";
    filterStatus = "";
    filterEmployment = "";
  }

  // ── Selection and CSV export (Issue #854, D-854-09) ────────────────────────────────────────────
  // The selection survives paging; it is cut down to the persons the filtered list still holds, so a
  // person the filter hides can never be changed or exported unseen.
  let selectedIds = $state<(string | number)[]>([]);
  let selectedEmployees = $derived.by(() => {
    const ids = new Set(selectedIds);
    return sortedEmployees.filter((emp) => ids.has(emp.id));
  });
  let selectedCount = $derived(selectedEmployees.length);

  function dayText(iso: string | null | undefined): string {
    return iso
      ? new Date(iso).toLocaleDateString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : "—";
  }

  // The text a column shows, one place for the cell and the CSV export. The export carries exactly
  // the columns of the list (never more, T-854-44), without the action column.
  function exportText(emp: Employee, key: string): string {
    switch (key) {
      case "number":
        return emp.employeeNumber;
      case "name":
        return `${emp.lastName}, ${emp.firstName}`;
      case "email":
        return emp.user.email;
      case "role":
        return assignmentsOf(emp).length > 0
          ? assignmentsOf(emp)
              .map((assignment) => assignmentLabel(assignment, assignmentCtx))
              .join(", ")
          : NO_ASSIGNMENT_LABEL;
      case "hire":
        return dayText(emp.hireDate);
      case "schedule":
        return scheduleLabel(emp.workSchedule?.type);
      case "status": {
        const employment = employmentState(emp.exitDate, today);
        return employment.kind === "EMPLOYED"
          ? statusLabel(emp)
          : `${statusLabel(emp)}, ${employment.label}`;
      }
      case "login":
        return dayText(emp.user.lastLoginAt);
      default:
        return "";
    }
  }

  function exportSelectedCsv() {
    const exported = columns.filter((column) => column.key !== "actions");
    const records = selectedEmployees.map((emp) =>
      Object.fromEntries(exported.map((column) => [column.key, exportText(emp, column.key)])),
    );
    downloadCsv(`personen-${today}.csv`, rowsToCsv(exported, records));
  }

  // ── Bulk changes (Issue #854, D-854-09, AC-2) ──────────────────────────────────────────────────
  // „Einladung erneut senden“ and „Rolle zuweisen“ run the existing per-person request for every
  // selected person, after a preview that lists exactly who is touched. The API stays the authority
  // (reach, role-assignment:manage, package gate, four-eyes); a refusal is reported per person.
  let bulkKind = $state<BulkKind>("invitation");
  let bulkOpen = $state(false);
  let bulkRunning = $state(false);
  let bulkRoleOpen = $state(false);
  let bulkChoice = $state<{ accessRoleId: string; scope: AssignmentScope } | null>(null);

  function hasOpenInvitation(emp: Employee): boolean {
    return (
      !emp.user.isActive &&
      (emp.invitationStatus === "PENDING" || emp.invitationStatus === "EXPIRED")
    );
  }
  function personName(emp: Employee): string {
    return `${emp.lastName}, ${emp.firstName}`;
  }

  // Who the open preview would touch, and who is named as skipped (with the reason).
  let bulkTargets = $derived(
    bulkKind === "invitation"
      ? selectedEmployees.filter(hasOpenInvitation)
      : selectedEmployees.filter(
          (emp) =>
            !isAnonymized(emp) &&
            !(bulkChoice && alreadyHoldsAssignment(assignmentsOf(emp), bulkChoice)),
        ),
  );
  let bulkSkipped = $derived(selectedEmployees.filter((emp) => !bulkTargets.includes(emp)));
  let bulkSkipReason = $derived(
    bulkKind === "invitation"
      ? "ohne offene Einladung"
      : "anonymisiert oder hat diese Rolle bereits",
  );

  function askResendInvitations() {
    bulkKind = "invitation";
    bulkOpen = true;
  }

  async function askAssignRole() {
    if (createRoles.length === 0 && !createRoleChoicesFailed) await loadCreateRoleChoices();
    bulkChoice = null;
    bulkRoleOpen = true;
  }

  function onBulkRoleChosen(choice: { accessRoleId: string; scope: AssignmentScope }) {
    bulkChoice = choice;
    bulkKind = "role";
    bulkOpen = true;
  }

  function nameOfId(id: string): string {
    const emp = employees.find((e) => e.id === id);
    return emp ? personName(emp) : id;
  }

  async function runBulk() {
    if (bulkRunning || bulkTargets.length === 0) return;
    const kind = bulkKind;
    const choice = bulkChoice;
    bulkRunning = true;
    try {
      const userIdOf = new Map(bulkTargets.map((emp) => [emp.id, emp.userId]));
      const result = await runPerPerson(
        bulkTargets.map((emp) => emp.id),
        (id) =>
          kind === "invitation"
            ? api.post(`/employees/${id}/resend-invitation`, {})
            : createRoleAssignment({
                userId: userIdOf.get(id) ?? "",
                accessRoleId: choice?.accessRoleId ?? "",
                scope: choice?.scope ?? { type: "TENANT" },
              }),
      );
      bulkOpen = false;
      const text = bulkSummaryText(kind, result, nameOfId);
      if (result.failed.length === 0) toasts.success(text);
      else toasts.error(text, 10000);
      await loadEmployees();
      // The failed rows stay selected, so the run can be repeated for exactly them.
      selectedIds = result.failed.map((f) => f.id);
    } finally {
      bulkRunning = false;
    }
  }

  function bulkChoiceLabel(): string {
    return bulkChoice ? draftLabel({ key: "bulk", ...bulkChoice }, createRoles, assignmentCtx) : "";
  }

  // The persons the list holds before search and filters: anonymized ones only when asked for.
  let baseEmployees = $derived(
    showAnonymized ? employees : employees.filter((e) => !isAnonymized(e)),
  );

  // KPI figures (exclude anonymized)
  let statTotal = $derived(employees.filter((e) => !isAnonymized(e)).length);
  let statActive = $derived(employees.filter((e) => e.user.isActive && !isAnonymized(e)).length);
  // Role chip, filter and count exist only when the names were loaded (Issue #538).
  let showRoles = $derived(assignmentsByUser !== null);
  // The same columns in the same order as the former table; Rolle and Aktionen exist only as before.
  let columns = $derived<DataTableColumn[]>([
    { key: "number", label: "Nr." },
    { key: "name", label: "Name", primary: true, sortable: true },
    { key: "email", label: "E-Mail" },
    ...(showRoles ? [{ key: "role", label: "Rolle" }] : []),
    { key: "hire", label: "Eintritt", sortable: true },
    { key: "schedule", label: "Arbeitszeitmodell" },
    { key: "status", label: "Status" },
    { key: "login", label: "Letzter Login" },
    ...(showActions ? [{ key: "actions", label: "Aktionen" }] : []),
  ]);
  let roleOptions = $derived(
    [...new Set(employees.flatMap((e) => (isAnonymized(e) ? [] : (roleNamesOf(e) ?? []))))].sort(
      (a, b) => a.localeCompare(b, "de"),
    ),
  );

  // The figures of the Kennzahlenleiste; „Rollen“ only when the role names were loaded (#538).
  let kpiItems = $derived<KpiItem[]>([
    { label: "Mitarbeitende", value: statTotal, unit: "gesamt" },
    { label: "Aktiv", value: statActive, unit: "angemeldet" },
    ...(showRoles
      ? [{ label: "Rollen", value: roleOptions.length, unit: "vergeben" } satisfies KpiItem]
      : []),
  ]);

  // The filters of the toolbar: same options and same state as the former selects. Search and sort
  // keep their URL keys (q, sort, dir); the three filters were never part of the URL.
  let toolbarFilters = $derived<ToolbarFilter[]>([
    ...(showRoles
      ? [
          {
            key: "role",
            label: "Rolle",
            value: filterRole,
            options: roleOptions.map((name) => ({ value: name, label: name })),
          },
        ]
      : []),
    {
      key: "status",
      label: "Status",
      value: filterStatus,
      options: [
        { value: "active", label: "Aktiv" },
        { value: "pending", label: "Einladung ausstehend" },
        { value: "expired", label: "Einladung abgelaufen" },
        { value: "inactive", label: "Inaktiv" },
      ],
    },
    {
      key: "employment",
      label: "Beschäftigung",
      value: filterEmployment,
      options: [
        { value: "EMPLOYED", label: "Beschäftigt" },
        { value: "EXIT_PLANNED", label: "Austritt geplant" },
        { value: "ENDED", label: "Ausgeschieden" },
      ],
    },
  ]);

  function onToolbarFilter(key: string, value: string) {
    if (key === "role") filterRole = value;
    else if (key === "status") filterStatus = value as typeof filterStatus;
    else if (key === "employment") filterEmployment = value as typeof filterEmployment;
  }

  $effect(() => {
    filteredEmployees.length;
    empPage = 1;
  });

  // Issue #558: this effect owns the list loads; it waits for the salon context so the first
  // request is already filtered, and reloads when the header salon changes.
  $effect(() => {
    if (!contextLoaded) return;
    void pageSalonId;
    untrack(() => {
      void loadEmployees();
    });
  });

  onMount(async () => {
    // Phase 49.2 — load tenant FLEXTIME core defaults for pre-fill in create modal
    // Issue #435 (D-01) — same fetch also reads the vacation-days tenant defaults.
    try {
      const cfg = await api.get<{
        defaultCoreStart?: string | null;
        defaultCoreEnd?: string | null;
        defaultCoreDays?: number[];
        defaultVacationDays?: number | string;
        defaultApprenticeVacationDays?: number | string;
      }>("/settings/work");
      tenantDefaultCoreStart = cfg.defaultCoreStart ?? "";
      tenantDefaultCoreEnd = cfg.defaultCoreEnd ?? "";
      tenantDefaultCoreDays = Array.isArray(cfg.defaultCoreDays) ? [...cfg.defaultCoreDays] : [];
      const vacDays = Number(cfg.defaultVacationDays);
      tenantDefaultVacationDays = Number.isFinite(vacDays) ? vacDays : null;
      const apprenticeVacDays = Number(cfg.defaultApprenticeVacationDays);
      tenantDefaultApprenticeVacationDays = Number.isFinite(apprenticeVacDays)
        ? apprenticeVacDays
        : null;
    } catch {
      // non-critical — pre-fill just won't happen if this fails
    }
  });

  function roleNamesOf(emp: Employee): string[] | null {
    return assignmentsByUser === null ? null : assignedRoleNames(assignmentsOf(emp));
  }

  function assignmentsOf(emp: Employee): RoleAssignment[] {
    return assignmentsByUser?.[emp.userId] ?? [];
  }

  // Only with role-assignment:manage — HR and other readers must see no request refused.
  async function loadCreateRoleChoices() {
    if (!canAssignRoles) {
      createRoles = [];
      createMandantRoleIds = [];
      createPeople = [];
      return;
    }
    try {
      const [choices, people] = await Promise.all([
        loadAssignmentChoices(canReadRoles),
        listAssignablePeople(),
      ]);
      createRoles = choices.roles;
      createMandantRoleIds = choices.mandantRoleIds;
      createPeople = people;
    } catch {
      createRoleChoicesFailed = true;
    }
  }

  async function loadRoleAssignments() {
    if (!canAssignRoles) {
      assignmentsByUser = null;
      return;
    }
    try {
      const [assignments, people] = await Promise.all([
        listRoleAssignments(),
        listAssignablePeople(),
      ]);
      assignmentPeople = people;
      assignmentsByUser = groupAssignmentsByUser(assignments);
    } catch {
      // The column is decoration; a failed read hides it instead of blocking the list.
      assignmentsByUser = null;
    }
  }

  async function loadEmployees() {
    const generation = ++listGeneration;
    loading = true;
    error = "";
    try {
      // Admin list requests anonymized rows too (ADMIN-only server-side); the
      // "Anonymisierte anzeigen" toggle then filters them client-side (isAnonymized).
      const [list] = await Promise.all([
        api.get<Employee[]>(withSalonId("/employees?includeAnonymized=true", pageSalonId)),
        loadRoleAssignments(),
      ]);
      if (generation !== listGeneration) return;
      employees = list;
      const known = new Set(list.map((emp) => emp.id));
      selectedIds = selectedIds.filter((id) => known.has(String(id)));
      salonRejected = false;
    } catch (e: unknown) {
      if (generation !== listGeneration) return;
      if (isSalonFilterRejected(e)) {
        // The one 404 of an inadmissible salon: a calm text, no toast, no error banner.
        employees = [];
        salonRejected = true;
      } else {
        error = e instanceof Error ? e.message : "Fehler beim Laden";
      }
    } finally {
      if (generation === listGeneration) loading = false;
    }
  }

  function openCreate() {
    cFirstName = "";
    cLastName = "";
    cEmail = "";
    cEmployeeNumber = "";
    cHireDate = new Date().toISOString().split("T")[0];
    cDrafts = [];
    createRoleChoicesFailed = false;
    void loadCreateRoleChoices();
    cScheduleType = "FIXED_SCHEDULE";
    cWeeklyHours = 40;
    cMonthlyHours = null;
    // Phase 436 Plan 02 (D-06): reset alongside the other c* schedule fields.
    cContractWorkDays = 5;
    cUsualWorkDays = [];
    cUsePassword = false;
    cPassword = "";
    // Phase 49.2 — reset core fields (no pre-fill here; pre-fill happens on FLEXTIME selection)
    cCoreStart = "";
    cCoreEnd = "";
    cCoreDays = [];
    // Personalstruktur defaults
    cClassification = "VOLLZEIT";
    const def = applyDefaults(cClassification);
    cCoverageWeight = def.coverageWeight;
    cRequiresSupervision = def.requiresSupervision;
    // Issue #435 (D-01/D-13) — reset to "no value", then let the pre-fill propose one
    cAnnualVacationDays = null;
    cVacationPrefill = null;
    cBirthDate = "";
    refreshVacationPrefill();
    cHomeSalonId = "";
    void loadCreateSalons();
    createError = "";
    createEmailError = "";
    createOpen = true;
  }

  // Phase 49.2 — pre-fill Kernarbeitszeit when FLEXTIME is selected and fields are empty
  function onCreateScheduleTypeChange(
    newType: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED",
  ) {
    cScheduleType = newType;
    if (
      newType === "FLEXTIME" &&
      !cCoreStart &&
      !cCoreEnd &&
      cCoreDays.length === 0 &&
      (tenantDefaultCoreStart || tenantDefaultCoreEnd || tenantDefaultCoreDays.length > 0)
    ) {
      cCoreStart = tenantDefaultCoreStart;
      cCoreEnd = tenantDefaultCoreEnd;
      cCoreDays = [...tenantDefaultCoreDays];
    }
  }

  async function createEmployee() {
    creating = true;
    createError = "";
    createEmailError = "";
    try {
      const payload: Record<string, unknown> = {
        email: cEmail,
        firstName: cFirstName,
        lastName: cLastName,
        employeeNumber: cEmployeeNumber,
        hireDate: new Date(cHireDate).toISOString(),
        scheduleType: cScheduleType,
        weeklyHours:
          cScheduleType === "FIXED_SCHEDULE" ||
          cScheduleType === "FLEXTIME" ||
          cScheduleType === "SHIFT_BASED"
            ? cWeeklyHours
            : 0,
        monthlyHours: cScheduleType === "MONTHLY_HOURS" ? cMonthlyHours : null,
        // Phase 49.2 — FLEXTIME Kernarbeitszeit
        coreStart: cScheduleType === "FLEXTIME" ? cCoreStart || null : null,
        coreEnd: cScheduleType === "FLEXTIME" ? cCoreEnd || null : null,
        coreDays: cScheduleType === "FLEXTIME" ? cCoreDays : [],
        // Phase 436 Plan 02 (D-02/D-06): SHIFT_BASED contract day count + übliche Arbeitstage.
        contractWorkDaysPerWeek: cScheduleType === "SHIFT_BASED" ? cContractWorkDays : null,
        ...buildUsualWorkDaysPayload(cScheduleType, cUsualWorkDays),
        // Personalstruktur (Phase 41)
        classification: cClassification,
        coverageWeight: cCoverageWeight,
        requiresSupervision: cRequiresSupervision,
        // Issue #435 (D-11/D-12) — optional, drives the statutory-minimum pre-fill/hint only.
        birthDate: cBirthDate ? new Date(cBirthDate).toISOString() : null,
        // Issue #482 (G-5, mirrors #435 D-13): a value equal to the classification's OWN
        // Standard (AZUBI -> Azubi-Standard, everyone else -> Unternehmensstandard) is sent as
        // null, so the person keeps following later changes of that Standard instead of
        // freezing today's number as an explicit override. A floor-raised minor suggestion
        // stays explicit (unchanged #435 D-11 behaviour).
        annualVacationDays: annualVacationDaysPayload(
          cAnnualVacationDays,
          cClassification,
          tenantDefaultVacationDays,
          tenantDefaultApprenticeVacationDays,
        ),
      };
      Object.assign(payload, homeSalonPayload(cHomeSalonId));
      if (cUsePassword && cPassword) payload.password = cPassword;
      const res = await api.post<Employee & { emailError?: string }>("/employees", payload);
      employees = [...employees, res].sort((a, b) => a.lastName.localeCompare(b.lastName));
      createOpen = false;
      const drafts = cDrafts;
      let failed = false;
      try {
        const failures = await postAssignmentDrafts(res.userId, drafts);
        if (failures.length > 0) {
          failed = true;
          toasts.error(
            draftFailureMessage(
              failures.map((f) => ({
                label: draftLabel(f.draft, createRoles, assignmentCtx),
                message: f.message,
              })),
            ),
            10000,
          );
        } else if (drafts.length > 0) {
          toasts.success(draftsSavedMessage(drafts.length));
        }
      } catch {
        failed = drafts.length > 0;
      }
      if (res.emailError) {
        toasts.error(
          `Mitarbeiter angelegt, aber Einladungsmail konnte nicht gesendet werden: ${res.emailError}`,
        );
      }
      if (failed) {
        await goto(berechtigungenTabHref(res.id));
        return;
      }
      void loadRoleAssignments();
    } catch (e: unknown) {
      createError = e instanceof Error ? e.message : "Fehler beim Anlegen";
    } finally {
      creating = false;
    }
  }

  async function resendInvitation(emp: Employee) {
    try {
      await api.post(`/employees/${emp.id}/resend-invitation`, {});
      toasts.success("Einladung erneut gesendet.");
    } catch (e: unknown) {
      toasts.error(
        e instanceof Error
          ? e.message
          : "Einladung konnte nicht gesendet werden. Versuche es noch einmal.",
      );
    }
  }

  // Deactivation has its own dialog (last working day, preview; Issue #615); reactivation keeps
  // the plain confirm dialog.
  let deactivateDialog = $state<{ open: boolean; emp: Employee | null }>({
    open: false,
    emp: null,
  });
  let reactivateConfirm = $state<{ open: boolean; emp: Employee | null }>({
    open: false,
    emp: null,
  });

  function askDeactivate(emp: Employee) {
    deactivateDialog = { open: true, emp };
  }

  function askReactivate(emp: Employee) {
    reactivateConfirm = { open: true, emp };
  }

  async function confirmReactivate() {
    const { emp } = reactivateConfirm;
    if (!emp) return;
    try {
      await api.patch(`/employees/${emp.id}/reactivate`, {});
      await loadEmployees();
    } catch (e: unknown) {
      toasts.error(
        e instanceof Error
          ? e.message
          : "Mitarbeiter konnte nicht reaktiviert werden. Versuche es noch einmal.",
      );
    }
  }

  function scheduleLabel(type: string | null | undefined): string {
    switch (type) {
      case "FIXED_SCHEDULE":
        return "Feste Arbeitszeit";
      case "FLEXTIME":
        return "Gleitzeit";
      case "MONTHLY_HOURS":
        return "Monatsstunden";
      case "SHIFT_BASED":
        return "Nach Schichtplan";
      default:
        return "—";
    }
  }

  function statusLabel(emp: Employee): string {
    if (emp.user.isActive) return "Aktiv";
    if (emp.invitationStatus === "PENDING") return "Einladung ausstehend";
    if (emp.invitationStatus === "EXPIRED") return "Einladung abgelaufen";
    return "Inaktiv";
  }

  function statusClass(emp: Employee): string {
    if (emp.user.isActive) return "chip chip-good";
    if (emp.invitationStatus === "PENDING") return "chip chip-warn";
    if (emp.invitationStatus === "EXPIRED") return "chip chip-bad";
    return "chip";
  }
</script>

<svelte:head>
  <title>{pageLabel("/admin/employees")} – Clokr</title>
</svelte:head>

<!-- Phase 73-05 (D-05): data-testid surface for admin-employees flows (stable page-root selector). -->
<div class="page" data-testid="admin-employees-page">
  <PageHead
    title={pageLabel("/admin/employees")}
    sub="Lege Personen an, lade sie ein und verwalte ihre Daten."
  >
    {#snippet actions()}
      {#if canCreate}
        <button class="btn btn-primary" onclick={openCreate} data-testid="admin-employees-add"
          >+ Mitarbeiter anlegen</button
        >
      {/if}
    {/snippet}
  </PageHead>

  <SalonScopeLabel label={scopeLabel} rejected={salonRejected} />
  {#if error}
    <div role="alert"><Note tone="bad">{error}</Note></div>
  {:else if salonRejected}
    <!-- The calm text is rendered by the scope label above. -->
  {:else if !loading && employees.length === 0}
    <EmptyState
      icon="inbox"
      title="Noch keine Mitarbeiter angelegt"
      actionLabel={canCreate ? "Jetzt anlegen" : undefined}
      onaction={canCreate ? openCreate : undefined}
    />
  {:else}
    {#if !loading}
      <KpiStrip items={kpiItems} ariaLabel="Belegschaft auf einen Blick" />
    {/if}

    <DataTable
      {columns}
      rows={pagedEmployees}
      rowKey={(emp) => emp.id}
      rowTestId={(emp) => `admin-employees-row-${emp.id}`}
      sort={tableSort}
      {onSort}
      filtered={filtersActive}
      onResetFilters={resetFilters}
      onRowClick={(emp) => goto(`/admin/employees/${emp.id}`)}
      {loading}
      caption="Personen"
      selectable
      bind:selectedKeys={selectedIds}
      selectionLabel={(emp) => `${emp.lastName}, ${emp.firstName} auswählen`}
    >
      {#snippet toolbar()}
        <div class="list-controls">
          <TableToolbar
            bind:query={() => filterSearch, onSearchInput}
            count={filteredEmployees.length}
            total={baseEmployees.length}
            filters={toolbarFilters}
            onFilterChange={onToolbarFilter}
            onReset={resetFilters}
            searchLabel="Personen suchen"
          />
          <label class="anon-toggle">
            <input type="checkbox" bind:checked={showAnonymized} />
            <span>Anonymisierte anzeigen</span>
          </label>
          {#if selectedCount > 0}
            <div class="bulk-bar" data-testid="admin-employees-bulk-bar">
              <span class="bulk-count" aria-live="polite">{selectedCount} ausgewählt</span>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                onclick={exportSelectedCsv}
                data-testid="admin-employees-export-csv">Als CSV exportieren</button
              >
              {#if canManageAccess}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  onclick={askResendInvitations}
                  data-testid="admin-employees-bulk-invite">Einladung erneut senden</button
                >
              {/if}
              {#if canAssignRoles && canReadRoles}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  onclick={askAssignRole}
                  data-testid="admin-employees-bulk-role">Rolle zuweisen</button
                >
              {/if}
              <button type="button" class="btn btn-ghost btn-sm" onclick={() => (selectedIds = [])}
                >Auswahl aufheben</button
              >
            </div>
          {/if}
        </div>
      {/snippet}
      {#snippet cell(emp, column)}
        {#if column.key === "number"}
          <span class="col-number">{emp.employeeNumber}</span>
        {:else if column.key === "name"}
          <strong>{emp.lastName}, {emp.firstName}</strong>
          {#if emp.classification === "AZUBI" && !emp.birthDate}
            <span
              class="chip chip-warn"
              data-testid={`admin-employees-row-${emp.id}-birthdate-hint`}
              >{MISSING_BIRTH_DATE_HINT}</span
            >
          {/if}
        {:else if column.key === "email"}
          <span class="col-email">{emp.user.email}</span>
        {:else if column.key === "role"}
          {#if assignmentsOf(emp).length > 0}
            <span class="role-chips">
              {#each assignmentsOf(emp) as assignment (assignment.id)}
                <span class="chip chip-brand">{assignmentLabel(assignment, assignmentCtx)}</span>
              {/each}
            </span>
          {:else}
            <span class="text-muted">{NO_ASSIGNMENT_LABEL}</span>
          {/if}
        {:else if column.key === "hire"}
          <span class="col-date">{dayText(emp.hireDate)}</span>
        {:else if column.key === "schedule"}
          <span class="chip">{scheduleLabel(emp.workSchedule?.type)}</span>
        {:else if column.key === "status"}
          <span class={statusClass(emp)}>
            <span class="dot"></span>{statusLabel(emp)}
          </span>
          {#if employmentState(emp.exitDate, today).kind !== "EMPLOYED"}
            <span
              class={employmentState(emp.exitDate, today).kind === "ENDED"
                ? "chip"
                : "chip chip-warn"}
              data-testid={`admin-employees-row-${emp.id}-employment`}
              >{employmentState(emp.exitDate, today).label}</span
            >
          {/if}
        {:else if column.key === "login"}
          <span class="col-login">{dayText(emp.user.lastLoginAt)}</span>
        {:else if column.key === "actions"}
          <div class="action-group">
            {#if canManageAccess && !emp.user.isActive && (emp.invitationStatus === "PENDING" || emp.invitationStatus === "EXPIRED")}
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => resendInvitation(emp)}
                title="Einladung erneut senden"
                data-testid={`admin-employees-row-${emp.id}-invite`}
              >
                Einladen
              </button>
            {/if}
            <a
              href="/admin/employees/{emp.id}"
              class="btn btn-ghost btn-sm"
              data-testid={`admin-employees-row-${emp.id}-edit`}
            >
              Bearbeiten
            </a>
            {#if !canManageAccess}
              <!-- no access-management right: no (de)activation control -->
            {:else if emp.user.isActive}
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => askDeactivate(emp)}
                data-testid={`admin-employees-row-${emp.id}-deactivate`}>Deaktivieren</button
              >
            {:else}
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => askReactivate(emp)}
                data-testid={`admin-employees-row-${emp.id}-reactivate`}>Reaktivieren</button
              >
            {/if}
          </div>
        {/if}
      {/snippet}
    </DataTable>
    {#if !loading}
      <Pagination
        total={filteredEmployees.length}
        bind:page={empPage}
        bind:pageSize={empPageSize}
      />
    {/if}
  {/if}
</div>

<!-- ── Anlegen Modal ──────────────────────────────────────────────────────── -->
<Modal bind:open={createOpen} eyebrow="Mitarbeiter einladen" title="Person einladen">
  {#if createError}
    <div class="callout error">{createError}</div>
  {/if}
  {#if createEmailError}
    <div class="callout">
      Mitarbeiter angelegt, aber: {createEmailError}
    </div>
  {:else}
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label" for="c-firstname">Vorname</label>
        <input id="c-firstname" type="text" bind:value={cFirstName} class="input" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="c-lastname">Nachname</label>
        <input id="c-lastname" type="text" bind:value={cLastName} class="input" required />
      </div>
      <div class="form-group form-group--full">
        <label class="form-label" for="c-email">E-Mail-Adresse</label>
        <input id="c-email" type="email" bind:value={cEmail} class="input" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="c-empno">Mitarbeiter-Nr.</label>
        <input id="c-empno" type="text" bind:value={cEmployeeNumber} class="input" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="c-hiredate">Eintrittsdatum</label>
        <input
          id="c-hiredate"
          type="date"
          bind:value={cHireDate}
          class="input"
          required
          onchange={refreshVacationPrefill}
        />
      </div>
      <HomeSalonField salons={createSalons} bind:value={cHomeSalonId} />
      <!-- ── Rollen (Issue #580, D-580-03) ──────────────────────────────── -->
      <div class="form-group form-group--full form-subhead">
        <h4 class="form-subhead-title">Rollen</h4>
      </div>
      <div class="form-group form-group--full">
        {#if canAssignRoles}
          <PersonRoleAssignments
            personName={createPersonName}
            bind:drafts={cDrafts}
            fixedRows={CREATE_FIXED_ROWS}
            roles={createRoles}
            mandantRoleIds={createMandantRoleIds}
            salons={$salonContext.salons}
            salonsLoaded={$salonContext.loaded}
            people={createPeople}
            canManage={canAssignRoles}
            {canReadRoles}
            allowGrant={!createRoleChoicesFailed}
          />
          {#if createRoleChoicesFailed}
            <div class="callout">
              Rollen konnten nicht geladen werden. Weitere Rollen kannst du nach dem Anlegen im Tab
              „Berechtigungen“ zuweisen.
            </div>
          {/if}
        {/if}
        <p class="form-hint">
          Jede neue Person erhält die Rolle „{CREATE_DEFAULT_ROLE_NAME}“ für das ganze Unternehmen.
          Weitere Rollen werden gespeichert, sobald die Person angelegt ist.
        </p>
      </div>
      <!-- ── Personalstruktur (Phase 41) ────────────────────────────────── -->
      <div class="form-group form-group--full form-subhead">
        <h4 class="form-subhead-title">Personalstruktur</h4>
      </div>
      <div class="form-group">
        <label class="form-label" for="c-classification">Personalkategorie</label>
        <select
          id="c-classification"
          bind:value={cClassification}
          onchange={onCreateClassificationChange}
          class="select"
        >
          {#each CLASSIFICATION_OPTIONS as opt (opt)}
            <option value={opt}>{CLASSIFICATION_LABELS[opt]}</option>
          {/each}
        </select>
      </div>
      <!-- Issue #435 (D-11/D-12) — optional birth date drives the statutory-minimum pre-fill -->
      <div class="form-group">
        <label class="form-label" for="c-birthdate">Geburtsdatum (optional)</label>
        <input
          id="c-birthdate"
          type="date"
          class="input"
          bind:value={cBirthDate}
          onchange={refreshVacationPrefill}
        />
      </div>
      {#if cClassification === "AZUBI" && !cBirthDate}
        <div class="callout form-group--full">{MISSING_BIRTH_DATE_HINT}</div>
      {/if}
      <div class="form-group">
        <label class="form-label" for="c-coverage">Schicht-Gewicht</label>
        <input
          id="c-coverage"
          type="number"
          bind:value={cCoverageWeight}
          class="input"
          min="0"
          max="9.99"
          step="0.05"
        />
        {#if cCoverageOverridden}
          <div class="override-row">
            <span class="chip chip-warn">Manuell überschrieben</span>
            <button type="button" class="btn btn-ghost btn-sm" onclick={() => resetCoverage()}
              >Auf Standard zurück</button
            >
          </div>
        {/if}
      </div>
      <div class="form-group form-group--full">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={cRequiresSupervision} />
          Aufsichtspflichtig
        </label>
        {#if cSupervisionOverridden}
          <div class="override-row">
            <span class="chip chip-warn">Manuell überschrieben</span>
            <button type="button" class="btn btn-ghost btn-sm" onclick={() => resetSupervision()}
              >Auf Standard zurück</button
            >
          </div>
        {/if}
      </div>
      <!-- ── Urlaub (Issue #435, D-13 tracer) ─────────────────────────────── -->
      <div class="form-group form-group--full form-subhead">
        <h4 class="form-subhead-title">Urlaub</h4>
      </div>
      <div class="form-group form-group--full">
        <label class="form-label" for="c-annual-vacation-days">
          Urlaubstage pro Jahr (5-Tage-Woche)
        </label>
        <input
          id="c-annual-vacation-days"
          type="number"
          min="0.5"
          max="365"
          step="0.01"
          class="input"
          bind:value={cAnnualVacationDays}
          data-testid="admin-employees-create-annual-vacation-days"
        />
        <p class="form-hint">
          Vorschlag aus den Einstellungen des Unternehmens (Azubis: „Urlaubstage Azubis").
          Entspricht der Wert dem Standard, wird kein eigener Wert gespeichert – die Person folgt
          dann auch späteren Änderungen des Standards. Wird auf die vertraglichen Arbeitstage
          umgerechnet und im Eintrittsjahr anteilig berechnet.
        </p>
        {#if cBirthMinimum && cAnnualVacationDays !== null && cAnnualVacationDays < cBirthMinimum.days}
          <div class="callout error">
            Unter dem gesetzlichen Mindesturlaub von {cBirthMinimum.days.toLocaleString("de-DE", {
              maximumFractionDigits: 2,
            })} Tagen ({cBirthMinimum.law}) – das Speichern wird abgelehnt.
          </div>
        {/if}
      </div>
      <div class="form-group form-group--full form-subhead">
        <h4 class="form-subhead-title">Arbeitszeitmodell</h4>
      </div>
      <div class="form-group">
        <label class="form-label" for="c-schedule-type">Arbeitszeitmodell</label>
        <select
          id="c-schedule-type"
          value={cScheduleType}
          onchange={(e) =>
            onCreateScheduleTypeChange(
              (e.currentTarget as HTMLSelectElement).value as typeof cScheduleType,
            )}
          class="select"
        >
          <option value="FIXED_SCHEDULE">Feste Arbeitszeit</option>
          <option value="FLEXTIME">Gleitzeit</option>
          <option value="MONTHLY_HOURS">Monatsstunden</option>
          <option value="SHIFT_BASED">Nach Schichtplan</option>
        </select>
      </div>
      {#if cScheduleType === "FIXED_SCHEDULE" || cScheduleType === "FLEXTIME" || cScheduleType === "SHIFT_BASED"}
        <div class="form-group">
          <label class="form-label" for="c-hours">Wochenstunden</label>
          <input
            id="c-hours"
            type="number"
            bind:value={cWeeklyHours}
            class="input"
            min="1"
            max="60"
            step="0.5"
          />
        </div>
      {:else}
        <div class="form-group">
          <label class="form-label" for="c-monthly-hours"
            >Stunden/Monat <span class="text-muted">(optional)</span></label
          >
          <input
            id="c-monthly-hours"
            type="number"
            bind:value={cMonthlyHours}
            class="input"
            min="0"
            max="200"
            step="0.5"
            placeholder="z.B. 15 — leer = nur Tracking"
          />
        </div>
      {/if}

      {#if cScheduleType === "SHIFT_BASED"}
        <div class="form-group">
          <label class="form-label" for="c-contract-workdays">Arbeitstage/Woche</label>
          <input
            id="c-contract-workdays"
            type="number"
            min="1"
            max="7"
            step="1"
            bind:value={cContractWorkDays}
            class="input"
          />
          <p class="hint">
            Vertragliche Anzahl Arbeitstage pro Woche. Welche Wochentage das konkret sind, bestimmt
            der Schichtplan.
          </p>
        </div>
        <div class="form-group form-group--full">
          <!-- Issue #481 R5: required for SHIFT_BASED; the server is authoritative. -->
          <label class="form-label"
            >Übliche Arbeitstage <span class="badge badge-gray">Pflicht</span></label
          >
          <div class="weekday-chips" role="group" aria-label="Übliche Arbeitstage">
            {#each [{ value: 1, label: "Mo" }, { value: 2, label: "Di" }, { value: 3, label: "Mi" }, { value: 4, label: "Do" }, { value: 5, label: "Fr" }, { value: 6, label: "Sa" }, { value: 0, label: "So" }] as day (day.value)}
              <button
                type="button"
                class="wd-chip"
                class:wd-chip--active={cUsualWorkDays.includes(day.value)}
                aria-pressed={cUsualWorkDays.includes(day.value)}
                onclick={() => {
                  if (cUsualWorkDays.includes(day.value)) {
                    cUsualWorkDays = cUsualWorkDays.filter((d) => d !== day.value);
                  } else {
                    cUsualWorkDays = [...cUsualWorkDays, day.value].sort((a, b) => a - b);
                  }
                }}>{day.label}</button
              >
            {/each}
          </div>
          <p class="hint">
            Pflicht bei Schichtbetrieb: mindestens so viele Tage wie Arbeitstage pro Woche. In
            angebrochenen Urlaubswochen zählen nur Urlaubstage an diesen Wochentagen; eine volle
            Urlaubswoche kostet immer die vertraglichen Arbeitstage.
          </p>
          {#if usualWorkDaysMissing(cScheduleType, cUsualWorkDays)}
            <div class="callout">
              Bitte die üblichen Arbeitstage ankreuzen – bei Schichtbetrieb Pflicht. Ohne Angabe
              kann der Mitarbeiter nicht angelegt werden.
            </div>
          {:else if usualWorkDaysShortfall(cUsualWorkDays, cContractWorkDays) > 0}
            <div class="callout">
              Bitte mindestens {cContractWorkDays} Tage ankreuzen – so viele Arbeitstage hat der Vertrag.
              Sonst wird die Angabe beim Speichern abgelehnt.
            </div>
          {/if}
        </div>
      {/if}

      {#if cScheduleType === "FLEXTIME"}
        <div class="form-group form-group--full form-subhead">
          <h4 class="form-subhead-title">Kernarbeitszeit (optional)</h4>
        </div>
        <div class="form-group">
          <label class="form-label" for="c-core-start">Kernzeitbeginn</label>
          <input
            id="c-core-start"
            type="time"
            bind:value={cCoreStart}
            class="input"
            placeholder="—"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="c-core-end">Kernzeitende</label>
          <input id="c-core-end" type="time" bind:value={cCoreEnd} class="input" placeholder="—" />
        </div>
        <div class="form-group form-group--full">
          <label class="form-label">Kerntage</label>
          <div class="weekday-chips" role="group" aria-label="Kerntage">
            {#each [{ value: 1, label: "Mo" }, { value: 2, label: "Di" }, { value: 3, label: "Mi" }, { value: 4, label: "Do" }, { value: 5, label: "Fr" }, { value: 6, label: "Sa" }, { value: 0, label: "So" }] as day (day.value)}
              <button
                type="button"
                class="wd-chip"
                class:wd-chip--active={cCoreDays.includes(day.value)}
                onclick={() => {
                  if (cCoreDays.includes(day.value)) {
                    cCoreDays = cCoreDays.filter((d) => d !== day.value);
                  } else {
                    cCoreDays = [...cCoreDays, day.value];
                  }
                }}>{day.label}</button
              >
            {/each}
          </div>
          <p class="hint">Leer lassen für reine Gleitzeit ohne Kernzeit.</p>
        </div>
      {/if}
      <div class="form-group form-group--full">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={cUsePassword} />
          Passwort direkt setzen (statt Einladungsmail)
        </label>
      </div>
      {#if cUsePassword}
        <div class="form-group form-group--full">
          <label class="form-label" for="c-password">Passwort</label>
          <input
            id="c-password"
            type="password"
            bind:value={cPassword}
            class="input"
            minlength="8"
            placeholder="Mindestens 8 Zeichen"
            required
          />
          <p class="hint">Mitarbeiter kann sich sofort anmelden. Kein Einladungslink nötig.</p>
        </div>
      {/if}
    </div>

    <div class="callout brand">
      <div>
        Die Person erhält per E-Mail einen Einladungslink. Stammdaten werden beim ersten Login
        vervollständigt.
      </div>
    </div>
  {/if}
  {#snippet footer()}
    {#if !createEmailError}
      <button class="btn btn-ghost" onclick={() => (createOpen = false)}>Abbrechen</button>
      <button
        class="btn btn-primary"
        onclick={createEmployee}
        disabled={creating || createBlockedByUsualWorkDays || createBlockedByHomeSalon}
      >
        {creating ? "Anlegen…" : "Mitarbeiter anlegen"}
      </button>
    {:else}
      <button class="btn btn-primary" onclick={() => (createOpen = false)}>Schließen</button>
    {/if}
  {/snippet}
</Modal>

<!-- ── Bulk changes: choose the role, preview, one run (Issue #854) ──────────────────────── -->
{#if canAssignRoles}
  <BulkRoleDialog
    bind:open={bulkRoleOpen}
    personCount={selectedCount}
    roles={createRoles}
    mandantRoleIds={createMandantRoleIds}
    salons={$salonContext.salons}
    salonsLoaded={$salonContext.loaded}
    people={createPeople}
    onChoose={onBulkRoleChosen}
  />
{/if}

<BulkPreviewDialog
  bind:open={bulkOpen}
  title={bulkKind === "invitation" ? "Einladungen erneut senden" : "Rolle zuweisen"}
  eyebrow="Sammeländerung"
  count={bulkTargets.length}
  confirmLabel={bulkKind === "invitation" ? "Einladungen senden" : "Rolle zuweisen"}
  pending={bulkRunning}
  onConfirm={runBulk}
>
  {#snippet intro()}
    {#if bulkKind === "role" && bulkChoice}
      <Note tone="info">Zugewiesen wird: {bulkChoiceLabel()}</Note>
    {/if}
    {#if bulkSkipped.length > 0}
      <Note tone="warn">
        {bulkSkipped.length === 1
          ? "Diese Person wird übersprungen"
          : `Diese ${bulkSkipped.length} Personen werden übersprungen`} ({bulkSkipReason}): {bulkSkipped
          .map(personName)
          .join("; ")}
      </Note>
    {/if}
  {/snippet}
  {#snippet list()}
    <p class="bulk-preview-count">
      {bulkTargets.length === 1 ? "Betrifft 1 Person" : `Betrifft ${bulkTargets.length} Personen`}
    </p>
    <ul class="bulk-preview-list" data-testid="admin-employees-bulk-preview-list">
      {#each bulkTargets as emp (emp.id)}
        <li>{personName(emp)}</li>
      {/each}
    </ul>
  {/snippet}
</BulkPreviewDialog>

<!-- ── Deaktivieren mit letztem Arbeitstag (Issue #615) ───────────────────── -->
{#if deactivateDialog.emp}
  <DeactivateEmployeeDialog
    bind:open={deactivateDialog.open}
    employee={deactivateDialog.emp}
    onDeactivated={loadEmployees}
  />
{/if}

<!-- ── Reaktivieren bestätigen ────────────────────────────────────────────── -->
{#if reactivateConfirm.emp}
  <ConfirmDialog
    bind:open={reactivateConfirm.open}
    title="Mitarbeiter reaktivieren?"
    description={`${reactivateConfirm.emp.firstName} ${reactivateConfirm.emp.lastName} kann sich nach der Reaktivierung wieder anmelden.`}
    confirmLabel="Reaktivieren"
    onConfirm={confirmReactivate}
  />
{/if}

<style>
  .list-controls {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .anon-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    align-self: flex-start;
    font-size: var(--fs-sm);
    color: var(--text-2);
    cursor: pointer;
  }
  .anon-toggle input {
    accent-color: var(--brand);
  }

  .col-number {
    color: var(--text-2);
  }
  .col-email {
    color: var(--text-2);
    /* In the card layout the value is a flex item beside its label: let it shrink and break a
       long address inside the viewport (#648). break-word, not anywhere, keeps the table's
       min-content width unchanged. */
    min-width: 0;
    overflow-wrap: break-word;
  }
  .col-date,
  .col-login {
    color: var(--text-2);
    font-size: 13px;
  }

  .bulk-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }
  .bulk-count {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
    margin-right: var(--s-2);
  }

  .bulk-preview-count {
    margin: 0;
    font-weight: 600;
    color: var(--text);
  }
  .bulk-preview-list {
    margin: var(--s-2) 0 0;
    padding-left: var(--s-5);
    max-height: 260px;
    overflow-y: auto;
    color: var(--text);
    font-size: var(--fs-base);
  }

  .action-group {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* Slightly compact buttons inside the actions column */
  .action-group :global(.btn.btn-sm) {
    padding: 6px 10px;
    font-size: 12.5px;
  }

  /* Form helpers used inside modals */
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  @media (max-width: 480px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .form-group--full {
    grid-column: 1 / -1;
  }
  .form-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
    color: var(--text);
    cursor: pointer;
  }

  .hint {
    font-size: 13px;
    color: var(--text-2);
    margin: 4px 0 0;
  }
  .text-muted {
    color: var(--text-2);
    font-weight: 400;
  }

  /* ── Personalstruktur (Phase 41) — subhead + override row ─────────────── */
  .form-subhead {
    margin-top: 6px;
    border-top: 1px solid var(--line);
    padding-top: 14px;
  }
  .form-subhead-title {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin: 0;
  }
  .override-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    flex-wrap: wrap;
  }

  /* ── Weekday chips (Phase 49.2 — FLEXTIME Kernarbeitszeit) ─────────────── */
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
    border: 1.5px solid var(--line);
    background: transparent;
    color: var(--text-2);
  }

  .wd-chip--active {
    background: var(--brand);
    border-color: var(--brand);
    color: var(--brand-ink);
  }

  .wd-chip:hover:not(.wd-chip--active) {
    border-color: var(--brand);
    color: var(--brand);
  }
  .role-chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  /* The one value of this table that may take two lines: "Rolle · Geltungsbereich" is the widest
     cell, and wrapping it (the action buttons already stack to two lines, so the row does not grow)
     keeps the nine columns inside the card at 1440 px without a sideways scroll. A wrapped pill
     would turn into an oval, hence the control radius. */
  .role-chips .chip {
    white-space: normal;
    padding-block: 3px;
    line-height: 1.25;
    border-radius: var(--r-control);
  }
</style>
