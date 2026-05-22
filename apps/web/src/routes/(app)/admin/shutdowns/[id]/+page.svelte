<script lang="ts">
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import DangerZone from "$lib/components/admin/DangerZone.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import Modal from "$components/ui/Modal.svelte";

  // ── Types ──────────────────────────────────────────────────────────────────
  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber: string;
  }

  interface ShutdownException {
    id: string;
    employeeId: string;
    reason: string | null;
    employee: Employee;
  }

  interface CompanyShutdown {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    deductsFromVacation: boolean;
    notes: string | null;
    exceptions: ShutdownException[];
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  let loading = $state(true);
  let loadError = $state("");

  // ── Data state ─────────────────────────────────────────────────────────────
  let shutdown = $state<CompanyShutdown | null>(null);
  let allEmployees = $state<Employee[]>([]);

  const shutdownId = $derived($page.params.id);

  onMount(async () => {
    loading = true;
    loadError = "";
    try {
      const [shutdownsRes, employeesRes] = await Promise.allSettled([
        api.get<CompanyShutdown[]>("/company-shutdowns"),
        api.get<{ employees?: Employee[] } | Employee[]>("/employees?limit=500"),
      ]);

      if (shutdownsRes.status === "rejected") {
        loadError = "Fehler beim Laden.";
        return;
      }
      const found = shutdownsRes.value.find((s) => s.id === shutdownId);
      if (!found) {
        loadError = "Betriebsurlaub nicht gefunden.";
        return;
      }
      shutdown = found;
      formName = found.name;
      formStart = found.startDate.slice(0, 10);
      formEnd = found.endDate.slice(0, 10);
      formDeducts = found.deductsFromVacation;
      formNotes = found.notes ?? "";

      if (employeesRes.status === "fulfilled") {
        const d = employeesRes.value;
        allEmployees = (Array.isArray(d) ? d : d.employees) ?? [];
      }
    } catch {
      loadError = "Fehler beim Laden.";
    } finally {
      loading = false;
    }
  });

  // ── State ──────────────────────────────────────────────────────────────────
  let saving = $state(false);
  let saveError = $state("");

  // Edit form fields
  let formName = $state("");
  let formStart = $state("");
  let formEnd = $state("");
  let formDeducts = $state(false);
  let formNotes = $state("");

  // Delete confirm
  let deleteConfirmOpen = $state(false);

  // Exception management
  let exceptionModalOpen = $state(false);
  let addExceptionEmpId = $state("");
  let addExceptionReason = $state("");
  let savingException = $state(false);

  // ── Reload ─────────────────────────────────────────────────────────────────
  async function reloadShutdown() {
    if (!shutdown) return;
    try {
      const all = await api.get<CompanyShutdown[]>("/company-shutdowns");
      const updated = all.find((s) => s.id === shutdown!.id);
      if (updated) shutdown = updated;
    } catch {
      // ignore reload errors
    }
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function saveShutdown() {
    if (!shutdown) return;
    if (!formName.trim() || !formStart || !formEnd) {
      saveError = "Name, Start- und Enddatum sind Pflichtfelder.";
      return;
    }
    if (formStart > formEnd) {
      saveError = "Startdatum muss vor Enddatum liegen.";
      return;
    }
    saving = true;
    saveError = "";
    try {
      const updated = await api.patch<CompanyShutdown>(`/company-shutdowns/${shutdown.id}`, {
        name: formName.trim(),
        startDate: formStart,
        endDate: formEnd,
        deductsFromVacation: formDeducts,
        notes: formNotes || undefined,
      });
      shutdown = updated;
      toasts.success("Betriebsurlaub gespeichert.");
    } catch {
      saveError = "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function confirmDelete() {
    if (!shutdown) return;
    try {
      await api.delete(`/company-shutdowns/${shutdown.id}`);
      toasts.success("Betriebsurlaub gelöscht.");
      goto("/admin/shutdowns");
    } catch {
      toasts.error("Löschen fehlgeschlagen.");
    }
  }

  // ── Exceptions ─────────────────────────────────────────────────────────────
  function openExceptions() {
    addExceptionEmpId = "";
    addExceptionReason = "";
    exceptionModalOpen = true;
  }

  async function addException() {
    if (!shutdown || !addExceptionEmpId) return;
    savingException = true;
    try {
      await api.post(`/company-shutdowns/${shutdown.id}/exceptions`, {
        employeeId: addExceptionEmpId,
        reason: addExceptionReason || undefined,
      });
      addExceptionEmpId = "";
      addExceptionReason = "";
      await reloadShutdown();
    } catch {
      toasts.error("Ausnahme konnte nicht hinzugefügt werden.");
    } finally {
      savingException = false;
    }
  }

  async function removeException(employeeId: string) {
    if (!shutdown) return;
    try {
      await api.delete(`/company-shutdowns/${shutdown.id}/exceptions/${employeeId}`);
      await reloadShutdown();
    } catch {
      toasts.error("Ausnahme konnte nicht entfernt werden.");
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtDate(d: string) {
    return format(new Date(d), "dd.MM.yyyy", { locale: de });
  }

  function calcDays(start: string, end: string) {
    const s = new Date(start);
    const e = new Date(end);
    return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  }

  const availableEmployees = $derived(
    shutdown
      ? allEmployees.filter((e) => !shutdown!.exceptions.some((ex) => ex.employeeId === e.id))
      : [],
  );
</script>

{#if loading}
  <div class="page-loading">Laden…</div>
{:else if loadError || !shutdown}
  <div class="page-error">{loadError || "Betriebsurlaub nicht gefunden."}</div>
{:else}
  <ListDetail
    eyebrow="Personal"
    title={shutdown.name}
    sub="Betriebsurlaub bearbeiten"
    view="detail"
    crumbs={[{ label: "Betriebsurlaub", href: "/admin/shutdowns" }, { label: shutdown.name }]}
    animate
  >
    {#snippet tabContent(_tab)}
      <!-- ── Zeitraum & Einstellungen ──────────────────────────────────────── -->
      <Section title="Betriebsurlaub" sub="Zeitraum und Einstellungen">
        {#if saveError}
          <div class="alert alert-error">{saveError}</div>
        {/if}
        <div class="form-group">
          <label class="form-label" for="sh-name">Bezeichnung *</label>
          <input
            id="sh-name"
            class="form-input"
            type="text"
            bind:value={formName}
            placeholder="z.B. Weihnachtsschließung 2025"
          />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="sh-start">Startdatum *</label>
            <input id="sh-start" class="form-input" type="date" bind:value={formStart} />
          </div>
          <div class="form-group">
            <label class="form-label" for="sh-end">Enddatum *</label>
            <input id="sh-end" class="form-input" type="date" bind:value={formEnd} />
          </div>
        </div>
        <div class="form-group">
          <div class="meta-row">
            <span class="badge badge-neutral">
              {calcDays(formStart || shutdown.startDate, formEnd || shutdown.endDate)} Tage
            </span>
            <span class="meta-dates">
              {fmtDate(formStart || shutdown.startDate)} – {fmtDate(formEnd || shutdown.endDate)}
            </span>
          </div>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={formDeducts} />
            Vom Urlaubskonto abziehen
          </label>
          <p class="form-hint">
            Wenn aktiv, wird der Betriebsurlaub automatisch vom Jahresurlaub der Mitarbeiter
            abgezogen (außer bei Ausnahmen).
          </p>
        </div>
        <div class="form-group">
          <label class="form-label" for="sh-notes">Notiz (optional)</label>
          <textarea
            id="sh-notes"
            class="form-input"
            rows="3"
            bind:value={formNotes}
            placeholder="Interne Anmerkung …"
          ></textarea>
        </div>
        {#snippet footer()}
          <button class="btn btn-primary btn-sm" onclick={saveShutdown} disabled={saving}>
            {saving ? "Speichern …" : "Speichern"}
          </button>
        {/snippet}
      </Section>

      <!-- ── Ausnahmen ────────────────────────────────────────────────────────── -->
      <Section title="Ausnahmen" sub="Mitarbeiter, die vom Betriebsurlaub ausgenommen sind">
        {#snippet actions()}
          <button class="btn btn-ghost btn-sm" onclick={openExceptions}
            >+ Ausnahme hinzufügen</button
          >
        {/snippet}

        {#if shutdown.exceptions.length === 0}
          <p class="text-muted">Noch keine Ausnahmen angelegt.</p>
        {:else}
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th>Nr.</th>
                  <th>Grund</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each shutdown.exceptions as ex (ex.id)}
                  <tr>
                    <td>{ex.employee.firstName} {ex.employee.lastName}</td>
                    <td class="text-muted">{ex.employee.employeeNumber}</td>
                    <td class="text-muted">{ex.reason ?? "–"}</td>
                    <td>
                      <button
                        class="btn btn-ghost btn-sm btn-danger"
                        onclick={() => removeException(ex.employeeId)}
                      >
                        Entfernen
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Section>

      <!-- ── Danger Zone ───────────────────────────────────────────────────────── -->
      <DangerZone description="Dieser Betriebsurlaub wird unwiderruflich gelöscht.">
        {#snippet actions()}
          <button
            class="btn btn-ghost btn-sm btn-danger"
            onclick={() => (deleteConfirmOpen = true)}
          >
            Betriebsurlaub löschen
          </button>
          <ConfirmDialog
            bind:open={deleteConfirmOpen}
            title="Betriebsurlaub löschen?"
            description={`„${shutdown.name}" wird entfernt. Diese Aktion kann nicht rückgängig gemacht werden.`}
            confirmLabel="Löschen"
            danger
            onConfirm={confirmDelete}
          />
        {/snippet}
      </DangerZone>
    {/snippet}
  </ListDetail>

  <!-- ── Modal: Ausnahme hinzufügen ─────────────────────────────────────────── -->
  <Modal bind:open={exceptionModalOpen} eyebrow="Ausnahme hinzufügen" title={shutdown.name}>
    <p class="form-hint">
      Mitarbeiter in dieser Liste sind vom Betriebsurlaub ausgenommen — ihr Urlaubskonto wird nicht
      belastet.
    </p>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="ex-emp">Mitarbeiter</label>
        <select id="ex-emp" class="form-input" bind:value={addExceptionEmpId}>
          <option value="">– Mitarbeiter wählen –</option>
          {#each availableEmployees as emp (emp.id)}
            <option value={emp.id}>{emp.firstName} {emp.lastName} ({emp.employeeNumber})</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="ex-reason">Grund (optional)</label>
        <input
          id="ex-reason"
          class="form-input"
          type="text"
          placeholder="z.B. Notdienstbereitschaft"
          bind:value={addExceptionReason}
        />
      </div>
    </div>
    {#snippet footer()}
      <button class="btn btn-ghost" onclick={() => (exceptionModalOpen = false)}>Abbrechen</button>
      <button
        class="btn btn-primary"
        onclick={addException}
        disabled={!addExceptionEmpId || savingException}
      >
        {savingException ? "Hinzufügen …" : "Hinzufügen"}
      </button>
    {/snippet}
  </Modal>
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

  /* ── Forms ── */
  .form-group {
    margin-bottom: var(--s-4);
  }

  .form-group:last-of-type {
    margin-bottom: 0;
  }

  .form-row {
    display: flex;
    gap: 1rem;
    margin-bottom: var(--s-4);
  }

  .form-row .form-group {
    flex: 1;
    margin-bottom: 0;
  }

  .form-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.25rem 0 0;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .meta-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.25rem;
  }

  .meta-dates {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  /* ── Badges ── */
  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .badge-neutral {
    background: var(--bg-subtle);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  /* ── Table ── */
  .table-responsive {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .data-table th {
    text-align: left;
    padding: 0.625rem 0.75rem;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    border-bottom: 2px solid var(--border);
  }

  .data-table td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  /* ── Danger button ── */
  :global(.btn-danger) {
    color: var(--bad) !important;
  }

  :global(.btn-danger:hover) {
    background: var(--bg-subtle) !important;
  }

  /* ── Alert ── */
  .alert {
    padding: 0.75rem 1rem;
    border-radius: var(--r-sm);
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }

  .alert-error {
    background: var(--bg-subtle);
    color: var(--bad);
    border: 1px solid var(--bad);
  }

  .text-muted {
    color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .form-row {
      flex-direction: column;
    }
  }
</style>
