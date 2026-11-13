<script lang="ts">
  import { showDetailCrumb } from "$lib/nav/detail-crumb";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";
  import { salonAdminRights, salonHolidayRights } from "$lib/page-rights";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import Note from "$components/ui/Note.svelte";
  import PageHeader from "$components/ui/PageHeader.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import OpeningHoursEditor from "$lib/components/admin/OpeningHoursEditor.svelte";
  import SalonHolidays from "$lib/components/admin/SalonHolidays.svelte";
  import SalonMasterDataForm from "$lib/components/admin/salons/SalonMasterDataForm.svelte";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import {
    DEFAULT_OPENING_HOURS,
    prefillOpeningHours,
    validateOpeningHours,
    type OpeningHoursDay,
  } from "$lib/salons/opening-hours";
  import { salonPatch, salonToForm, type SalonDto } from "$lib/salons/salon-form";

  /** The panels of an existing salon, in the order of the tab strip; the URL hash names one. */
  const TABS = [
    { value: "stammdaten", label: "Stammdaten" },
    { value: "oeffnungszeiten", label: "Öffnungszeiten" },
    { value: "feiertage", label: "Feiertage" },
  ] as const;
  const TAB_IDS = TABS.map((tab) => tab.value);

  const salonId = $derived($page.params.id);
  // Presentation only: the API refuses a write without salon:manage on its own.
  const rights = $derived(salonAdminRights($authStore.user));
  const holidayRights = $derived(salonHolidayRights($authStore.user));

  let salon = $state<SalonDto | null>(null);
  // Create mode: the route `/admin/salons/neu`, until the created salon has been adopted.
  const isCreate = $derived(salonId === "neu" && salon === null);
  // The salon's name closes the top bar's path (#854: pages carry no breadcrumb of their own).
  $effect(() => showDetailCrumb(salon ? salon.name : isCreate ? "Neuer Salon" : null));

  let loading = $state(true);
  let loadError = $state("");
  let forbidden = $state(false);

  let activeTab = $state<string>(TAB_IDS[0]);
  // The holiday calendar is read from the API on first mount, so it is mounted only once its tab
  // has been opened; the other panels stay mounted (their unsaved edits survive a tab switch).
  let holidaysOpened = $state(false);

  // The opening hours are this page's own section: the week being edited. The stored week is the
  // baseline (`salon`), the SaveBar counts a difference through the same comparison the PATCH uses.
  let hours = $state<OpeningHoursDay[]>(DEFAULT_OPENING_HOURS.map((day) => ({ ...day })));
  let savingHours = $state(false);
  // Unsaved changes the Stammdaten section reports (it owns its own snapshot).
  let masterChanges = $state(0);

  // ── Lifecycle (D-06: a salon is deactivated, never deleted) ───────────────────────────────
  let deactivateOpen = $state(false);
  let activateOpen = $state(false);
  // Active salons of the tenant, read once on load and after every lifecycle write. It only
  // decides whether the deactivate button is offered; the server's 409 stays the authority.
  let activeSalonCount: number | null = $state(null);
  const isLastActiveSalon = $derived(Boolean(salon?.isActive) && activeSalonCount === 1);

  /** The stored salon with the week being edited: the shape `salonPatch()` compares. */
  function formWithHours(stored: SalonDto) {
    return { ...salonToForm(stored), openingHours: hours };
  }

  // ── Unsaved-section tracking (Phase 109, D-11/D-12) ───────────────────────────────────────
  const hoursPatch = $derived(
    salon ? salonPatch(salon, formWithHours(salon), ["openingHours"]) : null,
  );
  const hoursChanges = $derived(hoursPatch ? 1 : 0);
  // An invalid week can only exist after an edit, so its messages show once the section has one.
  const hoursErrors = $derived(hoursChanges > 0 ? validateOpeningHours(hours) : {});
  const totalChanges = $derived(masterChanges + hoursChanges);

  // The registration is gated on "the baseline has been taken": a failed or not-found load must
  // not arm the navigation guard on a page that shows nothing but an error. ONE registration for
  // all sections - a second one under the same id would let one section's cleanup disarm the others.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-salon-detail", snapshotsReady && totalChanges > 0);
    return () => markUnsaved("admin-salon-detail", false);
  });

  /** Takes a server row as the stored salon; `hours` follows only when the week is taken over too. */
  function adopt(loaded: SalonDto, parts: { hours?: boolean }) {
    salon = loaded;
    if (parts.hours) hours = prefillOpeningHours(loaded.openingHours);
  }

  /** Reloads the header salon context after every successful salon write (Issue #82, D-10). */
  async function refreshSalonContext() {
    await salonContext.load($authStore.user?.id ?? null, { force: true }).catch(() => undefined);
  }

  async function loadActiveSalonCount() {
    try {
      const res = await api.get<{ salons: SalonDto[] }>("/salons?includeInactive=true");
      activeSalonCount = res.salons.filter((entry) => entry.isActive).length;
    } catch {
      // Unknown count: the button stays enabled and the server decides.
      activeSalonCount = null;
    }
  }

  function selectTab(next: string) {
    activeTab = next;
    if (next === "feiertage") holidaysOpened = true;
    writeTabHash(next);
  }

  onMount(async () => {
    activeTab = tabFromHash($page.url.hash, TAB_IDS);
    if (activeTab === "feiertage") holidaysOpened = true;
    if (salonId === "neu") {
      snapshotsReady = true;
      loading = false;
      return;
    }
    try {
      adopt(await api.get<SalonDto>(`/salons/${salonId}`), { hours: true });
      snapshotsReady = true;
      await loadActiveSalonCount();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else if (err instanceof ApiError && err.status === 404) {
        loadError = "Salon nicht gefunden.";
      } else {
        loadError = "Der Salon konnte nicht geladen werden.";
      }
    } finally {
      loading = false;
    }
  });

  async function afterCreate(created: SalonDto) {
    // The same component instance shows the new salon after the navigation, so the created row
    // becomes the baseline first and the unsaved registration is cleared before the move.
    adopt(created, { hours: true });
    masterChanges = 0;
    markUnsaved("admin-salon-detail", false);
    await goto(`/admin/salons/${created.id}`, { replaceState: true });
  }

  async function saveHours() {
    if (!salon) return;
    const messages = validateOpeningHours(hours);
    if (Object.values(messages).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Tage.");
      return;
    }
    const patch = salonPatch(salon, formWithHours(salon), ["openingHours"]);
    if (!patch) {
      toasts.info("Keine Änderungen.");
      return;
    }
    savingHours = true;
    try {
      const updated: SalonDto = await api.patch(`/salons/${salon.id}`, patch);
      adopt(updated, { hours: true });
      toasts.success("Öffnungszeiten gespeichert.");
      await refreshSalonContext();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      savingHours = false;
    }
  }

  function discardHours() {
    if (salon) hours = prefillOpeningHours(salon.openingHours);
  }

  /**
   * Re-reads the salon and the active count after a lifecycle write and reloads the header salon
   * context. The form sections keep their baselines, so unsaved edits survive a status change.
   */
  async function reloadAfterLifecycleWrite() {
    if (!salon) return;
    try {
      adopt(await api.get<SalonDto>(`/salons/${salon.id}`), {});
      await loadActiveSalonCount();
    } catch {
      toasts.error("Der Salon konnte nicht neu geladen werden.");
    }
    await refreshSalonContext();
  }

  // The two handlers run inside ConfirmDialog: a refusal toasts the server's own text and is
  // rethrown, so the dialog swallows it and stays open. Nothing here branches on that text.
  async function deactivateSalon() {
    if (!salon) return;
    try {
      await api.post(`/salons/${salon.id}/deactivate`, undefined);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Deaktivieren fehlgeschlagen.");
      throw err;
    }
    await reloadAfterLifecycleWrite();
    toasts.success("Salon deaktiviert.");
  }

  async function activateSalon() {
    if (!salon) return;
    try {
      await api.post(`/salons/${salon.id}/activate`, undefined);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Aktivieren fehlgeschlagen.");
      throw err;
    }
    await reloadAfterLifecycleWrite();
    toasts.success("Salon aktiviert.");
  }
