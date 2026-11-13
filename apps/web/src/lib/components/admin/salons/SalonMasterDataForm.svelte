<!--
  SalonMasterDataForm - the „Stammdaten“ section of a salon (Issue #854, tracer of the Verwalten
  pages): name, address and Bundesland as FormFields in a `.settings-group` with its own SaveBar.

  With `salon` it edits a stored salon: the save sends `PATCH /salons/:id` with exactly the master
  keys (`pickSection`, never a spread of the whole record, #878). With `salon === null` it is the
  create form of a new salon: the save sends `POST /salons` with an explicit Bundesland (the opening
  hours start at the default week and are maintained on the salon afterwards).

  The component keeps its own snapshot (what the server last answered) and values (what the form
  shows). A lifecycle change of the salon (deactivate, activate) does not touch them, so unsaved
  edits survive it. The server stays the authority for every rule; the client validation here is
  `validateSalonForm()` and only saves a round trip.

  Props:
    salon     - the stored salon, or null for the create form
    canEdit   - presentation only: without salon:manage the fields are read-only
    changes   - bindable, the number of unsaved changes (the page sums it into markUnsaved)
    onSaved   - called with the server's answer after a successful PATCH
    onCreated - called with the created salon after a successful POST
-->
<script lang="ts" module>
  import type { SalonPatchKey } from "$lib/salons/salon-form";

  /** The keys of `PATCH /salons/:id` this section owns; the hours section sends its own. */
  export const SALON_MASTER_KEYS = [
    "name",
    "street",
    "postalCode",
    "city",
    "federalState",
  ] as const satisfies readonly SalonPatchKey[];
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import SaveBar from "$components/ui/SaveBar.svelte";
  import { countChanges, pickSection, sectionErrors } from "$lib/settings/section-state";
  import { FEDERAL_STATE_OPTIONS, type FederalStateCode } from "$lib/salons/federal-states";
  import {
    createSalonBody,
    emptySalonForm,
    nullIfBlank,
    validateSalonForm,
    type SalonDto,
    type SalonFormErrors,
  } from "$lib/salons/salon-form";

  interface Props {
    salon: SalonDto | null;
    canEdit: boolean;
    changes?: number;
    onSaved?: (next: SalonDto) => void;
    onCreated?: (created: SalonDto) => void;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { salon, canEdit, changes = $bindable(), onSaved, onCreated }: Props = $props();

  /** What the section shows and what it compares against: strings only, "" = nothing entered. */
  type MasterValues = {
    name: string;
    street: string;
    postalCode: string;
    city: string;
    federalState: FederalStateCode | "";
  };

  function valuesOf(stored: SalonDto | null): MasterValues {
    return {
      name: stored?.name ?? "",
      street: stored?.street ?? "",
      postalCode: stored?.postalCode ?? "",
      city: stored?.city ?? "",
      federalState: stored?.federalState ?? "",
    };
  }

  // The baseline is read once on purpose: afterwards the section owns its snapshot, and a reload of
  // the `salon` prop after a status change must not discard what the person typed.
  let snapshot = $state<MasterValues>(untrack(() => valuesOf(salon)));
  let values = $state<MasterValues>(untrack(() => valuesOf(salon)));

  const isCreate = $derived(salon === null);

  // Set after the server refused a Bundesland change (409 FEDERAL_STATE_IN_USE): the field stays
  // locked for the rest of this visit, the other master data remain editable.
  let federalStateLocked = $state(false);
  let federalStateRefusal = $state("");
  let saving = $state(false);

  const changeCount = $derived(countChanges(snapshot, values, SALON_MASTER_KEYS));
  $effect(() => {
    changes = changeCount;
  });

  /** Client-side messages for the master keys only (the hours are validated by their own section). */
  const liveErrors = $derived.by((): SalonFormErrors => {
    const all = validateSalonForm({ ...emptySalonForm(), ...values }, isCreate ? "create" : "edit");
    return {
      name: all.name,
      street: all.street,
      postalCode: all.postalCode,
      city: all.city,
      federalState: all.federalState,
    };
  });

  // An invalid value can only exist after an edit (a stored salon is valid, a new one starts empty),
  // so the messages show as soon as the section has a change - the bar then explains its error count.
  const shown = $derived(changeCount > 0 ? liveErrors : {});
  const federalStateError = $derived(federalStateRefusal || shown.federalState || undefined);

  /** Reloads the header salon context after every successful salon write (Issue #82, D-10). */
  async function refreshSalonContext() {
    await salonContext.load($authStore.user?.id ?? null, { force: true }).catch(() => undefined);
  }

  function hasMessages(messages: Record<string, string | undefined>): boolean {
    return Object.values(messages).some(Boolean);
  }

  /** The values as the API wants them: trimmed name, a blank address part is null. */
  function normalised(current: MasterValues) {
    return {
      name: current.name.trim(),
      street: nullIfBlank(current.street),
      postalCode: nullIfBlank(current.postalCode),
      city: nullIfBlank(current.city),
      federalState: current.federalState,
    };
  }

  async function saveMasterData() {
    if (!salon) return;
    if (hasMessages(liveErrors)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    saving = true;
    try {
      const updated: SalonDto = await api.patch(
        `/salons/${salon.id}`,
        pickSection(normalised(values), SALON_MASTER_KEYS),
      );
      snapshot = valuesOf(updated);
      values = valuesOf(updated);
      federalStateRefusal = "";
      toasts.success("Stammdaten gespeichert.");
      await refreshSalonContext();
      onSaved?.(updated);
    } catch (err) {
      // Decided by status and code only, never by the message text.
      const data =
        err instanceof ApiError ? (err.data as { code?: string } | undefined) : undefined;
      if (err instanceof ApiError && err.status === 409 && data?.code === "FEDERAL_STATE_IN_USE") {
        federalStateRefusal = err.message;
        values.federalState = snapshot.federalState;
        federalStateLocked = true;
      } else {
        toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
      }
    } finally {
      saving = false;
    }
  }

  async function createSalon() {
    const form = { ...emptySalonForm(), ...values };
    if (hasMessages(validateSalonForm(form, "create"))) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    saving = true;
    try {
      const created: SalonDto = await api.post("/salons", createSalonBody(form));
      await refreshSalonContext();
      toasts.success("Salon angelegt.");
      // The created row becomes the baseline first, so the page can clear its unsaved registration
      // before it moves on to the new salon.
      snapshot = valuesOf(created);
      values = valuesOf(created);
      onCreated?.(created);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Anlegen fehlgeschlagen.");
    } finally {
      saving = false;
    }
  }

  function discard() {
    values = { ...snapshot };
    federalStateRefusal = "";
  }
</script>

<section class="settings-group" aria-labelledby="salon-master-title">
  <h2 class="settings-group-title" id="salon-master-title">Stammdaten</h2>
  <p class="settings-group-desc">
    Name, Adresse und Bundesland. Das Bundesland bestimmt die gesetzlichen Feiertage des Salons.
  </p>

  <div class="salon-fields">
    <FormField label="Name" required error={shown.name}>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          bind:value={values.name}
          disabled={!canEdit}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>

    <FormField label="Straße" error={shown.street}>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          bind:value={values.street}
          disabled={!canEdit}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>

    <div class="salon-row">
      <FormField label="PLZ" error={shown.postalCode}>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="text"
            bind:value={values.postalCode}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
      <FormField label="Ort" error={shown.city}>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="text"
            bind:value={values.city}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>

    <FormField
      label="Bundesland"
      required
      error={federalStateError}
      help="Das Bundesland lässt sich später nur ändern, solange keine Zeiteinträge oder Zuordnungen auf diesen Salon verweisen."
    >
      {#snippet field({ id, describedBy, invalid })}
        <select
          {id}
          class="form-input"
          bind:value={values.federalState}
          disabled={!canEdit || federalStateLocked}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        >
          {#if isCreate}
            <option value="">Bitte wählen</option>
          {/if}
          {#each FEDERAL_STATE_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      {/snippet}
    </FormField>
  </div>

  {#if canEdit}
    <SaveBar
      changes={changeCount}
      errors={sectionErrors(liveErrors)}
      {saving}
      saveLabel={isCreate ? "Salon anlegen" : "Salon speichern"}
      onSave={isCreate ? createSalon : saveMasterData}
      onDiscard={discard}
    />
  {/if}
</section>

<style>
  .salon-fields {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    max-width: 36rem;
  }

  /* PLZ and Ort sit side by side while there is room and stack otherwise, without a viewport query. */
  .salon-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--s-4);
  }
</style>
