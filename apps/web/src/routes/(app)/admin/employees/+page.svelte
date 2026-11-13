<script lang="ts">
  // Verwalten › Personen (Issue #854, owner review after #853): the same table as Team › Personen -
  // `PersonenTable` with the rows, filters and sort of `personen-model.ts` - plus what only the admin
  // list needs: „Person anlegen“, the row selection with its bulk changes and CSV export, and
  // „Anonymisierte anzeigen“. No e-mail or last-login column and no buttons per row: a row opens the
  // person, whose Zugang tab holds invitation, deactivation and reactivation. The data is
  // `GET /employees?include=directory` (Stammsalon and role names from the server, #853) plus the
  // anonymised rows for holders of employee:anonymize.
  import { pageLabel } from "$lib/nav/page-labels";
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { employeeAdminRights } from "$lib/page-rights";
  import { api } from "$api/client";
  import { salonContext, showSalonOptions } from "$stores/salon-context";
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
  import { groupAssignmentsByUser } from "$lib/roles/assignment-label";
  import {
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    withSalonId,
  } from "$lib/salons/page-scope";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import type { DataTableSort } from "$components/ui/DataTable.svelte";
  import PersonenTable from "$lib/components/employees/PersonenTable.svelte";
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
  import Chip from "$components/ui/Chip.svelte";
  import BulkRoleDialog from "$lib/components/employees/BulkRoleDialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import CreatePersonDialog from "$lib/components/employees/CreatePersonDialog.svelte";
  import { MISSING_BIRTH_DATE_HINT } from "$lib/statutory-minimum-vacation";
  import type { EmployeeClassification } from "$lib/employee-classification";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import { fmtMin } from "$lib/utils/format-minutes";
  import {
    activeCount,
    activeCountSentence,
    filterPersonen,
    isAnonymizedPerson,
    personenRows,
    sortPersonen,
    type PersonenEmployee,
    type PersonenRow,
    type PersonenSortKey,
  } from "$lib/team/personen-model";
  import { verwaltenPersonenUrlSchema as personenUrlSchema } from "$lib/team/personen-url-state";

  // What the admin list reads beyond the shared table's fields.
  type Employee = PersonenEmployee & {
    userId: string;
    birthDate: string | null;
    classification: EmployeeClassification;
  };

  let employees: Employee[] = $state([]);
  let loading = $state(true);
  // Issue #558 D-11: the header salon narrows the list. The page decides only through
  // `salonPageFilter` (never the store's raw selection) and reloads from an effect that reads
  // primitive deriveds only.
  const contextLoaded = $derived($salonContext.loaded);
  const pageSalonId = $derived(salonPageFilter($salonContext));
  const scopeLabel = $derived(salonScopeLabel($salonContext));
  // Presentation only: the salon name of the head sentence is never compared or sent anywhere.
  const pageSalonName = $derived(
    pageSalonId === null
      ? null
      : ($salonContext.salons.find((salon) => salon.id === pageSalonId)?.name ?? null),
  );
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

  // The stored role assignments per user id, loaded only for a caller who may manage them: the bulk
  // role change skips a person who already holds the chosen assignment. The table's role names come
  // from the server (`include=directory`).
  let assignmentsByUser = $state<Record<string, RoleAssignment[]> | null>(null);
  let assignmentPeople = $state<AssignablePerson[]>([]);
  let assignmentCtx = $derived({
    salons: $salonContext.salons,
    salonsLoaded: $salonContext.loaded,
    people: assignmentPeople,
  });

  // ── Table state in the URL: the keys of Team › Personen, starting on „alle“ (#86, AC-86-6) ──────
  // `filterSearch` is the RAW input text (so a typed trailing space survives the parser's trim); the
  // URL carries the parsed value. A fast typist produces "a", "ab" before the first navigation
  // lands; the echo of "a" must not overwrite the input with "a".
  const listUrl = urlState(personenUrlSchema);
  const view = $derived(listUrl.read());
  let filterSearch = $state(listUrl.read().q);
  let pendingEchoes: string[] = [];
  function onSearchInput(value: string) {
    filterSearch = value;
    const next = personenUrlSchema.q.parse(value);
    if (next === listUrl.read().q) return;
    pendingEchoes = [...pendingEchoes, next];
    listUrl.write({ q: next });
  }
  $effect(() => {
    const q = view.q;
    untrack(() => {
      const index = pendingEchoes.indexOf(q);
      if (index >= 0) {
        pendingEchoes = pendingEchoes.slice(index + 1);
        return;
      }
      // A change the page did not write itself (back/forward, a link): the input follows the URL.
      pendingEchoes = [];
      if (personenUrlSchema.q.parse(filterSearch) !== q) filterSearch = q;
    });
  });

  // The Stammsalon filter is offered only with salon choice (#64 rule) and while the header salon
  // does not narrow the request already (#558).
  const salonFilterOffered = $derived(showSalonOptions($salonContext) && pageSalonId === null);
  const salonOptions = $derived(
    salonFilterOffered
      ? $salonContext.salons.map((salon) => ({ value: salon.id, label: salon.name }))
      : null,
  );
  function onFilterChange(key: "status" | "vertrag" | "salon", value: string) {
    if (key === "status") listUrl.write({ status: value === "aktiv" ? "aktiv" : "alle" });
    else if (key === "vertrag") listUrl.write({ vertrag: personenUrlSchema.vertrag.parse(value) });
    else listUrl.write({ salon: personenUrlSchema.salon.parse(value) });
  }
  function resetFilters() {
    filterSearch = "";
    listUrl.write({ q: "", status: "alle", vertrag: "", salon: "" });
  }
  const tableSort = $derived<DataTableSort>({ key: view.sort, dir: view.dir });
  function onSort(next: DataTableSort | null) {
    if (next === null) listUrl.write({ sort: "name", dir: "asc" });
    else listUrl.write({ sort: next.key as PersonenSortKey, dir: next.dir });
  }

  let showAnonymized = $state(false);

  // ── Rows ────────────────────────────────────────────────────────────────────
  // Browser-local calendar day: the web has no tenant-local "today" helper.
  const today = localCalendarDay();
  const salonNames = $derived(new Map($salonContext.salons.map((salon) => [salon.id, salon.name])));
  const allRows = $derived(
    personenRows(employees, today, salonNames, { includeAnonymized: showAnonymized }),
  );
  const salonFilter = $derived(salonFilterOffered ? view.salon : "");
  // The search filters on the parsed input at once (as before #854), not on the URL's echo.
  const searchQuery = $derived(personenUrlSchema.q.parse(filterSearch));
  const shownRows = $derived(
    sortPersonen(
      filterPersonen(allRows, {
        q: searchQuery,
        status: view.status,
        vertrag: view.vertrag,
        salon: salonFilter,
      }),
      { key: view.sort, dir: view.dir },
    ),
  );
  const filtersActive = $derived(
    searchQuery !== "" || view.status === "aktiv" || view.vertrag !== "" || salonFilter !== "",
  );
  const headSentence = $derived(
    loading || error !== "" || salonRejected
      ? "Lege Personen an, lade sie ein und verwalte ihre Daten."
      : activeCountSentence(activeCount(allRows), pageSalonName),
  );
  const employeeById = $derived(new Map(employees.map((emp) => [emp.id, emp])));
  function personHref(row: PersonenRow): string {
    return `/admin/employees/${encodeURIComponent(row.id)}`;
  }

  // ── Selection and CSV export (Issue #854, D-854-09) ────────────────────────────────────────────
  // The selection is cut down to the persons the filtered list still shows, so a person the filter
  // hides can never be changed or exported unseen.
  let selectedIds = $state<(string | number)[]>([]);
  let selectedEmployees = $derived.by(() => {
    const ids = new Set(selectedIds);
    return shownRows
      .filter((row) => ids.has(row.id))
      .map((row) => employeeById.get(row.id))
      .filter((emp): emp is Employee => emp !== undefined);
  });
  let selectedCount = $derived(selectedEmployees.length);

  // The export carries exactly the columns of the table (never more, T-854-44), without „Öffnen“.
  const EXPORT_COLUMNS = [
    { key: "name", label: "Name" },
    { key: "number", label: "Personalnummer" },
    { key: "salon", label: "Stammsalon" },
    { key: "vertrag", label: "Vertrag" },
    { key: "stunden", label: "Std./Woche" },
    { key: "rollen", label: "Rollen" },
    { key: "status", label: "Status" },
  ];
  function exportSelectedCsv() {
    const ids = new Set(selectedIds);
    const records = shownRows
      .filter((row) => ids.has(row.id))
      .map((row) => ({
        name: row.sortName,
        number: row.number,
        salon: row.salonName,
        vertrag: row.modelLabel,
        stunden: row.weeklyHours === null ? "–" : fmtMin(Math.round(row.weeklyHours * 60)),
        rollen: row.roles,
        status: row.statusLabel,
      }));
    downloadCsv(`personen-${today}.csv`, rowsToCsv(EXPORT_COLUMNS, records));
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
  function assignmentsOf(emp: Employee): RoleAssignment[] {
    return assignmentsByUser?.[emp.userId] ?? [];
  }

  // Who the open preview would touch, and who is named as skipped (with the reason).
  let bulkTargets = $derived(
    bulkKind === "invitation"
      ? selectedEmployees.filter(hasOpenInvitation)
      : selectedEmployees.filter(
          (emp) =>
            !isAnonymizedPerson(emp) &&
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
    const emp = employeeById.get(id);
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

  // Issue #558: this effect owns the list loads; it waits for the salon context so the first
  // request is already filtered, and reloads when the header salon changes.
  $effect(() => {
    if (!contextLoaded) return;
    void pageSalonId;
    untrack(() => {
      void loadEmployees();
    });
  });

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
      // Only the bulk role skip reads it; a failed read skips nobody and the API still refuses.
      assignmentsByUser = null;
    }
  }

  async function loadEmployees() {
    const generation = ++listGeneration;
    loading = true;
    error = "";
    try {
      // The list asks for anonymised rows too (the server returns them only to holders of
      // employee:anonymize); „Anonymisierte anzeigen“ then shows them.
      const [list] = await Promise.all([
        api.get<Employee[]>(
          withSalonId("/employees?include=directory&includeAnonymized=true", pageSalonId),
        ),
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

  // The dialog reports the new person as soon as it exists: the list reloads.
  async function onPersonCreated() {
    await loadEmployees();
  }
</script>

<svelte:head>
  <title>{pageLabel("/admin/employees")} – Clokr</title>
</svelte:head>

<!-- Phase 73-05 (D-05): data-testid surface for admin-employees flows (stable page-root selector). -->
<div class="personen-page" data-testid="admin-employees-page">
  <PageHead title={pageLabel("/admin/employees")} sub={headSentence}>
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
      title="Noch keine Personen angelegt"
      actionLabel={canCreate ? "Jetzt anlegen" : undefined}
      onaction={canCreate ? openCreate : undefined}
    />
  {:else}
    <PersonenTable
      rows={shownRows}
      total={allRows.length}
      {loading}
      query={filterSearch}
      onQueryInput={onSearchInput}
      filter={{ status: view.status, vertrag: view.vertrag, salon: view.salon }}
      {salonOptions}
      {onFilterChange}
      onReset={resetFilters}
      filtered={filtersActive && allRows.length > 0}
      sort={tableSort}
      {onSort}
      rowTestIdPrefix="admin-employees-row"
      cellTestIds
      openHref={personHref}
      openLabel={(row) => `${row.name} öffnen`}
      onOpen={(row) => goto(personHref(row))}
      selectable
      bind:selectedKeys={selectedIds}
    >
      {#snippet toolbarExtra()}
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
      {/snippet}
      {#snippet nameMeta(row)}
        {@const emp = employeeById.get(row.id)}
        {#if emp && emp.classification === "AZUBI" && !emp.birthDate}
          <!-- Short in the row (the full hint would widen the name column past the card); the whole
               sentence is the chip's title and its accessible name. -->
          <span
            data-testid={`admin-employees-row-${row.id}-birthdate-hint`}
            title={MISSING_BIRTH_DATE_HINT}
            aria-label={MISSING_BIRTH_DATE_HINT}
            role="note"
          >
            <Chip tone="warn">Geburtsdatum fehlt</Chip>
          </span>
        {/if}
      {/snippet}
    </PersonenTable>
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

<style>
  /* The wrapper only carries the page's test id; its children stack like Team › Personen's. */
  .personen-page {
    display: contents;
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
</style>
