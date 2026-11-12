<!--
  BulkRoleDialog - the choice of ONE role and scope for several selected persons (Issue #854,
  D-854-09). It stores nothing: it is the AssignmentDialog in its draft mode, so the role list, the
  scope choice (Ganzes Unternehmen / Ausgewählte Salons / Ausgewählte Personen), the wording and the
  hint for company-wide rights are exactly those of a single assignment. The page then previews the
  persons and posts one assignment per person through the existing endpoint.
-->
<script lang="ts">
  import AssignmentDialog from "$lib/components/admin/roles/AssignmentDialog.svelte";
  import type { AccessRole, AssignablePerson, AssignmentScope } from "$lib/api/roles";

  interface Props {
    open: boolean;
    /** How many persons the choice will be applied to (shown as the dialog's eyebrow). */
    personCount: number;
    roles: AccessRole[];
    mandantRoleIds: string[];
    salons: { id: string; name: string }[];
    salonsLoaded: boolean;
    people: AssignablePerson[];
    /** Receives the chosen role and scope; nothing is saved here. */
    onChoose: (choice: { accessRoleId: string; scope: AssignmentScope }) => void;
  }

  let {
    open = $bindable(),
    personCount,
    roles,
    mandantRoleIds,
    salons,
    salonsLoaded,
    people,
    onChoose,
  }: Props = $props();

  const eyebrow = $derived(
    personCount === 1 ? "1 ausgewählte Person" : `${personCount} ausgewählte Personen`,
  );
</script>

<AssignmentDialog
  bind:open
  userId=""
  personName={eyebrow}
  assignment={null}
  {roles}
  {mandantRoleIds}
  {salons}
  {salonsLoaded}
  {people}
  onSaved={() => {}}
  onDraft={onChoose}
  draft={null}
/>