</script>

{#if loading}
  <Skeleton shape="card" lines={3} />
{:else if isCreate && !rights.canManage}
  <div role="alert">
    <Note tone="info">Für das Anlegen von Salons fehlt dir die Berechtigung.</Note>
  </div>
{:else if forbidden}
  <div role="alert">
    <Note tone="info">Für die Salonübersicht fehlt dir die Berechtigung.</Note>
  </div>
{:else if !isCreate && (loadError || !salon)}
  <div role="alert"><Note tone="bad">{loadError || "Salon nicht gefunden."}</Note></div>
{:else if isCreate}
  <PageHead title="Neuer Salon" sub="Name, Adresse und Bundesland des neuen Salons" />
  <SalonMasterDataForm
    salon={null}
    canEdit={rights.canManage}
    bind:changes={masterChanges}
    onCreated={afterCreate}
  />
{:else if salon}
  {@const stored = salon}
  <!-- Issue #854 (owner review): the same head as Personen › Detail - title and sub line on the
         left, the three areas as the segment control on the right (PageHeader, tabsLook="segments"). -->
  <PageHeader
    title={salon.name}
    subtitle="Stammdaten, Öffnungszeiten und Feiertage dieses Salons"
    tabs={[...TABS]}
    tab={activeTab}
    onTabChange={selectTab}
    tabsLook="segments"
    tabsLabel="Bereiche des Salons"
  >
    {#snippet actions()}
      <Chip tone={stored.isActive ? "ok" : "neutral"}>{stored.isActive ? "Aktiv" : "Inaktiv"}</Chip>
    {/snippet}
    {#snippet panel(value)}
      {#if value === "stammdaten"}
        <div class="salon-panel">
          <SalonMasterDataForm
            salon={stored}
            canEdit={rights.canManage}
            bind:changes={masterChanges}
            onSaved={(next) => adopt(next, {})}
          />

          {#if rights.canManage && !isCreate && stored.isActive}
            <section class="settings-group" aria-labelledby="salon-deactivate-title">
              <h2 class="settings-group-title" id="salon-deactivate-title">Salon deaktivieren</h2>
              <p class="settings-group-desc">
                Ein deaktivierter Salon bekommt keine neuen Zeiteinträge, Schichten oder
                Zuordnungen. Verlauf und Auswertungen bleiben erhalten. Der Salon wird nie gelöscht
                und kann jederzeit wieder aktiviert werden.
              </p>
              <div>
                <button
                  type="button"
                  class="btn btn-secondary btn-danger"
                  onclick={() => (deactivateOpen = true)}
                  disabled={isLastActiveSalon}
                >
                  Salon deaktivieren
                </button>
                {#if isLastActiveSalon}
                  <p class="form-hint" id="salon-deactivate-hint">
                    Der letzte aktive Salon kann nicht deaktiviert werden.
                  </p>
                {/if}
              </div>
              <ConfirmDialog
                bind:open={deactivateOpen}
                title="Salon deaktivieren?"
                description={`„${stored.name}“ wird deaktiviert und bekommt keine neuen Zeiteinträge, Schichten oder Zuordnungen mehr. Verlauf und Auswertungen bleiben erhalten.`}
                confirmLabel="Deaktivieren"
                danger
                onConfirm={deactivateSalon}
              />
            </section>
          {/if}

          {#if rights.canManage && !isCreate && !stored.isActive}
            <section class="settings-group" aria-labelledby="salon-activate-title">
              <h2 class="settings-group-title" id="salon-activate-title">Salon aktivieren</h2>
              <p class="settings-group-desc">
                Der Salon steht danach wieder für Zeiteinträge, Schichten und Zuordnungen zur
                Verfügung. Es gilt die Salonanzahl des gebuchten Pakets.
              </p>
              <div>
                <button type="button" class="btn btn-primary" onclick={() => (activateOpen = true)}>
                  Salon aktivieren
                </button>
              </div>
              <ConfirmDialog
                bind:open={activateOpen}
                title="Salon wieder aktivieren?"
                description={`„${stored.name}“ wird wieder aktiv und ist für Zeiteinträge, Schichten und Zuordnungen auswählbar.`}
                confirmLabel="Aktivieren"
                onConfirm={activateSalon}
              />
            </section>
          {/if}
        </div>
      {:else if value === "oeffnungszeiten"}
        <OpeningHoursEditor
          bind:days={hours}
          errors={hoursErrors}
          idPrefix="salon-hours"
          disabled={!rights.canManage}
          changes={hoursChanges}
          saving={savingHours}
          onSave={saveHours}
          onDiscard={discardHours}
        />
      {:else if value === "feiertage" && holidaysOpened}
        <SalonHolidays salonId={stored.id} canManage={holidayRights.canManage} />
      {/if}
    {/snippet}
  </PageHeader>
{/if}

<style>
  .salon-panel {
    display: flex;
    flex-direction: column;
    gap: var(--s-8);
  }
</style>
