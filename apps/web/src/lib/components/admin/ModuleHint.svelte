<!--
  ModuleHint — the calm hint shown INSTEAD of a create control when the tenant has not booked the
  add-on module the control needs (Phase 566, D-12).

  Display only: no button, no link, no dialog, not an alert. It appears only at the spot where the
  feature is set up, never in clock, calendar or dashboard views. The server re-checks every write.

  Props:
    module  — the add-on module that is not booked
    subject — plural noun phrase of what the module unlocks, e.g. "NFC-Terminals"
-->
<script lang="ts">
  import { TENANT_MODULE_LABELS, type TenantModule } from "$lib/packages/tenant-modules";

  interface Props {
    module: TenantModule;
    subject: string;
  }

  let { module, subject }: Props = $props();
</script>

<p class="form-hint" role="note" data-testid="module-hint" data-module={module}>
  {subject} sind mit dem Zusatzmodul {TENANT_MODULE_LABELS[module]} verfügbar. Ihr Anbieter schaltet es
  frei.
</p>
