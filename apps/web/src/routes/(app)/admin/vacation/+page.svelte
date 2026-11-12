<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import type { AbwesenheitenConfig } from "$lib/settings/abwesenheiten";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import UebertragPanel from "$lib/components/admin/abwesenheiten/UebertragPanel.svelte";
  import UrlaubPanel from "$lib/components/admin/abwesenheiten/UrlaubPanel.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  // ── Tabs (D-854-26: lowercase German ids; Betriebsurlaub and Urlaubsgrenzen join in plans 854-12/13) ──
  const TABS = [
    { value: "urlaub", label: "Urlaub" },
    { value: "sonderurlaub", label: "Sonderurlaub" },
    { value: "uebertrag", label: "Übertrag" },
  ];
  const TAB_IDS = TABS.map((tab) => tab.value);
  let activeTab = $state<string>("urlaub");

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  let config = $state<AbwesenheitenConfig>({});
  let loading = $state(true);
  let error = $state("");

  async function loadConfig() {
    loading = true;
    error = "";
    try {
      config = await api.get<AbwesenheitenConfig>("/settings/work");
      snapshotsReady = true;
    } catch (e: unknown) {
      console.error(e);
      error = "Die Einstellungen konnten nicht geladen werden.";
    } finally {
      loading = false;
    }
  }

  // Issue #83 (D-13): access is decided by the admin layout guard (admin-route-permissions.ts);
  // the API answers 403 regardless.
  onMount(() => {
    activeTab = tabFromHash($page.url.hash, TAB_IDS);
    void loadConfig();
  });

  // The unsaved counts of the panels, summed into ONE registration (a second registration under the same id
  // would let one panel's cleanup disarm the other's).
  let urlaubChanges = $state(0);
  let uebertragChanges = $state(0);

  // Gate the registration on "the baseline has been taken" (WR-01): a failed load must not arm the
  // navigation guard on a page that shows nothing but an error.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-vacation", snapshotsReady && urlaubChanges + uebertragChanges > 0);
    return () => markUnsaved("admin-vacation", false);
  });

  // The overview figures follow what a panel just saved.
  function merge(saved: Partial<AbwesenheitenConfig>) {
    config = { ...config, ...saved };
  }

  // ── Sonderurlaub (merged from /admin/special-leave; moves into its own panel in the next step) ──
  interface SpecialLeaveRule {
    id: string;
    name: string;
    reason: string | null;
    defaultDays: number;
    isStatutory: boolean;
    requiresProof: boolean;
    isActive: boolean;
  }
  let slRules: SpecialLeaveRule[] = $state([]);
  let slLoading = $state(false);
  let slPage = $state(1);
  let slPageSize = $state(10);
  let slPagedRules = $derived(slRules.slice((slPage - 1) * slPageSize, slPage * slPageSize));

  // Sonderurlaub — create modal
  let slShowCreate = $state(false);
  let slCreateName = $state("");
  let slCreateReason = $state("");
  let slCreateDays = $state(1);
  let slCreateProof = $state(false);
  let slCreating = $state(false);

  // Sonderurlaub — edit modal (replaces the deleted /[id] route)
  let slShowEdit = $state(false);
  let slEditId = $state("");
  let slEditName = $state("");
  let slEditReason = $state("");
  let slEditDays = $state(1);
  let slEditProof = $state(false);
  let slEditActive = $state(true);
  let slEditStatutory = $state(false);
  let slSaving = $state(false);

  // ── Sonderurlaub: list + CRUD ──────────────────────────────────────────────
  async function loadSLRules() {
    slLoading = true;
    try {
      slRules = await api.get<SpecialLeaveRule[]>("/special-leave/rules");
    } catch {
      toasts.error("Fehler beim Laden der Sonderurlaubsregeln");
    } finally {
      slLoading = false;
    }
  }

  // Lazy-load Sonderurlaub on first visit to that tab (saves a request if the
  // user never opens it).
  let slLoaded = false;
  $effect(() => {
    if (activeTab === "sonderurlaub" && !slLoaded) {
      slLoaded = true;
      loadSLRules();
    }
  });

  function openSLCreate() {
    slCreateName = "";
    slCreateReason = "";
    slCreateDays = 1;
    slCreateProof = false;
    slShowCreate = true;
  }

  async function saveSLCreate() {
    if (!slCreateName.trim()) return;
    slCreating = true;
    try {
      await api.post("/special-leave/rules", {
        name: slCreateName.trim(),
        reason: slCreateReason.trim() || undefined,
        defaultDays: slCreateDays,
        requiresProof: slCreateProof,
      });
      slShowCreate = false;
      await loadSLRules();
      toasts.success("Regel erstellt");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      slCreating = false;
    }
  }

  function openSLEdit(rule: SpecialLeaveRule) {
    slEditId = rule.id;
    slEditName = rule.name;
    slEditReason = rule.reason ?? "";
    slEditDays = Number(rule.defaultDays);
    slEditProof = rule.requiresProof;
    slEditActive = rule.isActive;
    slEditStatutory = rule.isStatutory;
    slShowEdit = true;
  }

  async function saveSLEdit() {
    slSaving = true;
    try {
      await api.put(`/special-leave/rules/${slEditId}`, {
        name: slEditStatutory ? undefined : slEditName.trim() || undefined,
        reason: slEditReason.trim() || null,
        defaultDays: slEditDays,
        requiresProof: slEditProof,
        isActive: slEditActive,
      });
      slShowEdit = false;
      await loadSLRules();
      toasts.success("Regel aktualisiert");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      slSaving = false;
    }
  }
