<!--
  ReasonCallout - one reason of a refused salon action, chosen by its machine code (Issue #89,
  D-13, D-14a). The sentence comes from the reasons module: a known code renders the console's own
  count-free text, an unknown code the server's string. Without a code nothing is rendered.
-->
<script lang="ts">
  import { reasonText } from "$lib/operator/reasons";

  interface Props {
    code?: string | null;
    /** The server's own message; shown only for a code the console does not know. */
    serverError?: string;
    /** Names the salon in a page-level notice: „Salon „{subject}“: {reason}“. */
    subject?: string;
    /** For `aria-describedby` of the field the reason belongs to. */
    id?: string;
  }

  let { code = null, serverError, subject, id }: Props = $props();

  const text = $derived.by(() => {
    if (!code) return "";
    const reason = reasonText(code, serverError);
    return subject ? `Salon „${subject}“: ${reason}` : reason;
  });
</script>

{#if code}
  <div class="callout brand" role="alert" {id} data-code={code} data-testid="op-reason-callout">
    <p>{text}</p>
  </div>
{/if}
