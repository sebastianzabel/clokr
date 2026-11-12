<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { employeeAdminRights } from "$lib/page-rights";
  import { api } from "$api/client";
  import { salonContext } from "$stores/salon-context";
  import {
    createRoleAssignment,
    listAssignablePeople,
    listRoleAssignments,
    loadAssignmentChoices,
    type AccessRole,
    type AssignablePerson,
    type AssignmentScope,
    type RoleAssignment,
  } from "$lib/api/roles";
  import { draftLabel } from "$lib/roles/assignment-drafts";
  import { toasts } from "$stores/toast";
  import { hasPermission } from "$lib/permissions";
  import {
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
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DeactivateEmployeeDialog from "$lib/components/admin/DeactivateEmployeeDialog.svelte";
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import TableToolbar, { type ToolbarFilter } from "$components/ui/TableToolbar.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import CreatePersonDialog from "$lib/components/employees/CreatePersonDialog.svelte";
  import { MISSING_BIRTH_DATE_HINT } from "$lib/statutory-minimum-vacation";
  import type { EmployeeClassification } from "$lib/employee-classification";

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

  // Create flow (Issue #854): the guided dialog owns the person's draft, the salon list and the
  // tenant defaults. The role choices stay here because the bulk role dialog shares them.
  let createOpen = $state(false);
  let createRoles = $state<AccessRole[]>([]);
  let createMandantRoleIds = $state<string[]>([]);
  let createPeople = $state<AssignablePerson[]>([]);
  let createRoleChoicesFailed = $state(false);

  // Controls follow the caller's permissions (Issue #538); the API refuses anything beyond them.
  let rights = $derived(employeeAdminRights($authStore.user));
  let canCreate = $derived(rights.canCreate);
  let canManageAccess = $derived(rights.canManageAccess);
  let canAssignRoles = $derived(rights.canAssignRoles);
  let canReadRoles = $derived(hasPermission($authStore.user, "role:read:ZUGEWIESEN"));
  let showActions = $derived(rights.showActions);

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
    createRoleChoicesFailed = false;
    void loadCreateRoleChoices();
    createOpen = true;
  }

  // The dialog reports the new person as soon as it exists: the list and the role column reload.
  async function onPersonCreated() {
    await loadEmployees();
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
          >+ Person anlegen</button
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

<!-- ── Person anlegen: the guided dialog (Issue #854, D-854-06) ───────────────────────────── -->
{#if canCreate}
  <CreatePersonDialog
    bind:open={createOpen}
    onCreated={onPersonCreated}
    roles={createRoles}
    mandantRoleIds={createMandantRoleIds}
    people={createPeople}
    roleChoicesFailed={createRoleChoicesFailed}
  />
{/if}

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

  .text-muted {
    color: var(--text-2);
    font-weight: 400;
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
