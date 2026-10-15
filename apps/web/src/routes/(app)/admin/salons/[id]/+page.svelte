<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";
  import { salonAdminRights } from "$lib/page-rights";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import OpeningHoursEditor from "$lib/components/admin/OpeningHoursEditor.svelte";
  import { FEDERAL_STATE_OPTIONS } from "$lib/salons/federal-states";
  import { validateOpeningHours } from "$lib/salons/opening-hours";
  import {
    createSalonBody,
    emptySalonForm,
    salonPatch,
    salonToForm,
    validateSalonForm,
    type SalonDto,
    type SalonFormErrors,
    type SalonPatchKey,
  } from "$lib/salons/salon-form";

  /** The master-data keys the „Stammdaten“ section may send; the hours section sends its own. */
  const MASTER_KEYS: readonly SalonPatchKey[] = [
    "name",
    "street",
    "postalCode",
    "city",
    "federalState",
  ];

  const salonId = $derived($page.params.id);
  // Presentation only: the API refuses a write without salon:manage on its own.
  const rights = $derived(salonAdminRights($authStore.user));

  let salon = $state<SalonDto | null>(null);
  // Create mode: the route `/admin/salons/neu`, until the created salon has been adopted.
  const isCreate = $derived(salonId === "neu" && salon === null);

  let loading = $state(true);
  let loadError = $state("");
  let forbidden = $state(false);

  let form = $state(emptySalonForm());
  let errors: SalonFormErrors = $state({});
  let hoursErrors: Record<number, string> = $state({});
  let savingMaster = $state(false);
  let savingHours = $state(false);
  let creating = $state(false);
  // Set after the server refused a Bundesland change (409 FEDERAL_STATE_IN_USE): the field stays
  // locked for the rest of this visit, the other master data remain editable.
  let federalStateLocked = $state(false);

  // ── Unsaved-section tracking (Phase 109, D-11/D-12) ───────────────────────────────────────
  function snap(...values: unknown[]): string {
    return JSON.stringify(values);
  }

  function masterSnapshotOf(values: typeof form): string {
    return snap(values.name, values.street, values.postalCode, values.city, values.federalState);
  }

  // In create mode the baseline is the empty form.
  let masterSnapshot = $state(masterSnapshotOf(emptySalonForm()));
  let hoursSnapshot = $state(snap(emptySalonForm().openingHours));
  let masterDirty = $derived(masterSnapshotOf(form) !== masterSnapshot);
  let hoursDirty = $derived(snap(form.openingHours) !== hoursSnapshot);

  // The registration is gated on "the baseline has been taken": a failed or not-found load must
  // not arm the navigation guard on a page that shows nothing but an error.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-salon-detail", snapshotsReady && (masterDirty || hoursDirty));
    return () => markUnsaved("admin-salon-detail", false);
  });

  /** Takes a server row as the new baseline of the chosen parts of the form. */
  function adopt(loaded: SalonDto, parts: { master?: boolean; hours?: boolean }) {
    salon = loaded;
    const fresh = salonToForm(loaded);
    if (parts.master) {
      form.name = fresh.name;
      form.street = fresh.street;
      form.postalCode = fresh.postalCode;
      form.city = fresh.city;
      form.federalState = fresh.federalState;
      errors = {};
      masterSnapshot = masterSnapshotOf(form);
    }
    if (parts.hours) {
      form.openingHours = fresh.openingHours;
      hoursErrors = {};
      hoursSnapshot = snap(form.openingHours);
    }
  }

  /** Reloads the header salon context after every successful salon write (Issue #82, D-10). */
  async function refreshSalonContext() {
    await salonContext.load($authStore.user?.id ?? null, { force: true }).catch(() => undefined);
  }

  onMount(async () => {
    if (salonId === "neu") {
      snapshotsReady = true;
      loading = false;
      return;
    }
    try {
      adopt(await api.get<SalonDto>(`/salons/${salonId}`), { master: true, hours: true });
      snapshotsReady = true;
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

  function hasMessages(messages: Record<string, string | undefined>): boolean {
    return Object.values(messages).some(Boolean);
  }

  async function createSalon() {
    errors = validateSalonForm(form, "create");
    hoursErrors = validateOpeningHours(form.openingHours);
    if (hasMessages(errors) || hasMessages(hoursErrors)) {
      toasts.error("Bitte prüfen Sie die markierten Felder.");
      return;
    }
    creating = true;
    try {
      const created: SalonDto = await api.post("/salons", createSalonBody(form));
      await refreshSalonContext();
      toasts.success("Salon angelegt.");
      // The same component instance shows the new salon after the navigation, so the created row
      // becomes the baseline first and the unsaved registration is cleared before the move.
      adopt(created, { master: true, hours: true });
      markUnsaved("admin-salon-detail", false);
      await goto(`/admin/salons/${created.id}`, { replaceState: true });
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Anlegen fehlgeschlagen.");
    } finally {
      creating = false;
    }
  }

  async function saveMasterData() {
    if (!salon) return;
    const all = validateSalonForm(form, "edit");
    errors = {
      name: all.name,
      street: all.street,
      postalCode: all.postalCode,
      city: all.city,
      federalState: all.federalState,
    };
    if (hasMessages(errors)) {
      toasts.error("Bitte prüfen Sie die markierten Felder.");
      return;
    }
    const patch = salonPatch(salon, form, MASTER_KEYS);
    if (!patch) {
      toasts.info("Keine Änderungen.");
      return;
    }
    savingMaster = true;
    try {
      const updated: SalonDto = await api.patch(`/salons/${salon.id}`, patch);
      adopt(updated, { master: true });
      toasts.success("Stammdaten gespeichert.");
      await refreshSalonContext();
    } catch (err) {
      // Decided by status and code only, never by the message text.
      const data =
        err instanceof ApiError ? (err.data as { code?: string } | undefined) : undefined;
      if (err instanceof ApiError && err.status === 409 && data?.code === "FEDERAL_STATE_IN_USE") {
        errors = { ...errors, federalState: err.message };
        form.federalState = salon.federalState;
        federalStateLocked = true;
      } else {
        toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
      }
    } finally {
      savingMaster = false;
    }
  }

  async function saveHours() {
    if (!salon) return;
    hoursErrors = validateOpeningHours(form.openingHours);
    if (hasMessages(hoursErrors)) {
      toasts.error("Bitte prüfen Sie die markierten Tage.");
      return;
    }
    const patch = salonPatch(salon, form, ["openingHours"]);
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
</script>

{#if loading}
  <div class="page-loading" role="status">Laden…</div>
{:else if isCreate && !rights.canManage}
  <div class="page-loading">Für das Anlegen von Salons fehlt Ihnen die Berechtigung.</div>
{:else if forbidden}
  <div class="page-loading">Für die Salonübersicht fehlt Ihnen die Berechtigung.</div>
{:else if !isCreate && (loadError || !salon)}
  <div class="page-error">{loadError || "Salon nicht gefunden."}</div>
{:else}
  <ListDetail
    eyebrow="Administration"
    title={salon ? salon.name : "Neuer Salon"}
    sub={isCreate
      ? "Stammdaten und Öffnungszeiten des neuen Salons"
      : "Stammdaten und Öffnungszeiten dieses Salons"}
    view="detail"
    crumbs={[
      { label: "Salons", href: "/admin/salons" },
      { label: salon ? salon.name : "Neuer Salon" },
    ]}
    animate
  >
    {#snippet tabContent(_tab)}
      {#snippet masterFooter()}
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onclick={saveMasterData}
          disabled={savingMaster}
        >
          {savingMaster ? "Speichern …" : "Stammdaten speichern"}
        </button>
      {/snippet}
      {#snippet hoursFooter()}
        {#if isCreate}
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onclick={createSalon}
            disabled={creating}
          >
            {creating ? "Anlegen …" : "Salon anlegen"}
          </button>
        {:else}
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onclick={saveHours}
            disabled={savingHours}
          >
            {savingHours ? "Speichern …" : "Öffnungszeiten speichern"}
          </button>
        {/if}
      {/snippet}

      <Section
        title="Stammdaten"
        sub="Name, Adresse und Bundesland. Das Bundesland bestimmt die gesetzlichen Feiertage des Salons."
        dirty={masterDirty}
        footer={rights.canManage && !isCreate ? masterFooter : undefined}
      >
        {#snippet actions()}
          {#if salon}
            <span
              class="badge"
              class:badge-green={salon.isActive}
              class:badge-gray={!salon.isActive}
            >
              {salon.isActive ? "Aktiv" : "Inaktiv"}
            </span>
          {/if}
        {/snippet}

        <div class="salon-fields">
          <div class="form-group">
            <label class="form-label" for="salon-name">Name *</label>
            <input
              id="salon-name"
              class="form-input"
              type="text"
              bind:value={form.name}
              disabled={!rights.canManage}
              aria-invalid={errors.name ? "true" : undefined}
              aria-describedby={errors.name ? "salon-name-error" : undefined}
            />
            {#if errors.name}
              <p class="form-error" id="salon-name-error">{errors.name}</p>
            {/if}
          </div>

          <div class="form-group">
            <label class="form-label" for="salon-street">Straße</label>
            <input
              id="salon-street"
              class="form-input"
              type="text"
              bind:value={form.street}
              disabled={!rights.canManage}
              aria-invalid={errors.street ? "true" : undefined}
              aria-describedby={errors.street ? "salon-street-error" : undefined}
            />
            {#if errors.street}
              <p class="form-error" id="salon-street-error">{errors.street}</p>
            {/if}
          </div>

          <div class="salon-row">
            <div class="form-group">
              <label class="form-label" for="salon-postal-code">PLZ</label>
              <input
                id="salon-postal-code"
                class="form-input"
                type="text"
                bind:value={form.postalCode}
                disabled={!rights.canManage}
                aria-invalid={errors.postalCode ? "true" : undefined}
                aria-describedby={errors.postalCode ? "salon-postal-code-error" : undefined}
              />
              {#if errors.postalCode}
                <p class="form-error" id="salon-postal-code-error">{errors.postalCode}</p>
              {/if}
            </div>
            <div class="form-group">
              <label class="form-label" for="salon-city">Ort</label>
              <input
                id="salon-city"
                class="form-input"
                type="text"
                bind:value={form.city}
                disabled={!rights.canManage}
                aria-invalid={errors.city ? "true" : undefined}
                aria-describedby={errors.city ? "salon-city-error" : undefined}
              />
              {#if errors.city}
                <p class="form-error" id="salon-city-error">{errors.city}</p>
              {/if}
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="salon-federal-state">Bundesland *</label>
            <select
              id="salon-federal-state"
              class="form-input"
              bind:value={form.federalState}
              disabled={!rights.canManage || federalStateLocked}
              aria-invalid={errors.federalState ? "true" : undefined}
              aria-describedby={errors.federalState
                ? "salon-federal-state-error"
                : "salon-federal-state-hint"}
            >
              {#if isCreate}
                <option value="">Bitte wählen</option>
              {/if}
              {#each FEDERAL_STATE_OPTIONS as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            {#if errors.federalState}
              <p class="form-error" id="salon-federal-state-error">{errors.federalState}</p>
            {:else}
              <p class="form-hint" id="salon-federal-state-hint">
                Das Bundesland lässt sich später nur ändern, solange keine Zeiteinträge oder
                Zuordnungen auf diesen Salon verweisen.
              </p>
            {/if}
          </div>
        </div>
      </Section>

      <Section
        title="Öffnungszeiten"
        sub="Wochentägliche Öffnungs- und Schließzeiten dieses Salons. Die Schichtplanung prüft Schichten gegen diese Zeiten."
        dirty={hoursDirty}
        footer={rights.canManage ? hoursFooter : undefined}
      >
        <OpeningHoursEditor
          bind:days={form.openingHours}
          errors={hoursErrors}
          idPrefix="salon-hours"
          disabled={!rights.canManage}
        />
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

  .salon-fields {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    max-width: 36rem;
  }

  .salon-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: var(--s-4);
  }

  @media (max-width: 480px) {
    .salon-row {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
