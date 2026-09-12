<!-- Test fixture: wraps Section so tests can mount it with (or without) a real footer
     snippet plus a `dirty` prop, without hand-rolling snippet creation from plain TS. -->
<script lang="ts">
  import Section from "$lib/components/admin/Section.svelte";

  interface Props {
    title?: string;
    dirty?: boolean;
    withFooter?: boolean;
  }

  let { title = "TEST", dirty, withFooter = true }: Props = $props();
</script>

{#if withFooter}
  <Section {title} {dirty}>
    <p data-testid="section-body">Inhalt</p>
    {#snippet footer()}
      <button class="btn btn-primary btn-sm">Speichern</button>
    {/snippet}
  </Section>
{:else}
  <Section {title} {dirty}>
    <p data-testid="section-body">Inhalt</p>
  </Section>
{/if}
