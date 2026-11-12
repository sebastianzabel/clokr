<!--
  Verwalten › Daten › Protokoll (Issue #583, #854, D-854-10/-11/-19/-21): who changed what and when, in German
  words only. The list shows Zeitpunkt · Wer · Was · Betroffene Person · Objekt, filtered by period (default:
  the last 30 days), affected person and object kind; the filters live in the URL (`list-url-state.ts`), the
  words come only from `$lib/audit/labels` (codes stay control values). „Als CSV exportieren“ downloads
  exactly the filtered list through `GET /audit-logs/export`. The second tab holds the retention period
  (registry section `protokoll-aufbewahrung`). An entry's before/after table is the detail page.

  Reading is `audit-log:read` (the API decides); the person filter is offered only to a caller who may read
  people, and its options are the reach-scoped `GET /employees` answer.
-->
<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";
  import { api } from "$api/client";
  import { downloadFromApi } from "$api/download";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { toasts } from "$stores/toast";
  import { hasPermission } from "$lib/permissions";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import { urlState } from "$lib/table/url-state";
  import { auditActorLabel } from "$lib/audit/actor-label";
  import { actionLabel, AUDIT_ENTITY_CODES, entityLabel } from "$lib/audit/labels";
  import {
    auditExportQuery,
    auditQuery,
    effectiveFilters,
    exportProblem,
    listUrlSchema,
    localDay,
    periodProblem,
  } from "$lib/audit/list-url-state";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import RetentionSection from "$lib/components/admin/protokoll/RetentionSection.svelte";
  import Chip, { type ChipTone } from "$components/ui/Chip.svelte";
  import Combobox from "$components/ui/Combobox.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import DatePicker from "$components/ui/DatePicker.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  // ── Tabs (D-854-26: lowercase German ids) ──
  const TABS = [
    { value: "protokoll", label: "Protokoll" },
    { value: "aufbewahrung", label: "Aufbewahrung" },
  ];
  const TAB_IDS = TABS.map((tab) => tab.value);
  let activeTab = $state<string>("protokoll");

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  // A type alias, not an interface: DataTable rows must be assignable to Record<string, unknown>.
  type AuditRow = {
    id: string;
    action: string;
    entity: string;
    entityId: string | null;
    newValue: unknown;
    createdAt: string;
    user: { email: string } | null;
    affectedEmployee: { firstName: string; lastName: string; employeeNumber: string } | null;
  };

  interface AuditResponse {
    logs: AuditRow[];
    total: number;
    page: number;
    limit: number;
  }

  type PersonOption = { id: string; firstName: string; lastName: string; employeeNumber: string };

  // ── The filters: the URL is the state ──
  const listUrl = urlState(listUrlSchema);
  const urlFilters = $derived(listUrl.read());
  // Browser-local calendar day: the web has no tenant-local "today" helper (the API judges by the tenant zone).
  const today = localDay();
  const filters = $derived(effectiveFilters(urlFilters, today));
  const problem = $derived(periodProblem(filters));
  // „keine Treffer“ (not „noch nichts da“) whenever the person set a filter of their own.
  const filtersActive = $derived(
    Boolean(urlFilters.from || urlFilters.to || urlFilters.employeeId || urlFilters.entity),
  );

  let pageSize = $state(25);
  const listQuery = $derived(
    problem === null
      ? auditQuery(urlFilters, { today, paging: { page: urlFilters.page, limit: pageSize } })
      : null,
  );

  function resetFilters() {
    listUrl.write({ from: "", to: "", employeeId: "", entity: "", page: 1 });
  }

  // The object kinds on offer: every code of the vocabulary, sorted by its German word.
  const entityOptions = AUDIT_ENTITY_CODES.map((code) => ({ code, label: entityLabel(code) })).sort(
    (a, b) => a.label.localeCompare(b.label, "de"),
  );

  // ── The list ──
  let logs: AuditRow[] = $state([]);
  let total = $state(0);
  let loading = $state(true);
  let loadError = $state("");
  // Plain let: an older response never overwrites a newer one (not reactive on purpose).
  let generation = 0;

  async function loadLogs(query: string) {
    const mine = ++generation;
    loading = true;
    loadError = "";
    try {
      const res = await api.get<AuditResponse>(`/audit-logs?${query}`);
      if (mine !== generation) return;
      logs = res.logs;
      total = res.total;
    } catch (e: unknown) {
      if (mine !== generation) return;
      logs = [];
      total = 0;
      loadError = e instanceof Error ? e.message : "Das Protokoll konnte nicht geladen werden.";
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    const query = listQuery;
    if (query === null) {
      // An impossible period (end before start) lists nothing; the field names the problem.
      generation += 1;
      logs = [];
      total = 0;
      loading = false;
      loadError = "";
      return;
    }
    untrack(() => void loadLogs(query));
  });

  // A link to a page beyond the last one lands on the last one.
  $effect(() => {
    if (!loading && !loadError && logs.length === 0 && total > 0 && urlFilters.page > 1) {
      const last = Math.max(1, Math.ceil(total / pageSize));
      untrack(() => listUrl.write({ page: Math.min(urlFilters.page, last) }));
    }
  });

  // Writable derived: the URL is the state, Pagination may move it locally until the URL write lands.
  let pageNumber = $derived(urlFilters.page);

  // ── The person filter (offered only to a caller who may read people) ──
  const user = $derived($authStore.user);
  const canPickPerson = $derived(hasPermission(user, "employee:read:ZUGEWIESEN"));
  const ALL_PEOPLE = "__all__";
  let people = $state<PersonOption[]>([]);

  async function loadPeople() {
    try {
      people = await api.get<PersonOption[]>("/employees?includeAnonymized=true");
    } catch {
      // The filter then offers only „Alle Personen“; the list itself is unaffected.
      people = [];
    }
  }

  const personItems = $derived.by(() => {
    const items = [
      { value: ALL_PEOPLE, label: "Alle Personen" },
      ...people
        .map((p) => ({
          value: p.id,
          label: `${p.lastName}, ${p.firstName} (${p.employeeNumber})`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "de")),
    ];
    // A person named by a link but not in the offered list stays selectable and visible.
    if (urlFilters.employeeId && !items.some((item) => item.value === urlFilters.employeeId)) {
      items.push({ value: urlFilters.employeeId, label: "Ausgewählte Person" });
    }
    return items;
  });

  // ── Table ──
  const columns: DataTableColumn[] = [
    { key: "time", label: "Zeitpunkt", primary: true },
    { key: "who", label: "Wer" },
    { key: "what", label: "Was" },
    { key: "person", label: "Betroffene Person" },
    { key: "object", label: "Objekt" },
  ];

  function fmtDate(iso: string): string {
    return format(new Date(iso), "dd.MM.yyyy HH:mm:ss", { locale: de });
  }

  /** Tone by the action CODE (a control value); the label is display only. */
  function actionTone(code: string): ChipTone {
    if (code === "CREATE") return "brand";
    if (code === "UPDATE") return "warn";
    if (code === "DELETE") return "bad";
    if (code === "LOGIN") return "ok";
    return "neutral";
  }

  /** The list's own query string, so the detail's back link returns to the same filtered list. */
  function detailHref(id: string): string {
    return `/verwalten/daten/protokoll/${id}${$page.url.search}`;
  }

  // ── CSV export of exactly the filtered list ──
  let exporting = $state(false);

  async function exportCsv() {
    if (exporting) return;
    const refused = problem ?? exportProblem(filters, today);
    if (refused) {
      toasts.error(refused);
      return;
    }
    exporting = true;
    try {
      await downloadFromApi(
        `/audit-logs/export?${auditExportQuery(urlFilters, today)}`,
        "protokoll.csv",
      );
      toasts.success("Die Datei mit dem Protokoll wurde heruntergeladen.");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Der Export ist fehlgeschlagen.");
    } finally {
      exporting = false;
    }
  }

  // ── Aufbewahrung (registry section) ──
  type Loaded<T> =
    { status: "loading" } | { status: "ready"; data: T } | { status: "failed"; message: string };
  let retention = $state<Loaded<{ dataRetentionYears?: number | null }>>({ status: "loading" });
  let retentionChanges = $state(0);

  async function loadRetention() {
    try {
      retention = { status: "ready", data: await api.get("/settings/work") };
    } catch (e: unknown) {
      retention = {
        status: "failed",
        message:
          e instanceof Error ? e.message : "Die Aufbewahrungsfrist konnte nicht geladen werden.",
      };
    }
  }

  // Gated on "a baseline has been taken": a page that shows nothing but an error must not arm the guard.
  const snapshotsReady = $derived(retention.status === "ready");

  $effect(() => {
    markUnsaved("admin-audit", snapshotsReady && retentionChanges > 0);
    return () => markUnsaved("admin-audit", false);
  });

  onMount(() => {
    activeTab = tabFromHash($page.url.hash, TAB_IDS);
    void loadRetention();
    if (untrack(() => canPickPerson)) void loadPeople();
  });
</script>

<svelte:head>
  <title>{pageLabel("/admin/audit")} – Clokr</title>
</svelte:head>

<div data-testid="admin-audit-page" style="display: contents;">
  <PageHead
    title={pageLabel("/admin/audit")}
    sub="Hier siehst du, wer wann was geändert hat, und legst fest, wie lange Daten aufbewahrt werden."
  />

  <PageTabs tabs={TABS} tab={activeTab} onTabChange={selectTab} tabsLabel="Bereiche des Protokolls">
    {#snippet panel(value)}
      {#if value === "protokoll"}
        {#if loadError}
          <ErrorState message={loadError} onRetry={() => listQuery && loadLogs(listQuery)} />
        {:else}
          <DataTable
            {columns}
            rows={logs}
            rowKey={(row) => row.id}
            rowTestId={(row) => `admin-audit-row-${row.id}`}
            onRowClick={(row) => goto(detailHref(row.id))}
            filtered={filtersActive}
            onResetFilters={resetFilters}
            {loading}
            caption="Protokolleinträge: Zeitpunkt, Wer, Was, Betroffene Person und Objekt"
          >
            {#snippet toolbar()}
              <div class="audit-controls">
                <div class="audit-controls-fields">
                  <FormField label="Von" error={problem ?? undefined}>
                    {#snippet field({ id, describedBy, invalid })}
                      <DatePicker
                        label="Von"
                        value={filters.from}
                        max={filters.to || undefined}
                        {id}
                        {describedBy}
                        {invalid}
                        onValueChange={(next) => listUrl.write({ from: next ?? "", page: 1 })}
                      />
                    {/snippet}
                  </FormField>
                  <FormField label="Bis">
                    {#snippet field({ id, describedBy })}
                      <DatePicker
                        label="Bis"
                        value={filters.to || null}
                        min={filters.from || undefined}
                        {id}
                        {describedBy}
                        onValueChange={(next) => listUrl.write({ to: next ?? "", page: 1 })}
                      />
                    {/snippet}
                  </FormField>
                  {#if canPickPerson}
                    <FormField label="Betroffene Person">
                      {#snippet field({ id, describedBy })}
                        <Combobox
                          items={personItems}
                          value={urlFilters.employeeId || ALL_PEOPLE}
                          label="Betroffene Person"
                          {id}
                          {describedBy}
                          onValueChange={(next) =>
                            listUrl.write({
                              employeeId: next === ALL_PEOPLE ? "" : next,
                              page: 1,
                            })}
                        />
                      {/snippet}
                    </FormField>
                  {/if}
                  <FormField label="Objekt">
                    {#snippet field({ id, describedBy })}
                      <select
                        {id}
                        class="form-input"
                        value={urlFilters.entity}
                        aria-describedby={describedBy}
                        data-testid="admin-audit-filter-entity"
                        onchange={(event) =>
                          listUrl.write({ entity: event.currentTarget.value, page: 1 })}
                      >
                        <option value="">Alle Objekte</option>
                        {#each entityOptions as option (option.code)}
                          <option value={option.code}>{option.label}</option>
                        {/each}
                      </select>
                    {/snippet}
                  </FormField>
                </div>
                <div class="audit-controls-actions">
                  {#if filtersActive}
                    <button type="button" class="btn btn-ghost" onclick={resetFilters}>
                      Filter zurücksetzen
                    </button>
                  {/if}
                  <button
                    type="button"
                    class="btn btn-secondary"
                    onclick={exportCsv}
                    disabled={exporting || problem !== null}
                    data-testid="admin-audit-export"
                  >
                    {#if exporting}<Spinner size={14} label="Datei wird erstellt" />{/if}
                    Als CSV exportieren
                  </button>
                </div>
              </div>
              {#if !loading}
                <p class="audit-count" aria-live="polite">
                  {total.toLocaleString("de-DE")}
                  {total === 1 ? "Eintrag" : "Einträge"}
                </p>
              {/if}
            {/snippet}
            {#snippet cell(row, column)}
              {#if column.key === "time"}
                <span class="audit-time">{fmtDate(row.createdAt)}</span>
              {:else if column.key === "who"}
                {@const actor = auditActorLabel(row)}
                {#if actor.kind === "user"}{actor.text}{:else}<span class="audit-muted"
                    >{actor.text}</span
                  >{/if}
              {:else if column.key === "what"}
                <Chip tone={actionTone(row.action)}>{actionLabel(row.action)}</Chip>
              {:else if column.key === "person"}
                {#if row.affectedEmployee}
                  {row.affectedEmployee.lastName}, {row.affectedEmployee.firstName}
                  <span class="audit-muted">({row.affectedEmployee.employeeNumber})</span>
                {:else}
                  <span class="audit-muted">—</span>
                {/if}
              {:else if column.key === "object"}
                {entityLabel(row.entity)}
              {/if}
            {/snippet}
          </DataTable>
          {#if !loading && total > 0}
            <Pagination
              {total}
              bind:page={pageNumber}
              bind:pageSize
              onChange={(next) => listUrl.write({ page: next.page })}
              labelSingular="Eintrag"
              labelPlural="Einträge"
            />
          {/if}
        {/if}
      {:else if value === "aufbewahrung"}
        {#if retention.status === "loading"}
          <Skeleton shape="card" lines={3} />
        {:else if retention.status === "failed"}
          <div role="alert"><Note tone="bad">{retention.message}</Note></div>
        {:else}
          <RetentionSection config={retention.data} bind:changes={retentionChanges} />
        {/if}
        <Note tone="info">
          Daten einer Person exportierst oder anonymisierst du unter
          <a href="/verwalten/personen">Verwalten › Personen</a>.
        </Note>
      {/if}
    {/snippet}
  </PageTabs>
</div>

<style>
  .audit-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--s-3);
  }

  .audit-controls-fields {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--s-3);
    min-width: 0;
  }

  .audit-controls-fields > :global(.form-field) {
    width: 12rem;
    max-width: 100%;
  }

  .audit-controls-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .audit-count {
    margin: var(--s-2) 0 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .audit-time {
    white-space: nowrap;
  }

  .audit-muted {
    color: var(--text-2);
  }
</style>