</script>

<svelte:head>
  <title>{pageLabel("/admin/vacation")} – Clokr</title>
</svelte:head>

<PageHead
  title={pageLabel("/admin/vacation")}
  sub="Urlaub, Sonderurlaub und Übertrag für das ganze Unternehmen. Betriebsurlaub und Urlaubsgrenzen folgen auf dieser Seite."
/>

{#if error}
  <ErrorState message={error} onRetry={loadConfig} retrying={loading} />
{:else if loading}
  <Skeleton shape="card" count={2} lines={3} />
{:else}
  <PageTabs
    tabs={TABS}
    tab={activeTab}
    onTabChange={selectTab}
    tabsLabel="Bereiche der Abwesenheiten"
  >
    {#snippet panel(value)}
      {#if value === "urlaub"}
        <UrlaubPanel {config} bind:changes={urlaubChanges} onSaved={merge} />
      {:else if value === "sonderurlaub"}
        <Section
          title="Sonderurlaubs-Regeln"
          sub="Gesetzliche Anlässe (§ 616 BGB) werden automatisch angelegt. Tage und Nachweispflicht können angepasst, zusätzliche betriebliche Anlässe hinzugefügt werden."
        >
          {#snippet footer()}
            <button class="btn btn-primary btn-sm" onclick={openSLCreate}>+ Neue Regel</button>
          {/snippet}

          {#if slLoading}
            <div class="vac-skeleton sl-skel"></div>
          {:else if slRules.length === 0}
            <p class="text-muted">Keine Regeln vorhanden.</p>
          {:else}
            <div class="sl-table-wrap">
              <table class="sl-table">
                <thead>
                  <tr>
                    <th>Anlass</th>
                    <th>Tage</th>
                    <th>Nachweis</th>
                    <th>Art</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {#each slPagedRules as rule (rule.id)}
                    <tr
                      class:sl-inactive={!rule.isActive}
                      class="sl-row"
                      onclick={() => openSLEdit(rule)}
                    >
                      <td>
                        <strong>{rule.name}</strong>
                        {#if rule.reason}
                          <br /><span class="sl-text-sm text-muted">{rule.reason}</span>
                        {/if}
                      </td>
                      <td>{Number(rule.defaultDays)}</td>
                      <td>{rule.requiresProof ? "Ja" : "Nein"}</td>
                      <td>
                        <span
                          class="sl-badge"
                          class:sl-badge-statutory={rule.isStatutory}
                          class:sl-badge-custom={!rule.isStatutory}
                        >
                          {rule.isStatutory ? "Gesetzlich" : "Betrieblich"}
                        </span>
                      </td>
                      <td>
                        <span
                          class="sl-status-dot"
                          class:active={rule.isActive}
                          class:deactivated={!rule.isActive}
                        ></span>
                        {rule.isActive ? "Aktiv" : "Deaktiviert"}
                      </td>
                      <td class="sl-actions-cell">
                        <button
                          class="btn btn-ghost btn-sm"
                          onclick={(e) => {
                            e.stopPropagation();
                            openSLEdit(rule);
                          }}
                        >
                          Bearbeiten
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <Pagination total={slRules.length} bind:page={slPage} bind:pageSize={slPageSize} />
            </div>
          {/if}
        </Section>
      {:else if value === "uebertrag"}
        <UebertragPanel {config} bind:changes={uebertragChanges} onSaved={merge} />
      {/if}
    {/snippet}
  </PageTabs>
{/if}

<!-- ── Sonderurlaub: Create Modal ────────────────────────────────────────── -->
<Modal bind:open={slShowCreate} eyebrow="Neue Regel" title="Sonderurlaubsregel anlegen">
  <div class="form-group">
    <label class="form-label" for="sl-cr-name">Anlass</label>
    <input
      id="sl-cr-name"
      class="form-input"
      bind:value={slCreateName}
      placeholder="z. B. Ehrenamtlicher Einsatz"
    />
  </div>
  <div class="form-group">
    <label class="form-label" for="sl-cr-reason">Beschreibung</label>
    <input
      id="sl-cr-reason"
      class="form-input"
      bind:value={slCreateReason}
      placeholder="Optional"
    />
  </div>
  <div class="form-group">
    <label class="form-label" for="sl-cr-days">Tage</label>
    <input
      id="sl-cr-days"
      type="number"
      class="form-input"
      min="0.5"
      max="30"
      step="0.5"
      bind:value={slCreateDays}
    />
  </div>
  <div class="toggle-row">
    <span class="toggle-row-label">Nachweis erforderlich</span>
    <label class="switch">
      <input type="checkbox" bind:checked={slCreateProof} />
      <span class="switch-slider"></span>
    </label>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={() => (slShowCreate = false)}>Abbrechen</button>
    <button
      class="btn btn-primary"
      onclick={saveSLCreate}
      disabled={slCreating || !slCreateName.trim()}
    >
      {slCreating ? "Erstellen…" : "Erstellen"}
    </button>
  {/snippet}
</Modal>

<!-- ── Sonderurlaub: Edit Modal ──────────────────────────────────────────── -->
<Modal
  bind:open={slShowEdit}
  eyebrow={slEditStatutory ? "Gesetzliche Regel" : "Betriebliche Regel"}
  title={slEditName || "Sonderurlaubsregel"}
>
  <div class="form-group">
    <label class="form-label" for="sl-ed-name">Anlass</label>
    <input id="sl-ed-name" class="form-input" bind:value={slEditName} disabled={slEditStatutory} />
    {#if slEditStatutory}
      <p class="form-hint">Name gesetzlicher Regeln kann nicht geändert werden.</p>
    {/if}
  </div>
  <div class="form-group">
    <label class="form-label" for="sl-ed-reason">Beschreibung</label>
    <input id="sl-ed-reason" class="form-input" bind:value={slEditReason} />
  </div>
  <div class="form-group">
    <label class="form-label" for="sl-ed-days">Anzahl Tage</label>
    <input
      id="sl-ed-days"
      type="number"
      class="form-input"
      min="0.5"
      max="30"
      step="0.5"
      bind:value={slEditDays}
    />
  </div>
  <div class="toggle-row">
    <span class="toggle-row-label">Nachweis erforderlich</span>
    <label class="switch">
      <input type="checkbox" bind:checked={slEditProof} />
      <span class="switch-slider"></span>
    </label>
  </div>
  <div class="toggle-row">
    <span class="toggle-row-label">Aktiv</span>
    <label class="switch">
      <input type="checkbox" bind:checked={slEditActive} />
      <span class="switch-slider"></span>
    </label>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={() => (slShowEdit = false)}>Abbrechen</button>
    <button class="btn btn-primary" onclick={saveSLEdit} disabled={slSaving}>
      {slSaving ? "Speichern…" : "Speichern"}
    </button>
  {/snippet}
</Modal>

<style>
  .vac-skeleton {
    height: 80px;
    background: var(--sunk);
    border-radius: var(--r-control);
    animation: pulse 1.5s ease-in-out infinite;
  }
  .form-hint {
    font-size: 0.8125rem;
    color: var(--text-2);
    margin-top: 0.25rem;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
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
    background-color: var(--line-2);
    border-radius: 26px;
    transition: background-color 0.2s var(--ease-out);
  }
  .switch-slider::before {
    content: "";
    position: absolute;
    height: 20px;
    width: 20px;
    left: 3px;
    bottom: 3px;
    background-color: var(--card);
    border-radius: 50%;
    transition: transform 0.2s var(--ease-out);
    box-shadow: var(--shadow);
  }
  .switch input:checked + .switch-slider {
    background-color: var(--brand);
  }
  .switch input:checked + .switch-slider::before {
    transform: translateX(22px);
  }
  .sl-table-wrap {
    overflow-x: auto;
  }
  .sl-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .sl-table th {
    text-align: left;
    padding: 0.625rem 0.75rem;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    border-bottom: 2px solid var(--line);
  }
  .sl-table td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  .sl-row {
    cursor: pointer;
  }
  .sl-row:hover td {
    background: var(--sunk);
  }
  .sl-inactive td {
    opacity: 0.5;
  }
  .sl-text-sm {
    font-size: 0.8125rem;
  }
  .sl-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .sl-badge-statutory {
    background: var(--sunk);
    color: var(--text-2);
  }
  .sl-badge-custom {
    background: var(--brand-soft);
    color: var(--brand);
  }
  .sl-status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 0.25rem;
    background: var(--text-3);
  }
  .sl-status-dot.active {
    background: var(--ok);
  }
  .sl-status-dot.deactivated {
    background: var(--text-3);
  }
  .sl-actions-cell {
    text-align: right;
    white-space: nowrap;
  }
  .sl-skel {
    height: 200px;
    border-radius: var(--r-control);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
</style>
