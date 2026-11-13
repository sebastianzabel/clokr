<!--
  ZugangTab - the „Zugang“ tab of the employee detail (Issue #854, plan 854-20): the former
  „Berechtigungen“ and „Gefahrenzone“ tabs in one place, in three groups.

    Rollen                                    the person's role assignments (role-assignment:manage)
    Anmeldung                                 account facts and the login actions (employee:manage-access)
    Beschäftigung beenden und Daten löschen   anonymise and hard delete (employee:anonymize)

  Every action keeps its endpoint and its server text on refusal: roles go through the shared
  PersonRoleAssignments block (Issue #580), resend / deactivate (last working day with a preview,
  Issue #615) / reactivate are the list's actions, anonymise (DSGVO Art. 17) and hard delete keep
  their ConfirmDialog flows. Presentation only: each group follows its permission, the API refuses
  anything else on its own.

  The role data and the account facts are this tab's own state: after a role change only the
  assignments and the account part are refreshed (never the other tabs' forms).

  Props:
    employee      the stored record (id, userId, names, user, invitationStatus)
    rights        the three permissions that open the groups
    canReadRoles  role:read (the role picker cannot be filled without it)
    salons        the caller's salon context (names for the scope text)
    salonsLoaded  whether `salons` has been loaded
    onRemoved     called after the person was anonymised or hard-deleted (the page leaves the detail)
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import DeactivateEmployeeDialog from "$lib/components/admin/DeactivateEmployeeDialog.svelte";
  import PersonRoleAssignments from "$lib/components/admin/roles/PersonRoleAssignments.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import {
    listAssignablePeople,
    listRoleAssignments,
    loadAssignmentChoices,
    type AccessRole,
    type AssignablePerson,
    type RoleAssignment,
  } from "$lib/api/roles";
  import { NO_ROLE_HINT, hasNoRole, type FormRole } from "$lib/employees/form-role";

  type InvitationStatus = "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";

  interface AccountUser {
    role: FormRole | null;
    email: string;
    isActive: boolean;
    lastLoginAt?: string | null;
  }

  interface Props {
    employee: {
      id: string;
      userId: string;
      firstName: string;
      lastName: string;
      user?: AccountUser | null;
      invitationStatus?: InvitationStatus;
    };
    rights: { canManageAccess: boolean; canAssignRoles: boolean; canAnonymize: boolean };
    canReadRoles: boolean;
    salons: { id: string; name: string }[];
    salonsLoaded: boolean;
    onRemoved: () => void;
  }

  let { employee, rights, canReadRoles, salons, salonsLoaded, onRemoved }: Props = $props();

  const uid = $props.id();
  const personName = $derived(`${employee.firstName} ${employee.lastName}`.trim() || "Person");

  // ── Account facts (refreshed after a role change, a deactivation or a reactivation) ────────
  let account = $state<AccountUser | null>(untrack(() => employee.user ?? null));
  let invitationStatus = $state<InvitationStatus | undefined>(
    untrack(() => employee.invitationStatus),
  );

  async function refreshAccount() {
    const fresh = await api.get<{ user?: AccountUser | null; invitationStatus?: InvitationStatus }>(
      `/employees/${employee.id}`,
    );
    account = fresh.user ?? null;
    invitationStatus = fresh.invitationStatus;
  }

  const statusChip = $derived.by((): { tone: "ok" | "warn" | "bad" | "neutral"; label: string } => {
    if (account?.isActive) return { tone: "ok", label: "Aktiv" };
    if (invitationStatus === "PENDING") return { tone: "warn", label: "Einladung ausstehend" };
    if (invitationStatus === "EXPIRED") return { tone: "bad", label: "Einladung abgelaufen" };
    return { tone: "neutral", label: "Inaktiv" };
  });

  const lastLogin = $derived(
    account?.lastLoginAt
      ? new Date(account.lastLoginAt).toLocaleDateString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null,
  );

  // ── Role assignments (Issue #580) ───────────────────────────────────────────────────────────
  // Every read needs role-assignment:manage, so nothing is requested without it (no 403s).
  let roleAssignments = $state<RoleAssignment[]>([]);
  let rolePeople = $state<AssignablePerson[]>([]);
  let roleChoices = $state<AccessRole[]>([]);
  let roleMandantIds = $state<string[]>([]);
  let roleDataState = $state<"idle" | "loading" | "ready" | "error">("idle");
  let roleDataError = $state("");

  async function loadRoleData(userId: string) {
    roleDataState = "loading";
    try {
      const [assignments, people, choices] = await Promise.all([
        listRoleAssignments(userId),
        listAssignablePeople(),
        loadAssignmentChoices(canReadRoles),
      ]);
      roleAssignments = assignments;
      rolePeople = people;
      roleChoices = choices.roles;
      roleMandantIds = choices.mandantRoleIds;
      roleDataState = "ready";
    } catch (err) {
      roleDataError =
        err instanceof Error ? err.message : "Die Rollen konnten nicht geladen werden.";
      roleDataState = "error";
    }
  }

  $effect(() => {
    const userId = employee.userId;
    if (!userId || !rights.canAssignRoles) return;
    untrack(() => {
      if (roleDataState === "idle") void loadRoleData(userId);
    });
  });

  // After a grant, change or revoke: reload the assignments and refresh only the account part, so
  // the no-role hint follows. Nothing else is re-read - it would discard unsaved edits elsewhere.
  async function onRoleAssignmentsChanged() {
    roleAssignments = await listRoleAssignments(employee.userId);
    await refreshAccount();
  }

  // ── Login actions (employee:manage-access) ───────────────────────────────────────────────────
  let resending = $state(false);
  let deactivateOpen = $state(false);
  let reactivateOpen = $state(false);

  const canResend = $derived(
    rights.canManageAccess &&
      account !== null &&
      !account.isActive &&
      (invitationStatus === "PENDING" || invitationStatus === "EXPIRED"),
  );

  async function resendInvitation() {
    resending = true;
    try {
      await api.post(`/employees/${employee.id}/resend-invitation`, {});
      toasts.success("Einladung erneut gesendet.");
    } catch (err) {
      toasts.error(
        err instanceof Error
          ? err.message
          : "Einladung konnte nicht gesendet werden. Versuche es noch einmal.",
      );
    } finally {
      resending = false;
    }
  }

  async function reactivate() {
    try {
      await api.patch(`/employees/${employee.id}/reactivate`, {});
    } catch (err) {
      toasts.error(
        err instanceof Error
          ? err.message
          : "Person konnte nicht reaktiviert werden. Versuche es noch einmal.",
      );
      throw err;
    }
    await refreshAccount();
    toasts.success("Zugang reaktiviert.");
  }

  async function onDeactivated() {
    await refreshAccount();
    toasts.success("Zugang deaktiviert.");
  }

  // ── Anonymise / hard delete (employee:anonymize) ────────────────────────────────────────────
  let anonymizeOpen = $state(false);
  let hardDeleteOpen = $state(false);
  let hardDeleteForce = $state(false);
  let hardDeleteRetentionExpiresAt = $state<string | null>(null);
  let hardDeleteError = $state("");

  // The two handlers run inside ConfirmDialog: a refusal toasts the server's own text and is
  // rethrown, so the dialog swallows it and stays open.
  async function anonymize() {
    try {
      await api.delete(`/employees/${employee.id}`);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Anonymisieren fehlgeschlagen.");
      throw err;
    }
    onRemoved();
  }

  async function hardDelete() {
    hardDeleteError = "";
    try {
      const body = hardDeleteForce ? { forceDelete: true } : undefined;
      await api.delete(`/employees/${employee.id}/hard-delete`, body);
    } catch (err: unknown) {
      if (err instanceof Error) {
        hardDeleteError = err.message;
        const data = (err as { data?: { retentionExpiresAt?: string } }).data;
        hardDeleteRetentionExpiresAt = data?.retentionExpiresAt ?? null;
      } else {
        hardDeleteError = "Fehler beim endgültigen Löschen";
      }
      throw err;
    }
    onRemoved();
  }

  const retentionDay = $derived(
    hardDeleteRetentionExpiresAt
      ? new Date(hardDeleteRetentionExpiresAt).toLocaleDateString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : null,
  );
</script>

<div class="zugang-tab detail-form">
  <section class="settings-group" aria-labelledby="{uid}-roles">
    <h2 class="settings-group-title" id="{uid}-roles">Rollen</h2>
    <p class="settings-group-desc">Welche Rollen diese Person in welchem Bereich hat.</p>
    {#if rights.canAssignRoles}
      {#if roleDataState === "error"}
        <div role="alert"><Note tone="bad">{roleDataError}</Note></div>
      {:else if roleDataState !== "ready"}
        <Skeleton shape="row" count={2} />
      {:else}
        <PersonRoleAssignments
          {personName}
          userId={employee.userId}
          items={roleAssignments}
          roles={roleChoices}
          mandantRoleIds={roleMandantIds}
          {salons}
          {salonsLoaded}
          people={rolePeople}
          canManage={rights.canAssignRoles}
          {canReadRoles}
          onChanged={onRoleAssignmentsChanged}
        />
      {/if}
    {:else}
      <Note tone="info">
        Welche Rollen diese Person hat, siehst du nur mit dem Recht, Rollen zuzuweisen.
      </Note>
    {/if}
    {#if hasNoRole(account)}
      <Note tone="warn">{NO_ROLE_HINT}</Note>
    {/if}
  </section>

  <section class="settings-group" aria-labelledby="{uid}-login">
    <h2 class="settings-group-title" id="{uid}-login">Anmeldung</h2>
    <p class="settings-group-desc">
      Benutzerkonto der Person. Die Anmeldung ist unabhängig vom Austrittsdatum und wird hier
      gesondert gesperrt.
    </p>
    {#if account}
      <dl class="zugang-facts">
        <div>
          <dt>E-Mail</dt>
          <dd>{account.email}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd><Chip tone={statusChip.tone}>{statusChip.label}</Chip></dd>
        </div>
        {#if lastLogin}
          <div>
            <dt>Letzter Login</dt>
            <dd>{lastLogin}</dd>
          </div>
        {/if}
      </dl>
      {#if rights.canManageAccess}
        <div class="zugang-actions">
          {#if canResend}
            <button
              type="button"
              class="btn btn-secondary"
              data-testid="zugang-resend-invitation"
              disabled={resending}
              onclick={resendInvitation}
            >
              Einladung erneut senden
            </button>
          {/if}
          {#if account.isActive}
            <button
              type="button"
              class="btn btn-secondary"
              data-testid="zugang-deactivate"
              onclick={() => (deactivateOpen = true)}
            >
              Zugang deaktivieren
            </button>
          {:else}
            <button
              type="button"
              class="btn btn-secondary"
              data-testid="zugang-reactivate"
              onclick={() => (reactivateOpen = true)}
            >
              Zugang reaktivieren
            </button>
          {/if}
        </div>
      {/if}
    {:else}
      <Note tone="info">Zu dieser Person gehört kein Benutzerkonto.</Note>
    {/if}
  </section>

  {#if rights.canAnonymize}
    <section class="settings-group zugang-danger" aria-labelledby="{uid}-danger">
      <h2 class="settings-group-title" id="{uid}-danger">
        Beschäftigung beenden und Daten löschen
      </h2>
      <p class="settings-group-desc">
        Diese Schritte lassen sich nicht rückgängig machen. Zuerst anonymisierst du die Person,
        endgültig löschen kannst du den Datensatz erst nach Ablauf der Aufbewahrungsfrist.
      </p>

      <div class="zugang-block">
        <h3 class="zugang-block-title">Anonymisieren (DSGVO Art. 17)</h3>
        <p class="zugang-block-text">
          Persönliche Daten werden anonymisiert (Name → „Gelöscht / GELÖSCHT-Personalnummer“, E-Mail
          anonymisiert). Die Personalnummer bleibt für die Lohnunterlagen erhalten (§ 41 EStG, § 147
          AO). Ist kein Austrittsdatum eingetragen, wird das heutige Datum als Austrittsdatum
          gesetzt; Abwesenheiten nach dem Austritt werden storniert. Zeiterfassungen, Urlaubsanträge
          und Salden bleiben aus rechtlichen Gründen für die Aufbewahrungsfrist (10 Jahre nach § 147
          AO) erhalten.
        </p>
        <div>
          <button
            type="button"
            class="btn btn-secondary btn-danger"
            data-testid="zugang-anonymize"
            onclick={() => (anonymizeOpen = true)}
          >
            Anonymisieren
          </button>
        </div>
      </div>

      <div class="zugang-block">
        <h3 class="zugang-block-title">Endgültig löschen</h3>
        <p class="zugang-block-text">
          Datensatz permanent entfernen. Nur möglich nach Anonymisierung und Ablauf der gesetzlichen
          Aufbewahrungsfrist (§ 147 AO, 10 Jahre).
        </p>
        {#if hardDeleteError}
          <div role="alert"><Note tone="bad">{hardDeleteError}</Note></div>
        {/if}
        {#if retentionDay}
          <Note tone="warn">
            Aufbewahrungsfrist noch nicht abgelaufen. Die gesetzliche Aufbewahrungsfrist (§ 147 AO,
            10 Jahre) läuft ab am {retentionDay}.
          </Note>
          <ToggleField
            bind:checked={hardDeleteForce}
            label="Ich kenne die Aufbewahrungsfrist und will den Datensatz trotzdem unwiderruflich löschen (z. B. Testdaten)."
            help="Diese Aktion wird im Audit-Log protokolliert."
          />
        {/if}
        <div>
          <button
            type="button"
            class="btn btn-secondary btn-danger"
            data-testid="zugang-hard-delete"
            onclick={() => (hardDeleteOpen = true)}
            disabled={hardDeleteRetentionExpiresAt !== null && !hardDeleteForce}
          >
            Endgültig löschen
          </button>
        </div>
      </div>
    </section>
  {/if}
</div>

{#if rights.canManageAccess && account}
  <DeactivateEmployeeDialog bind:open={deactivateOpen} {employee} {onDeactivated} />

  <ConfirmDialog
    bind:open={reactivateOpen}
    title="Zugang reaktivieren?"
    description={`${personName} kann sich danach wieder anmelden.`}
    confirmLabel="Reaktivieren"
    onConfirm={reactivate}
  />
{/if}

{#if rights.canAnonymize}
  <ConfirmDialog
    bind:open={anonymizeOpen}
    title="Mitarbeiter anonymisieren?"
    description="Möchtest du diese Person wirklich anonymisieren? Persönliche Daten (Name, E-Mail, Notizen) werden gemäß DSGVO gelöscht; die Personalnummer bleibt erhalten. Ein leeres Austrittsdatum wird auf heute gesetzt, Abwesenheiten nach dem Austritt werden storniert. Zeiteinträge, Urlaubsanträge und Salden bleiben erhalten."
    confirmLabel="Anonymisieren"
    danger
    onConfirm={anonymize}
  />

  <ConfirmDialog
    bind:open={hardDeleteOpen}
    title="Datensatz endgültig löschen?"
    description="Den anonymisierten Datensatz endgültig und unwiderruflich löschen? Diese Aktion entfernt alle verbleibenden Daten dauerhaft (DSGVO Art. 17)."
    confirmLabel="Endgültig löschen"
    danger
    onConfirm={hardDelete}
  />
{/if}

<style>
  .zugang-facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--s-4);
    margin: 0;
  }

  .zugang-facts dt {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .zugang-facts dd {
    margin: var(--s-1) 0 0;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text);
  }

  .zugang-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .zugang-block {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    max-width: 44rem;
  }

  .zugang-block + .zugang-block {
    padding-top: var(--s-4);
    border-top: 1px solid var(--line);
  }

  .zugang-block-title {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }

  .zugang-block-text {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text-2);
  }
</style>
