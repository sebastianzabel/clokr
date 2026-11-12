<!--
  AssignmentDialog — grant or change one role assignment with its scope (Issue #83, AK-4):
  the whole tenant, selected salons, or selected people. Rejections show the server's German text
  inside the dialog (D-08). A role holding tenant-only rights gets an explanation for a salon or
  person scope (D-03) — a hint, never a block; the API stays the authority.
  Draft mode (Issue #580, D-580-03): with `onDraft` the dialog stores nothing — it hands the chosen
  role and scope back (the create dialog posts them once the person exists).
  Rebuilt on the Dialog and FormField blocks in Issue #854. The role is a native select inside FormField:
  the list is short and a native control stays usable without script; the scope stays a radio group
  with the checkbox lists below it.
-->
<script lang="ts">
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import { toasts } from "$stores/toast";
  import { ApiError } from "$api/client";
  import {
    createRoleAssignment,
    updateRoleAssignment,
    type AccessRole,
    type AssignablePerson,
    type AssignmentScope,
    type RoleAssignment,
  } from "$lib/api/roles";
  import {
    SCOPE_TENANT_LABEL,
    UNKNOWN_PERSON_LABEL,
    UNKNOWN_SALON_LABEL,
  } from "$lib/roles/assignment-label";

  interface Props {
    open: boolean;
    userId: string;
    personName: string;
    assignment: RoleAssignment | null;
    roles: AccessRole[];
    mandantRoleIds: string[];
    salons: { id: string; name: string }[];
    salonsLoaded: boolean;
    people: AssignablePerson[];
    onSaved: () => void;
    /** Draft mode: receives the choice instead of saving it. */
    onDraft?: (choice: { accessRoleId: string; scope: AssignmentScope }) => void;
    /** Draft mode: the draft being edited, or null for a new one. */
    draft?: { accessRoleId: string; scope: AssignmentScope } | null;
  }

  let {
    open = $bindable(),
    userId,
    personName,
    assignment,
    roles,
    mandantRoleIds,
    salons,
    salonsLoaded,
    people,
    onSaved,
    onDraft,
    draft = null,
  }: Props = $props();

  let draftMode = $derived(onDraft !== undefined);
  let prefill = $derived(draftMode ? draft : assignment);

  type ScopeType = AssignmentScope["type"];

  let roleId = $state("");
  let scopeType = $state<ScopeType>("TENANT");
  let salonIds = $state<string[]>([]);
  let employeeIds = $state<string[]>([]);
  let personFilter = $state("");
  let errorText = $state<string | null>(null);
  let saving = $state(false);

  // Reset the form each time the dialog opens, from the assignment being edited (if any).
  $effect(() => {
    if (!open) return;
    const source = prefill;
    roleId = source?.accessRoleId ?? "";
    scopeType = source?.scope.type ?? "TENANT";
    salonIds = source?.scope.type === "SALONS" ? [...source.scope.salonIds] : [];
    employeeIds = source?.scope.type === "PERSONS" ? [...source.scope.employeeIds] : [];
    personFilter = "";
    errorText = null;
  });

  // D-05: a stored salon id the caller's context no longer lists is a deactivated salon. Decided
  // only once the context has loaded, never from an empty list during start-up.
  let unknownSalonIds = $derived(
    salonsLoaded ? salonIds.filter((id) => !salons.some((s) => s.id === id)) : [],
  );
  let unknownEmployeeIds = $derived(
    employeeIds.filter((id) => !people.some((p) => p.employeeId === id)),
  );
  let filteredPeople = $derived.by(() => {
    const needle = personFilter.trim().toLocaleLowerCase("de");
    if (needle === "") return people;
    return people.filter((p) =>
      `${p.firstName} ${p.lastName}`.toLocaleLowerCase("de").includes(needle),
    );
  });
  let showMandantHint = $derived(scopeType !== "TENANT" && mandantRoleIds.includes(roleId));
  let scopeComplete = $derived(
    scopeType === "TENANT" ||
      (scopeType === "SALONS" && salonIds.length > 0) ||
      (scopeType === "PERSONS" && employeeIds.length > 0),
  );
  let canSave = $derived(roleId !== "" && scopeComplete && !saving && salonsLoaded);

  function toggle(list: string[], id: string, checked: boolean): string[] {
    const without = list.filter((x) => x !== id);
    return checked ? [...without, id] : without;
  }

  function scope(): AssignmentScope {
    if (scopeType === "SALONS") return { type: "SALONS", salonIds };
    if (scopeType === "PERSONS") return { type: "PERSONS", employeeIds };
    return { type: "TENANT" };
  }

  async function save() {
    if (!canSave) return;
    if (onDraft) {
      onDraft({ accessRoleId: roleId, scope: scope() });
      open = false;
      return;
    }
    saving = true;
    errorText = null;
    try {
      if (assignment) {
        await updateRoleAssignment(assignment.id, { accessRoleId: roleId, scope: scope() });
        toasts.success("Zuweisung gespeichert");
      } else {
        await createRoleAssignment({ userId, accessRoleId: roleId, scope: scope() });
        toasts.success("Rolle zugewiesen");
      }
      open = false;
      onSaved();
    } catch (err) {
      errorText =
        err instanceof ApiError
          ? err.message
          : "Die Anfrage ist fehlgeschlagen. Bitte versuch es noch einmal.";
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open eyebrow={personName} title={prefill ? "Zuweisung ändern" : "Rolle zuweisen"}>
  <form
    id="assignment-form"
    class="assignment-form"
    novalidate
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    {#if errorText}
      <div role="alert"><Note tone="bad">{errorText}</Note></div>
    {/if}

    <FormField label="Rolle">
      {#snippet field({ id, describedBy, invalid })}
        <select
          {id}
          class="form-input"
          bind:value={roleId}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        >
          <option value="">Rolle wählen</option>
          {#each roles as role (role.id)}
            <option value={role.id}
              >{role.isSystem ? `${role.name} (Systemrolle)` : role.name}</option
            >
          {/each}
        </select>
      {/snippet}
    </FormField>

    <fieldset class="assignment-scope">
      <legend class="assignment-legend">Geltungsbereich</legend>
      <label class="assignment-choice">
        <input type="radio" name="assignment-scope" value="TENANT" bind:group={scopeType} />
        <span>{SCOPE_TENANT_LABEL}</span>
      </label>
      <label class="assignment-choice">
        <input type="radio" name="assignment-scope" value="SALONS" bind:group={scopeType} />
        <span>Ausgewählte Salons</span>
      </label>
      <label class="assignment-choice">
        <input type="radio" name="assignment-scope" value="PERSONS" bind:group={scopeType} />
        <span>Ausgewählte Personen</span>
      </label>
    </fieldset>

    {#if scopeType === "SALONS"}
      <fieldset class="assignment-list">
        <legend class="assignment-legend">Salons</legend>
        {#if !salonsLoaded}
          <Skeleton shape="row" count={2} />
        {:else}
          {#each salons as salon (salon.id)}
            <label class="assignment-choice">
              <input
                type="checkbox"
                checked={salonIds.includes(salon.id)}
                onchange={(e) => (salonIds = toggle(salonIds, salon.id, e.currentTarget.checked))}
              />
              <span>{salon.name}</span>
            </label>
          {/each}
          {#each unknownSalonIds as id (id)}
            <label class="assignment-choice">
              <input
                type="checkbox"
                checked
                onchange={(e) => (salonIds = toggle(salonIds, id, e.currentTarget.checked))}
              />
              <span>{UNKNOWN_SALON_LABEL}</span>
            </label>
          {/each}
          {#if salons.length === 0 && unknownSalonIds.length === 0}
            <p class="assignment-empty">Keine aktiven Salons verfügbar.</p>
          {/if}
        {/if}
      </fieldset>
    {/if}

    {#if scopeType === "PERSONS"}
      <fieldset class="assignment-list">
        <legend class="assignment-legend">Personen</legend>
        <input
          class="form-input"
          type="search"
          placeholder="Person suchen"
          aria-label="Person suchen"
          bind:value={personFilter}
        />
        {#each filteredPeople as person (person.employeeId)}
          <label class="assignment-choice">
            <input
              type="checkbox"
              checked={employeeIds.includes(person.employeeId)}
              onchange={(e) =>
                (employeeIds = toggle(employeeIds, person.employeeId, e.currentTarget.checked))}
            />
            <span>{person.firstName} {person.lastName}</span>
          </label>
        {/each}
        {#each unknownEmployeeIds as id (id)}
          <label class="assignment-choice">
            <input
              type="checkbox"
              checked
              onchange={(e) => (employeeIds = toggle(employeeIds, id, e.currentTarget.checked))}
            />
            <span>{UNKNOWN_PERSON_LABEL}</span>
          </label>
        {/each}
      </fieldset>
    {/if}

    {#if showMandantHint}
      <Note tone="info">
        Diese Rolle enthält Rechte, die nur bei einer Zuweisung für das ganze Unternehmen wirken.
        Für Salons oder Personen gelten diese Rechte nicht.
      </Note>
    {/if}
  </form>

  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (open = false)}>Abbrechen</button
    >
    <button type="submit" form="assignment-form" class="btn btn-primary" disabled={!canSave}>
      {draftMode ? "Übernehmen" : "Speichern"}
    </button>
  {/snippet}
</Dialog>

<style>
  .assignment-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .assignment-scope,
  .assignment-list {
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    padding: var(--s-3) var(--s-4);
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .assignment-list {
    max-height: 260px;
    overflow-y: auto;
  }
  .assignment-legend {
    padding: 0 var(--s-1);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }
  .assignment-empty {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .assignment-choice {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-base);
    color: var(--text);
    min-height: 32px;
  }
  .assignment-choice input {
    accent-color: var(--brand);
  }
</style>
