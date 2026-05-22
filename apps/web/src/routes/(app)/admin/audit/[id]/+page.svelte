<script lang="ts">
  import { api } from "$api/client";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";

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
  }

  let loading = $state(true);
  let loadError = $state("");
  let entry = $state<AuditEntry | null>(null);

  const entryId = $derived($page.params.id);

  onMount(async () => {
    loading = true;
    loadError = "";
    try {
      entry = await api.get<AuditEntry>(`/audit-logs/${entryId}`);
    } catch (e: unknown) {
      if ((e as { status?: number })?.status === 404) {
        loadError = "Audit-Eintrag nicht gefunden.";
      } else {
        loadError = "Fehler beim Laden des Audit-Eintrags.";
      }
    } finally {
      loading = false;
    }
  });

  function fmtDate(iso: string): string {
    return format(new Date(iso), "dd.MM.yyyy HH:mm:ss", { locale: de });
  }

  function hasValue(v: unknown): boolean {
    if (v == null) return false;
    if (typeof v === "object" && Object.keys(v as Record<string, unknown>).length === 0)
      return false;
    return true;
  }
</script>

<svelte:head>
  <title>Audit-Eintrag – Clokr</title>
</svelte:head>

{#if loading}
  <div class="page-loading">Laden…</div>
{:else if loadError || !entry}
  <div class="page-error">{loadError || "Audit-Eintrag nicht gefunden."}</div>
{:else}
  <ListDetail
    view="detail"
    eyebrow="Compliance"
    title="Audit-Eintrag"
    sub="Vollständiger Eintrag aus dem Audit-Trail"
    crumbs={[
      { label: "Compliance" },
      { label: "Audit", href: "/admin/audit" },
      { label: `Eintrag #${entry.id.slice(0, 8)}` },
    ]}
  >
    {#snippet tabContent(_)}
      <Section title="Details">
        <dl class="entry-dl">
          <dt>Zeitstempel</dt>
          <dd>{fmtDate(entry.createdAt)}</dd>

          <dt>Benutzer</dt>
          <dd>{entry.user?.email ?? entry.userId ?? "—"}</dd>

          <dt>Aktion</dt>
          <dd>{entry.action}</dd>

          <dt>Entität</dt>
          <dd>{entry.entity}{entry.entityId ? ` #${entry.entityId}` : ""}</dd>

          <dt>IP-Adresse</dt>
          <dd>{entry.ipAddress ?? "—"}</dd>

          <dt>User-Agent</dt>
          <dd class="ua">{entry.userAgent ?? "—"}</dd>

          <dt>Bereinigbar</dt>
          <dd>{entry.purgeable ? "Ja (automatisch nach 90 Tagen)" : "Nein"}</dd>
        </dl>

        {#if hasValue(entry.oldValue)}
          <h3 class="value-heading">Vorher</h3>
          <pre class="value-pre">{JSON.stringify(entry.oldValue, null, 2)}</pre>
        {/if}

        {#if hasValue(entry.newValue)}
          <h3 class="value-heading">Nachher</h3>
          <pre class="value-pre">{JSON.stringify(entry.newValue, null, 2)}</pre>
        {/if}
      </Section>
    {/snippet}
  </ListDetail>
{/if}

<style>
  .page-loading,
  .page-error {
    padding: var(--s-6);
    color: var(--text-muted);
    font-size: 14px;
  }

  .page-error {
    color: var(--bad);
  }

  .entry-dl {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: var(--s-3) var(--s-4);
    margin: 0;
  }

  .entry-dl dt {
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: flex;
    align-items: center;
  }

  .entry-dl dd {
    margin: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    word-break: break-all;
  }

  .ua {
    font-size: 11.5px;
    color: var(--text-muted);
    word-break: break-word;
  }

  .value-heading {
    margin: var(--s-6) 0 var(--s-2);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .value-pre {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s-4);
    overflow-x: auto;
    overflow-y: auto;
    max-height: 320px;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
  }

  @media (max-width: 480px) {
    .entry-dl {
      grid-template-columns: 1fr;
      gap: var(--s-1) 0;
    }
    .entry-dl dd {
      padding-bottom: var(--s-3);
    }
  }
</style>
