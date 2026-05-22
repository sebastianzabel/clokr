<!--
  ListDetail — Admin page shell for List+Detail navigation patterns.

  Renders the global <PageHead> in both modes. In "detail" mode it optionally
  renders a <Breadcrumb>, a tab strip, and per-tab content.

  Tab strip reuses the GLOBAL .view-tabs / .view-tab / .view-tab--active recipe
  from app.css — no new tab CSS is introduced.

  ARIA: tablist / tab / tabpanel per ARIA 1.1 Tabs Pattern.
  Keyboard nav: ← → Home End change the active tab.

  IDs for ARIA linkage are derived from `$props.id()` so multiple instances
  never share the same DOM ids even if the same ListDetail is instantiated
  more than once on a page.

  Props:
    view       — "list" | "detail" (discriminates the two modes)
    eyebrow    — serif italic eyebrow (passed to PageHead)
    title      — page H1 (passed to PageHead)
    accent     — optional accent word in H1 (passed to PageHead)
    sub        — optional muted sub-paragraph (passed to PageHead)
    actions    — optional right-aligned action cluster next to the H1 (snippet)
    crumbs     — Breadcrumb crumbs in detail mode (optional)
    tabs       — ordered list of { id, label } objects; omit to hide tab strip
    activeTab  — bindable active tab id; defaults to tabs[0].id
    list       — list-mode body content (snippet)
    tabContent — called with (tabId: string) in detail mode (snippet)

  Example (list mode):
    <ListDetail eyebrow="Administration" title="Mandanten" view="list">
      {#snippet list()}
        <ul>...</ul>
      {/snippet}
    </ListDetail>

  Example (detail mode with tabs):
    <ListDetail
      eyebrow="Administration"
      title="Mandant"
      view="detail"
      crumbs={[{ label: "Mandanten", href: "/admin/tenants" }, { label: tenantName }]}
      tabs={[{ id: "general", label: "Allgemein" }, { id: "billing", label: "Abrechnung" }]}
      bind:activeTab
    >
      {#snippet tabContent(tab)}
        {#if tab === "general"}
          <SectionStack ...>...</SectionStack>
        {:else if tab === "billing"}
          ...
        {/if}
      {/snippet}
    </ListDetail>
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Breadcrumb from "$lib/components/ui/Breadcrumb.svelte";

  interface Crumb {
    label: string;
    href?: string;
  }

  interface Tab {
    id: string;
    label: string;
  }

  interface Props {
    view: "list" | "detail";
    eyebrow: string;
    title: string;
    accent?: string;
    sub?: string;
    actions?: Snippet;
    crumbs?: Crumb[];
    tabs?: Tab[];
    activeTab?: string;
    list?: Snippet;
    tabContent?: Snippet<[string]>;
  }

  let {
    view,
    eyebrow,
    title,
    accent,
    sub,
    actions,
    crumbs,
    tabs,
    activeTab = $bindable(undefined),
    list,
    tabContent,
  }: Props = $props();

  const id = $props.id();

  // Default to the first tab id when tabs are present and activeTab is not set.
  const defaultActiveTab = $derived(tabs && tabs.length > 0 ? tabs[0].id : undefined);
  const currentTab = $derived(activeTab ?? defaultActiveTab);

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
  {#if view === "list"}
    {@render list?.()}
  {:else}
    {#if crumbs && crumbs.length > 0}
      <Breadcrumb {crumbs} />
    {/if}

    {#if tabs && tabs.length > 0}
      <div
        class="view-tabs"
        role="tablist"
        aria-label={title}
        onkeydown={handleKeydown}
      >
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
        >
          {@render tabContent?.(currentTab)}
        </div>
      {/if}
    {:else}
      {@render tabContent?.(currentTab ?? "")}
    {/if}
  {/if}
</div>
