<!--
  AssignmentDialog — grant or change one role assignment with its scope (Issue #83, AK-4):
  the whole tenant, selected salons, or selected people. Rejections show the server's German text
  inside the dialog (D-08). A role holding tenant-only rights gets an explanation for a salon or
  person scope (D-03) — a hint, never a block; the API stays the authority.
-->
<script lang="ts">
  import Modal from "$components/ui/Modal.svelte";
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
  }: Props = $props();

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
    roleId = assignment?.accessRoleId ?? "";
    scopeType = assignment?.scope.type ?? "TENANT";
    salonIds = assignment?.scope.type === "SALONS" ? [...assignment.scope.salonIds] : [];
    employeeIds = assignment?.scope.type === "PERSONS" ? [...assignment.scope.employeeIds] : [];
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
          : "Die Anfrage ist fehlgeschlagen. Bitte erneut versuchen.";
    } finally {
      saving = false;
    }
  }
</script>

<Modal bind:open eyebrow={personName} title={assignment ? "Zuweisung ändern" : "Rolle zuweisen"}>
  <div class="assignment-form">
    {#if errorText}
      <div class="callout error" role="alert">{errorText}</div>
    {/if}

    <div class="form-group">
      <label class="form-label" for="assignment-role">Rolle</label>
      <select id="assignment-role" class="form-input" bind:value={roleId}>
        <option value="">Rolle wählen</option>
        {#each roles as role (role.id)}
          <option value={role.id}>{role.isSystem ? `${role.name} (Systemrolle)` : role.name}</option
          >
        {/each}
      </select>
    </div>

    <fieldset class="assignment-scope">
      <legend class="form-label">Geltungsbereich</legend>
      <label class="assignment-choice">
        <input type="radio" name="assignment-scope" value="TENANT" bind:group={scopeType} />
        <span>Ganzer Mandant</span>
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
        <legend class="form-label">Salons</legend>
        {#if !salonsLoaded}
          <p class="form-hint">Salons werden geladen …</p>
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
              <span>Salon nicht mehr aktiv</span>
            </label>
          {/each}
          {#if salons.length === 0 && unknownSalonIds.length === 0}
            <p class="form-hint">Keine aktiven Salons verfügbar.</p>
          {/if}
        {/if}
      </fieldset>
    {/if}

    {#if scopeType === "PERSONS"}
      <fieldset class="assignment-list">
        <legend class="form-label">Personen</legend>
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
            <span>Person nicht mehr verfügbar</span>
          </label>
        {/each}
      </fieldset>
    {/if}

    {#if showMandantHint}
      <div class="callout brand" role="note">
        Diese Rolle enthält Rechte, die nur bei einer Zuweisung für den ganzen Mandanten wirken. Für
        Salons oder Personen gelten diese Rechte nicht.
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Abbrechen</button>
    <button type="button" class="btn btn-primary" disabled={!canSave} onclick={save}>
      Speichern
    </button>
  {/snippet}
</Modal>

<style>
  .assignment-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .assignment-scope,
  .assignment-list {
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 12px 16px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .assignment-list {
    max-height: 260px;
    overflow-y: auto;
  }
  .assignment-choice {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: var(--text);
    min-height: 32px;
  }
  .assignment-choice input {
    accent-color: var(--brand);
  }
</style>
