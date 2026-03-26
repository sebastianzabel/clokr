<script lang="ts">
  import { self } from "svelte/legacy";

  import { onMount } from "svelte";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";

  type InvitationStatus = "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";
  type Role = "ADMIN" | "MANAGER" | "EMPLOYEE";

  interface Employee {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    hireDate: string;
    exitDate: string | null;
    nfcCardId: string | null;
    user: {
      email: string;
      role: Role;
      isActive: boolean;
      lastLoginAt: string | null;
    };
    invitationStatus: InvitationStatus;
  }

  let employees: Employee[] = $state([]);
  let loading = $state(true);
  let error = $state("");

  // Create modal
  let showCreateModal = $state(false);
  let creating = $state(false);
  let createError = $state("");
  let createEmailError = $state("");
  let cFirstName = $state("");
  let cLastName = $state("");
  let cEmail = $state("");
  let cEmployeeNumber = $state("");
  let cHireDate = $state(new Date().toISOString().split("T")[0]);
  let cRole: Role = $state("EMPLOYEE");
  let cScheduleType = $state<"FIXED_WEEKLY" | "MONTHLY_HOURS">("FIXED_WEEKLY");
  let cWeeklyHours = $state(40);
  let cMonthlyHours = $state<number | null>(null);
  let cUsePassword = $state(false);
  let cPassword = $state("");

  // Edit modal
  let showEditModal = $state(false);
  let editingEmployee: Employee | null = $state(null);
  let editSaving = $state(false);
  let editError = $state("");
  let eFirstName = $state("");
  let eLastName = $state("");
  let eEmployeeNumber = $state("");
  let eRole: Role = $state("EMPLOYEE");
  let eNfcCardId = $state("");

  // Delete confirm
  let showDeleteConfirm = $state(false);
  let deletingEmployee: Employee | null = $state(null);
  let deleting = $state(false);

  let isAdmin = $derived($authStore.user?.role === "ADMIN");

  // Filters
  let filterSearch = $state("");
  let filterRole = $state<Role | "">("");
  let filterStatus = $state<"active" | "pending" | "expired" | "inactive" | "">("");

  let filteredEmployees = $derived(
    employees.filter((emp) => {
      if (filterSearch) {
        const q = filterSearch.toLowerCase();
        const match =
          `${emp.firstName} ${emp.lastName} ${emp.user.email} ${emp.employeeNumber}`.toLowerCase();
        if (!match.includes(q)) return false;
      }
      if (filterRole && emp.user.role !== filterRole) return false;
      if (filterStatus) {
        if (filterStatus === "active" && !emp.user.isActive) return false;
        if (filterStatus === "pending" && (emp.user.isActive || emp.invitationStatus !== "PENDING"))
          return false;
        if (filterStatus === "expired" && (emp.user.isActive || emp.invitationStatus !== "EXPIRED"))
          return false;
        if (
          filterStatus === "inactive" &&
          (emp.user.isActive ||
            emp.invitationStatus === "PENDING" ||
            emp.invitationStatus === "EXPIRED")
        )
          return false;
      }
      return true;
    }),
  );

  onMount(loadEmployees);

  async function loadEmployees() {
    loading = true;
    error = "";
    try {
      employees = await api.get<Employee[]>("/employees");
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    cFirstName = "";
    cLastName = "";
    cEmail = "";
    cEmployeeNumber = "";
    cHireDate = new Date().toISOString().split("T")[0];
    cRole = "EMPLOYEE";
    cScheduleType = "FIXED_WEEKLY";
    cWeeklyHours = 40;
    cMonthlyHours = null;
    cUsePassword = false;
    cPassword = "";
    createError = "";
    createEmailError = "";
    showCreateModal = true;
  }

  async function createEmployee() {
    creating = true;
    createError = "";
    createEmailError = "";
    try {
      const payload: Record<string, unknown> = {
        email: cEmail,
        firstName: cFirstName,
        lastName: cLastName,
        employeeNumber: cEmployeeNumber,
        hireDate: new Date(cHireDate).toISOString(),
        role: cRole,
        scheduleType: cScheduleType,
        weeklyHours: cScheduleType === "FIXED_WEEKLY" ? cWeeklyHours : 0,
        monthlyHours: cScheduleType === "MONTHLY_HOURS" ? cMonthlyHours : null,
      };
      if (cUsePassword && cPassword) payload.password = cPassword;
      const res = await api.post<Employee & { emailError?: string }>("/employees", payload);
      employees = [...employees, res].sort((a, b) => a.lastName.localeCompare(b.lastName));
      showCreateModal = false;
      if (res.emailError) {
        alert(
          `Mitarbeiter angelegt, aber Einladungsmail konnte nicht gesendet werden: ${res.emailError}`,
        );
      }
    } catch (e: unknown) {
      createError = e instanceof Error ? e.message : "Fehler beim Anlegen";
    } finally {
      creating = false;
    }
  }

  function openEdit(emp: Employee) {
    editingEmployee = emp;
    eFirstName = emp.firstName;
    eLastName = emp.lastName;
    eEmployeeNumber = emp.employeeNumber;
    eRole = emp.user.role;
    eNfcCardId = emp.nfcCardId ?? "";
    editError = "";
    showEditModal = true;
  }

  async function saveEdit() {
    if (!editingEmployee) return;
    editSaving = true;
    editError = "";
    try {
      await api.patch(`/employees/${editingEmployee.id}`, {
        firstName: eFirstName,
        lastName: eLastName,
        employeeNumber: eEmployeeNumber,
        role: eRole,
        nfcCardId: eNfcCardId || null,
      });
      employees = employees.map((e) =>
        e.id === editingEmployee!.id
          ? {
              ...e,
              firstName: eFirstName,
              lastName: eLastName,
              employeeNumber: eEmployeeNumber,
              nfcCardId: eNfcCardId || null,
              user: { ...e.user, role: eRole },
            }
          : e,
      );
      showEditModal = false;
    } catch (e: unknown) {
      editError = e instanceof Error ? e.message : "Fehler beim Speichern";
    } finally {
      editSaving = false;
    }
  }

  async function resendInvitation(emp: Employee) {
    try {
      await api.post(`/employees/${emp.id}/resend-invitation`, {});
      alert("Einladung erneut gesendet.");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Fehler beim Senden");
    }
  }

  async function deactivate(emp: Employee) {
    if (!confirm(`${emp.firstName} ${emp.lastName} wirklich deaktivieren?`)) return;
    try {
      await api.patch(`/employees/${emp.id}/deactivate`, {});
      employees = employees.map((e) =>
        e.id === emp.id ? { ...e, user: { ...e.user, isActive: false } } : e,
      );
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Fehler beim Deaktivieren");
    }
  }

  async function reactivate(emp: Employee) {
    if (!confirm(`${emp.firstName} ${emp.lastName} wirklich reaktivieren?`)) return;
    try {
      await api.patch(`/employees/${emp.id}/reactivate`, {});
      await loadEmployees();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Fehler beim Reaktivieren");
    }
  }

  function confirmDelete(emp: Employee) {
    deletingEmployee = emp;
    showDeleteConfirm = true;
  }

  async function doDelete() {
    if (!deletingEmployee) return;
    deleting = true;
    try {
      await api.delete(`/employees/${deletingEmployee.id}`);
      employees = employees.filter((e) => e.id !== deletingEmployee!.id);
      showDeleteConfirm = false;
      deletingEmployee = null;
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Fehler beim Löschen");
    } finally {
      deleting = false;
    }
  }

  function roleLabel(role: Role): string {
    return role === "ADMIN" ? "Administrator" : role === "MANAGER" ? "Manager" : "Mitarbeiter";
  }

  function statusLabel(emp: Employee): string {
    if (emp.user.isActive) return "Aktiv";
    if (emp.invitationStatus === "PENDING") return "Einladung ausstehend";
    if (emp.invitationStatus === "EXPIRED") return "Einladung abgelaufen";
    return "Inaktiv";
  }

  function statusClass(emp: Employee): string {
    if (emp.user.isActive) return "badge-green";
    if (emp.invitationStatus === "PENDING") return "badge-orange";
    if (emp.invitationStatus === "EXPIRED") return "badge-red";
    return "badge-gray";
  }
</script>

<svelte:head>
  <title>Mitarbeiter – Clokr</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <p class="page-subtitle">{employees.length} Mitarbeiter</p>
    {#if isAdmin}
      <button class="btn btn-primary" onclick={openCreate}>+ Mitarbeiter anlegen</button>
    {/if}
  </div>

  {#if loading}
    <div class="loading">Laden…</div>
  {:else if error}
    <div class="alert alert-error">{error}</div>
  {:else if employees.length === 0}
    <div class="empty-state">
      <p>Noch keine Mitarbeiter angelegt.</p>
      {#if isAdmin}<button class="btn btn-primary" onclick={openCreate}>Jetzt anlegen</button>{/if}
    </div>
  {:else}
    <div class="filter-bar">
      <input
        type="search"
        class="form-input filter-search"
        placeholder="Suche nach Name, E-Mail, Nr.…"
        bind:value={filterSearch}
        aria-label="Mitarbeiter suchen"
      />
      <select
        class="form-input filter-select"
        bind:value={filterRole}
        aria-label="Nach Rolle filtern"
      >
        <option value="">Alle Rollen</option>
        <option value="ADMIN">Administrator</option>
        <option value="MANAGER">Manager</option>
        <option value="EMPLOYEE">Mitarbeiter</option>
      </select>
      <select
        class="form-input filter-select"
        bind:value={filterStatus}
        aria-label="Nach Status filtern"
      >
        <option value="">Alle Status</option>
        <option value="active">Aktiv</option>
        <option value="pending">Einladung ausstehend</option>
        <option value="expired">Einladung abgelaufen</option>
        <option value="inactive">Inaktiv</option>
      </select>
      <span class="filter-count">{filteredEmployees.length} von {employees.length}</span>
    </div>

    <div class="card">
      <table class="table">
        <thead>
          <tr>
            <th>Nr.</th>
            <th>Name</th>
            <th>E-Mail</th>
            <th>Rolle</th>
            <th>Status</th>
            <th>Letzter Login</th>
            {#if isAdmin}<th>Aktionen</th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each filteredEmployees as emp}
            <tr class:row-inactive={!emp.user.isActive}>
              <td class="col-number">{emp.employeeNumber}</td>
              <td class="col-name">
                <strong>{emp.lastName}, {emp.firstName}</strong>
              </td>
              <td class="col-email">{emp.user.email}</td>
              <td><span class="badge badge-purple">{roleLabel(emp.user.role)}</span></td>
              <td><span class="badge {statusClass(emp)}">{statusLabel(emp)}</span></td>
              <td class="col-login">
                {emp.user.lastLoginAt
                  ? new Date(emp.user.lastLoginAt).toLocaleDateString("de-DE", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })
                  : "—"}
              </td>
              {#if isAdmin}
                <td class="col-actions">
                  <div class="action-group">
                    {#if !emp.user.isActive && (emp.invitationStatus === "PENDING" || emp.invitationStatus === "EXPIRED")}
                      <button
                        class="btn btn-sm btn-ghost"
                        onclick={() => resendInvitation(emp)}
                        title="Einladung erneut senden"
                      >
                        Einladen
                      </button>
                    {/if}
                    <button class="btn btn-sm btn-ghost" onclick={() => openEdit(emp)}
                      >Bearbeiten</button
                    >
                    {#if emp.user.isActive}
                      <button class="btn btn-sm btn-ghost" onclick={() => deactivate(emp)}
                        >Deaktivieren</button
                      >
                    {:else}
                      <button class="btn btn-sm btn-ghost" onclick={() => reactivate(emp)}
                        >Reaktivieren</button
                      >
                    {/if}
                    <button class="btn btn-sm btn-danger-ghost" onclick={() => confirmDelete(emp)}
                      >Löschen</button
                    >
                  </div>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<!-- ── Anlegen Modal ──────────────────────────────────────────────────────── -->
{#if showCreateModal}
  <div class="modal-backdrop" onclick={self(() => (showCreateModal = false))} role="presentation">
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Mitarbeiter anlegen"
      tabindex="-1"
    >
      <div class="modal-header">
        <h2 class="modal-title">Mitarbeiter anlegen</h2>
        <button class="modal-close" onclick={() => (showCreateModal = false)} aria-label="Schließen"
          >✕</button
        >
      </div>
      <div class="modal-body">
        {#if createError}
          <div class="alert alert-error mb-3">{createError}</div>
        {/if}
        {#if createEmailError}
          <div class="alert alert-warning mb-3">
            Mitarbeiter angelegt, aber: {createEmailError}
            <button
              class="btn btn-sm btn-ghost"
              onclick={() => {
                showCreateModal = false;
                createEmailError = "";
              }}
            >
              Schließen
            </button>
          </div>
        {:else}
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label" for="c-firstname">Vorname</label>
              <input
                id="c-firstname"
                type="text"
                bind:value={cFirstName}
                class="form-input"
                required
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-lastname">Nachname</label>
              <input
                id="c-lastname"
                type="text"
                bind:value={cLastName}
                class="form-input"
                required
              />
            </div>
            <div class="form-group form-group--full">
              <label class="form-label" for="c-email">E-Mail-Adresse</label>
              <input id="c-email" type="email" bind:value={cEmail} class="form-input" required />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-empno">Mitarbeiter-Nr.</label>
              <input
                id="c-empno"
                type="text"
                bind:value={cEmployeeNumber}
                class="form-input"
                required
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-hiredate">Eintrittsdatum</label>
              <input
                id="c-hiredate"
                type="date"
                bind:value={cHireDate}
                class="form-input"
                required
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-role">Rolle</label>
              <select id="c-role" bind:value={cRole} class="form-input">
                <option value="EMPLOYEE">Mitarbeiter</option>
                <option value="MANAGER">Manager</option>
                <option value="ADMIN">Administrator</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="c-schedule-type">Arbeitszeitmodell</label>
              <select id="c-schedule-type" bind:value={cScheduleType} class="form-input">
                <option value="FIXED_WEEKLY">Feste Wochenstunden</option>
                <option value="MONTHLY_HOURS">Monatsstunden (Minijob)</option>
              </select>
            </div>
            {#if cScheduleType === "FIXED_WEEKLY"}
              <div class="form-group">
                <label class="form-label" for="c-hours">Wochenstunden</label>
                <input
                  id="c-hours"
                  type="number"
                  bind:value={cWeeklyHours}
                  class="form-input"
                  min="1"
                  max="60"
                  step="0.5"
                />
              </div>
            {:else}
              <div class="form-group">
                <label class="form-label" for="c-monthly-hours"
                  >Stunden/Monat <span class="text-muted">(optional)</span></label
                >
                <input
                  id="c-monthly-hours"
                  type="number"
                  bind:value={cMonthlyHours}
                  class="form-input"
                  min="0"
                  max="200"
                  step="0.5"
                  placeholder="z.B. 15 — leer = nur Tracking"
                />
              </div>
            {/if}
          </div>

          <div class="form-group form-group--full" style="margin-top: 1rem;">
            <label class="form-label toggle-label">
              <input type="checkbox" bind:checked={cUsePassword} />
              Passwort direkt setzen (statt Einladungsmail)
            </label>
          </div>

          {#if cUsePassword}
            <div class="form-group form-group--full">
              <label class="form-label" for="c-password">Passwort</label>
              <input
                id="c-password"
                type="password"
                bind:value={cPassword}
                class="form-input"
                minlength="8"
                placeholder="Mindestens 8 Zeichen"
                required
              />
            </div>
            <p class="hint">Mitarbeiter kann sich sofort anmelden. Kein Einladungslink nötig.</p>
          {:else}
            <p class="hint">Eine Einladungsmail wird automatisch gesendet.</p>
          {/if}
        {/if}
      </div>
      {#if !createEmailError}
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Abbrechen</button>
          <button class="btn btn-primary" onclick={createEmployee} disabled={creating}>
            {creating ? "Anlegen…" : "Mitarbeiter anlegen"}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- ── Bearbeiten Modal ───────────────────────────────────────────────────── -->
{#if showEditModal && editingEmployee}
  <div class="modal-backdrop" onclick={self(() => (showEditModal = false))} role="presentation">
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Mitarbeiter bearbeiten"
      tabindex="-1"
    >
      <div class="modal-header">
        <h2 class="modal-title">Mitarbeiter bearbeiten</h2>
        <button class="modal-close" onclick={() => (showEditModal = false)} aria-label="Schließen"
          >✕</button
        >
      </div>
      <div class="modal-body">
        {#if editError}
          <div class="alert alert-error mb-3">{editError}</div>
        {/if}
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label" for="e-firstname">Vorname</label>
            <input id="e-firstname" type="text" bind:value={eFirstName} class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label" for="e-lastname">Nachname</label>
            <input id="e-lastname" type="text" bind:value={eLastName} class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label" for="e-empno">Mitarbeiter-Nr.</label>
            <input id="e-empno" type="text" bind:value={eEmployeeNumber} class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label" for="e-role">Rolle</label>
            <select id="e-role" bind:value={eRole} class="form-input">
              <option value="EMPLOYEE">Mitarbeiter</option>
              <option value="MANAGER">Manager</option>
              <option value="ADMIN">Administrator</option>
            </select>
          </div>
          <div class="form-group form-group--full">
            <label class="form-label" for="e-nfc">NFC-Karten-ID</label>
            <input
              id="e-nfc"
              type="text"
              bind:value={eNfcCardId}
              class="form-input"
              placeholder="z.B. NFC-A1B2C3D4"
            />
            <p class="hint">Optional. Ermöglicht Stempeln per NFC-Karte.</p>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={() => (showEditModal = false)}>Abbrechen</button>
        <button class="btn btn-primary" onclick={saveEdit} disabled={editSaving}>
          {editSaving ? "Speichern…" : "Speichern"}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Löschen Bestätigung ───────────────────────────────────────────────── -->
{#if showDeleteConfirm && deletingEmployee}
  <div class="modal-backdrop" role="presentation">
    <div
      class="modal modal--sm"
      role="dialog"
      aria-modal="true"
      aria-label="Mitarbeiter löschen"
      tabindex="-1"
    >
      <div class="modal-header">
        <h2 class="modal-title">Mitarbeiter löschen</h2>
      </div>
      <div class="modal-body">
        <p>
          Möchten Sie <strong>{deletingEmployee.firstName} {deletingEmployee.lastName}</strong> wirklich
          unwiderruflich löschen?
        </p>
        <p class="hint danger-hint">
          Alle Daten (Zeiteinträge, Urlaubsanträge, Überstunden) werden dauerhaft entfernt. Diese
          Aktion kann nicht rückgängig gemacht werden.
        </p>
      </div>
      <div class="modal-footer">
        <button
          class="btn btn-ghost"
          onclick={() => {
            showDeleteConfirm = false;
            deletingEmployee = null;
          }}>Abbrechen</button
        >
        <button class="btn btn-danger" onclick={doDelete} disabled={deleting}>
          {deleting ? "Löschen…" : "Unwiderruflich löschen"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page {
    /* max-width inherited from .app-main (1600px) */
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
    gap: 1rem;
  }

  .page-subtitle {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .loading {
    padding: 3rem;
    text-align: center;
    color: var(--color-text-muted);
  }

  .empty-state {
    text-align: center;
    padding: 4rem 2rem;
    color: var(--color-text-muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .card {
    background: #fff;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  .table th {
    background: var(--color-bg-subtle);
    padding: 0.75rem 1rem;
    text-align: left;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
  }
  .table td {
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }
  .table tbody tr:last-child td {
    border-bottom: none;
  }
  .table tbody tr:hover {
    background: var(--color-bg-subtle);
  }

  .row-inactive {
    opacity: 0.6;
  }

  .col-number {
    color: var(--color-text-muted);
    width: 80px;
  }
  .col-email {
    color: var(--color-text-muted);
  }
  .col-login {
    color: var(--color-text-muted);
    font-size: 0.8125rem;
  }
  .col-actions {
    width: 220px;
  }

  .action-group {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  /* Badges */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge-green {
    background: #dcfce7;
    color: #166534;
  }
  .badge-orange {
    background: #fff7ed;
    color: #c2410c;
    border: 1px solid #fed7aa;
  }
  .badge-red {
    background: #fef2f2;
    color: #991b1b;
  }
  .badge-gray {
    background: #f3f4f6;
    color: #6b7280;
  }
  .badge-purple {
    background: #ede9fe;
    color: #5b21b6;
  }

  /* Buttons */
  .btn-danger {
    background: #dc2626;
    color: #fff;
    border: none;
  }
  .btn-danger:hover:not(:disabled) {
    background: #b91c1c;
  }
  .btn-danger-ghost {
    background: transparent;
    color: #dc2626;
    border: 1px solid #fecaca;
  }
  .btn-danger-ghost:hover:not(:disabled) {
    background: #fef2f2;
  }

  /* Modals */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: 50;
  }

  .modal {
    background: #fff;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    width: 100%;
    max-width: 560px;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal--sm {
    max-width: 420px;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .modal-title {
    font-size: 1.125rem;
    font-weight: 700;
    margin: 0;
  }
  .modal-close {
    background: none;
    border: none;
    font-size: 1.125rem;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0.25rem;
  }
  .modal-body {
    padding: 1.5rem;
  }
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--color-border);
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .form-group--full {
    grid-column: 1 / -1;
  }

  .hint {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin-top: 0.75rem;
  }

  .danger-hint {
    color: #991b1b;
  }

  .alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
  }

  .alert-error {
    background: #fef2f2;
    color: #991b1b;
    border: 1px solid #fecaca;
  }
  .alert-warning {
    background: #fffbeb;
    color: #92400e;
    border: 1px solid #fde68a;
    flex-direction: column;
    align-items: flex-start;
  }

  .mb-3 {
    margin-bottom: 0.75rem;
  }
</style>
