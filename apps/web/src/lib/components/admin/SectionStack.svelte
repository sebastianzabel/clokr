<!--
  SectionStack — Admin page shell for stacked section-card layouts.

  Renders the global <PageHead> + a <div class="page"> flex column that hosts
  one or more <Section> children and an optional <DangerZone> at the bottom.

  When `tabs` is passed, renders a tab strip (reusing the global .view-tabs /
  .view-tab / .view-tab--active recipe from app.css) and delegates per-tab
  content to the `tabContent` snippet — same pattern as <ListDetail>. This
  exists so config pages with many sections can group them by concern without
  growing into a multi-thousand-pixel scroll.

  ARIA: tablist / tab / tabpanel per ARIA 1.1 Tabs Pattern.
  Keyboard nav: ← → Home End change the active tab.

  Sets the "admin-animate" Svelte context so nested Section components inherit
  the `animate` flag without needing it passed explicitly on each Section.

  Props:
    eyebrow    — serif italic eyebrow (passed to PageHead)
    title      — page H1 (passed to PageHead)
    accent     — optional accent word in H1 (passed to PageHead)
    sub        — optional muted sub-paragraph (passed to PageHead)
    animate    — when true, child Sections with card-animate receive staggered
                 entrance animations (propagated via admin-animate context)
    actions    — optional right-aligned action cluster next to the H1 (snippet)
    tabs       — optional ordered list of { id, label }; presence enables tabs
    activeTab  — bindable active tab id; defaults to tabs[0].id; syncs to URL hash
    tabContent — called with (tabId: string) when tabs are present (snippet)
    children   — one or more <Section> cards (used when tabs are NOT present)
    dangerZone — optional <DangerZone> rendered after children/tab content

  Example (tabbed):
    <SectionStack
      eyebrow="Personal"
      title="Urlaubsverwaltung"
      tabs={[{ id: "general", label: "Allgemein" }, { id: "rules", label: "Regeln" }]}
      bind:activeTab
      animate
    >
      {#snippet tabContent(tab)}
        {#if tab === "general"}
          <Section title="ALLGEMEIN">…</Section>
        {:else if tab === "rules"}
          <Section title="REGELN">…</Section>
        {/if}
      {/snippet}
    </SectionStack>
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { setContext, onMount } from "svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";

  interface Tab {
    id: string;
    label: string;
  }

  interface Props {
    eyebrow: string;
    title: string;
    accent?: string;
    sub?: string;
    animate?: boolean;
    actions?: Snippet;
    tabs?: Tab[];
    activeTab?: string;
    tabContent?: Snippet<[string]>;
    children?: Snippet;
    dangerZone?: Snippet;
  }

  let {
    eyebrow,
    title,
    accent,
    sub,
    animate = false,
    actions,
    tabs,
    activeTab = $bindable(undefined),
    tabContent,
    children,
    dangerZone,
  }: Props = $props();

  const id = $props.id();

  // Default to the first tab id when tabs are present and activeTab is not set.
  const defaultActiveTab = $derived(tabs && tabs.length > 0 ? tabs[0].id : undefined);
  const currentTab = $derived(activeTab ?? defaultActiveTab);

  // Propagate animate to nested Section components via context.
  setContext("admin-animate", animate);

  // Sync activeTab with URL hash on mount and on change (deep linking).
  onMount(() => {
    if (!tabs || tabs.length === 0) return;
    const hash = window.location.hash.slice(1);
    if (tabs.some((t) => t.id === hash)) {
      activeTab = hash;
    }
  });

  $effect(() => {
    if (!tabs || tabs.length === 0) return;
    if (typeof window === "undefined") return;
    if (activeTab) {
      const target = `#${encodeURIComponent(activeTab)}`;
      if (window.location.hash !== target) {
        history.replaceState(null, "", target);
      }
    }
  });

  function selectTab(tabId: string) {
    activeTab = tabId;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!tabs || tabs.length === 0) return;
    const current = tabs.findIndex((t) => t.id === (activeTab ?? defaultActiveTab));
    if (current === -1) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const prev = current > 0 ? current - 1 : tabs.length - 1;
      selectTab(tabs[prev].id);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = current < tabs.length - 1 ? current + 1 : 0;
      selectTab(tabs[next].id);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab(tabs[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab(tabs[tabs.length - 1].id);
    }
  }
</script>

<PageHead {eyebrow} {title} {accent} {sub} {actions} />

<div class="page">
  {#if tabs && tabs.length > 0}
    <div class="view-tabs" role="tablist" aria-label={title} onkeydown={handleKeydown}>
      {#each tabs as tab (tab.id)}
        <button
          class="view-tab"
          class:view-tab--active={tab.id === currentTab}
          role="tab"
          aria-selected={tab.id === currentTab}
          aria-controls="{id}-panel-{tab.id}"
          id="{id}-tab-{tab.id}"
          tabindex={tab.id === currentTab ? 0 : -1}
          onclick={() => selectTab(tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    {#if currentTab}
      <div
        role="tabpanel"
        id="{id}-panel-{currentTab}"
        aria-labelledby="{id}-tab-{currentTab}"
        class="tab-panel"
      >
        {@render tabContent?.(currentTab)}
      </div>
    {/if}
  {:else}
    {@render children?.()}
  {/if}
  {@render dangerZone?.()}
</div>

<style>
  .tab-panel {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }
</style>
