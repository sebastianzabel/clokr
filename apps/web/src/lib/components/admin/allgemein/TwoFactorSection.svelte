<!--
  TwoFactorSection - „Zwei-Faktor-Authentifizierung“ of System › Allgemein (Issue #854, D-854-03): the switch
  that makes every sign-in ask for a code sent by e-mail. It is ONE atomic value, so it saves the moment it is
  flipped (docs/ADMIN_STRUCTURE.md §3.2.1, D-03) and has no SaveBar: registry section `allgemein-zwei-faktor`,
  key `twoFaEnabled`, `PUT /settings/security`. The switch is bound to the state, so it can never claim a
  value the server rejected (WR-02): a failed save puts the previous value back and says so in the section.
  The API audits the change (#285).

  Props:
    config  - the loaded `GET /settings/security` answer
    canEdit - presentation only; the server's 403 stays the authority
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Note from "$components/ui/Note.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import type { SecurityConfig } from "$lib/settings/allgemein";

  interface Props {
    config: SecurityConfig;
    canEdit?: boolean;
  }

  let { config, canEdit = true }: Props = $props();

  let twoFaEnabled = $state(untrack(() => config.twoFaEnabled ?? false));
  let twoFaSaving = $state(false);
  let twoFaError = $state("");

  const uid = $props.id();
  const titleId = `${uid}-title`;

  async function toggleTwoFa() {
    // bind:checked already applied the new value (WR-02: the switch rolls back on a failed save). 2FA is the
    // most security-relevant switch of the page; it must never claim a state the server rejected.
    const previous = !twoFaEnabled;
    twoFaSaving = true;
    twoFaError = "";
    try {
      await api.put("/settings/security", { twoFaEnabled });
      toasts.success("Einstellung gespeichert.");
    } catch (e: unknown) {
      twoFaEnabled = previous;
      twoFaError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      twoFaSaving = false;
    }
  }
</script>

<section class="settings-group" id="zwei-faktor" aria-labelledby={titleId}>
  <h2 class="settings-group-title" id={titleId}>Zwei-Faktor-Authentifizierung</h2>
  <p class="settings-group-desc">
    Zusätzlicher Schutz bei der Anmeldung. Die Einstellung gilt sofort, sobald du sie änderst.
  </p>
  {#if twoFaError}
    <div role="alert"><Note tone="bad">{twoFaError}</Note></div>
  {/if}
  <ToggleField
    bind:checked={twoFaEnabled}
    onchange={toggleTwoFa}
    label="Zwei-Faktor-Authentifizierung per E-Mail verlangen"
    help="Nach der Anmeldung schickt Clokr einen 6-stelligen Code per E-Mail."
    disabled={!canEdit || twoFaSaving}
    testid="admin-system-sicherheit-twoFaEnabled"
  />
</section>
