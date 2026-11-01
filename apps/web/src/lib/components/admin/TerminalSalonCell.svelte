<!--
  TerminalSalonCell — the salon cell of one terminal row on /admin/system (Issue #541, D-08, D-11).

  Presentation only: the API re-validates every binding (PATCH /terminals/:id). The cell shows
  - a select (instant save) while the key is active and either the tenant has salon options (the
    #64 rule, decided by the caller through showSalonOptions) or the key is bound at all — a binding
    to a deactivated salon must stay visible and removable even when only one salon is left;
  - plain text otherwise (revoked key, or an unbound key in a single-salon tenant);
  - the badge „Salon deaktiviert" whenever the bound salon is deactivated.

  A failed save is reported by the caller (`onchange` resolves false); the cell then writes the
  previous value back into the DOM select, so no stale choice stays on screen (WR-03).

  Props:
    terminal    — the key row (salon fields as served by GET /terminals)
    salons      — the ACTIVE salons the admin may choose from
    showOptions — whether the tenant offers salon options at all
    onchange    — saves the choice; resolves true on success, false on failure
-->
<script lang="ts">
  interface Props {
    terminal: {
      id: string;
      name: string;
      salonId: string | null;
      salonName: string | null;
      salonActive: boolean | null;
      revokedAt: string | null;
    };
    salons: { id: string; name: string }[];
    showOptions: boolean;
    onchange: (salonId: string | null) => Promise<boolean>;
  }

  let { terminal, salons, showOptions, onchange }: Props = $props();

  const NONE_LABEL = "Kein Salon – Salon aus dem Wochenmuster";

  let saving = $state(false);

  const bound = $derived(terminal.salonId !== null);
  const inactive = $derived(bound && terminal.salonActive === false);
  const controlVisible = $derived(terminal.revokedAt === null && (showOptions || bound));
  // The current binding is not among the choosable (active) salons: keep it as a disabled option.
  const currentMissing = $derived(bound && !salons.some((s) => s.id === terminal.salonId));
  const currentLabel = $derived(
    `${terminal.salonName ?? "Salon"}${inactive ? " (deaktiviert)" : ""}`,
  );

  async function handleChange(ev: Event & { currentTarget: HTMLSelectElement }) {
    const el = ev.currentTarget;
    const previous = terminal.salonId ?? "";
    const next = el.value === "" ? null : el.value;
    saving = true;
    let ok: boolean;
    try {
      ok = await onchange(next);
    } finally {
      saving = false;
    }
    if (!ok) el.value = previous;
  }
</script>

<div class="terminal-salon-cell" data-testid="terminal-salon-cell">
  {#if controlVisible}
    <select
      class="form-input"
      data-testid="terminal-salon-select"
      aria-label="Salon für {terminal.name}"
      value={terminal.salonId ?? ""}
      disabled={saving}
      onchange={handleChange}
    >
      <option value="">{NONE_LABEL}</option>
      {#each salons as salon (salon.id)}
        <option value={salon.id}>{salon.name}</option>
      {/each}
      {#if currentMissing && terminal.salonId !== null}
        <option value={terminal.salonId} disabled>{currentLabel}</option>
      {/if}
    </select>
  {:else}
    <span>{terminal.salonName ?? NONE_LABEL}</span>
  {/if}
  {#if inactive}
    <span class="badge badge-yellow" data-testid="terminal-salon-inactive">Salon deaktiviert</span>
  {/if}
</div>

<style>
  .terminal-salon-cell {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }
</style>
