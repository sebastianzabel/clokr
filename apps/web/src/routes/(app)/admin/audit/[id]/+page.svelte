<!--
  Verwalten › Daten › Protokoll › one entry (Issue #583, #854, D-854-10): who changed what and when, with a
  before/after table of the changed fields. The heading, the object and the field names are German words from
  `$lib/audit/labels` (a code never shows raw; an unknown field reads „Weiteres Feld“). Values are rendered as
  TEXT only (no `{@html}`, T-854-58): a stored free text appears as stored - its redaction happened at
  anonymisation time (#512). The back link returns to the list with the filters it was opened from, passed
  through the same allow-list schema as the list itself.
-->
<script lang="ts">
  import { showDetailCrumb } from "$lib/nav/detail-crumb";
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";
  import { api, ApiError } from "$api/client";
  import { parseUrlState, serialiseUrlState } from "$lib/table/url-state";
  import { auditActorLabel } from "$lib/audit/actor-label";
  import { auditEntryTitle, auditFieldRows, type AuditFieldRow } from "$lib/audit/field-diff";
  import { entityLabel } from "$lib/audit/labels";
  import { listUrlSchema } from "$lib/audit/list-url-state";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  interface AuditEntry {
    id: string;
    userId: string | null;
    action: string;
    entity: string;
    entityId: string | null;
    oldValue: unknown;
    newValue: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    purgeable: boolean;
    createdAt: string;
    user: { email: string } | null;
    affectedEmployee: { firstName: string; lastName: string; employeeNumber: string } | null;
  }

  let loading = $state(true);
  let loadError = $state("");
  let entry = $state<AuditEntry | null>(null);
  // The entry closes the top bar's path (#854: pages carry no breadcrumb of their own).
  $effect(() => showDetailCrumb(entry ? `Eintrag vom ${fmtDate(entry.createdAt)}` : null));

  const entryId = $derived($page.params.id);

  // The list's filters arrive as the query of this URL; only the allow-listed keys are passed back.
  const backHref = $derived.by(() => {
    const state = parseUrlState(listUrlSchema, $page.url.searchParams);
    const query = serialiseUrlState(listUrlSchema, state);
    return `/verwalten/daten/protokoll${query === "" ? "" : `?${query}`}`;
  });

  onMount(async () => {
    loading = true;
    loadError = "";
    try {
      entry = await api.get<AuditEntry>(`/audit-logs/${entryId}`);
    } catch (e: unknown) {
      loadError =
        e instanceof ApiError && e.status === 404
          ? "Dieser Protokolleintrag wurde nicht gefunden."
          : "Der Protokolleintrag konnte nicht geladen werden.";
    } finally {
      loading = false;
    }
  });

  function fmtDate(iso: string): string {
    return format(new Date(iso), "dd.MM.yyyy HH:mm:ss", { locale: de });
  }

  const columns: DataTableColumn[] = [
    { key: "field", label: "Feld", primary: true },
    { key: "before", label: "Vorher" },
    { key: "after", label: "Nachher" },
  ];

  const rows = $derived<AuditFieldRow[]>(
    entry ? auditFieldRows(entry.entity, entry.oldValue, entry.newValue) : [],
  );
  const actor = $derived(entry ? auditActorLabel(entry) : null);
  const title = $derived(entry ? auditEntryTitle(entry.action, entry.entity) : "Protokolleintrag");
</script>

<svelte:head>
  <title>{title} – {pageLabel("/admin/audit")} – Clokr</title>
</svelte:head>

<div data-testid="admin-audit-detail-page" style="display: contents;">
  {#if loading}
    <Skeleton shape="card" lines={4} />
  {:else if loadError || !entry}
    <div role="alert">
      <Note tone="bad">{loadError || "Dieser Protokolleintrag wurde nicht gefunden."}</Note>
    </div>
    <a class="btn btn-secondary" href={backHref}>Zurück zum Protokoll</a>
  {:else}
    <PageHead {title} sub="Was in diesem Eintrag festgehalten wurde.">
      {#snippet actions()}
        <!-- The crumb leads to the plain list; this link keeps the filters the entry was opened from. -->
        <a class="btn btn-secondary" href={backHref} data-testid="admin-audit-back"
          >Zurück zum Protokoll</a
        >
      {/snippet}
    </PageHead>

    <section class="settings-group" aria-labelledby="audit-who-title">
      <h2 class="settings-group-title" id="audit-who-title">Wer und wann</h2>
      <dl class="entry-dl">
        <div>
          <dt>Zeitpunkt</dt>
          <dd>{fmtDate(entry.createdAt)}</dd>
        </div>
        <div>
          <dt>Wer</dt>
          <dd>{actor?.text ?? "—"}</dd>
        </div>
        <div>
          <dt>Betroffene Person</dt>
          <dd>
            {#if entry.affectedEmployee}
              {entry.affectedEmployee.lastName}, {entry.affectedEmployee.firstName} ({entry
                .affectedEmployee.employeeNumber})
            {:else}
              —
            {/if}
          </dd>
        </div>
        <div>
          <dt>Objekt</dt>
          <dd>
            {entityLabel(entry.entity)}
            {#if entry.entityId}<span class="entry-mono">{entry.entityId}</span>{/if}
          </dd>
        </div>
        <div>
          <dt>IP-Adresse</dt>
          <dd class="entry-mono">{entry.ipAddress ?? "—"}</dd>
        </div>
        <div>
          <dt>Browser</dt>
          <dd class="entry-ua">{entry.userAgent ?? "—"}</dd>
        </div>
        <div>
          <dt>Löschung</dt>
          <dd>{entry.purgeable ? "Wird nach 90 Tagen automatisch gelöscht" : "Wird aufbewahrt"}</dd>
        </div>
      </dl>
    </section>

    <section class="settings-group" aria-labelledby="audit-changes-title">
      <h2 class="settings-group-title" id="audit-changes-title">Änderungen</h2>
      {#if rows.length === 0}
        <Note tone="info">Zu diesem Eintrag wurden keine einzelnen Feldwerte gespeichert.</Note>
      {:else}
        <DataTable
          {columns}
          {rows}
          rowKey={(row) => row.key}
          caption="Geänderte Felder mit den Werten vorher und nachher"
        >
          {#snippet cell(row, column)}
            {#if column.key === "field"}
              {row.label}
              {#if row.changed}<Chip tone="info">geändert</Chip>{/if}
            {:else if column.key === "before"}
              <span class="entry-value">{row.before}</span>
            {:else if column.key === "after"}
              <span class="entry-value">{row.after}</span>
            {/if}
          {/snippet}
        </DataTable>
      {/if}
    </section>
  {/if}
</div>

<style>
  /* Each pair is one cell of a responsive grid: no breakpoint, the columns follow the available width. */
  .entry-dl {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
    gap: var(--s-4);
    margin: 0;
  }

  .entry-dl > div {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 0;
  }

  .entry-dl dt {
    color: var(--text-2);
    font-size: var(--fs-sm);
    font-weight: 600;
  }

  .entry-dl dd {
    margin: 0;
    color: var(--text);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .entry-mono {
    font-family: var(--font-code);
    font-size: var(--fs-sm);
  }

  .entry-ua {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .entry-value {
    overflow-wrap: anywhere;
  }
</style>
