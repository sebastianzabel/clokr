<!--
  ToolPage — Admin page shell for single-tool or wizard-style pages.

  Renders <PageHead> followed by an optional step indicator, then the required
  form snippet, and optional result and history snippets below it.

  When both `steps` and `currentStep` are provided the step indicator is shown
  above the form — an ordered list of numbered circles connected by horizontal
  lines. Active step: --brand background with white number. Completed steps
  (index < currentStep): --good background with a checkmark. Upcoming steps:
  muted border + text.

  Props:
    eyebrow     — serif italic eyebrow (passed to PageHead)
    title       — page H1 (passed to PageHead)
    accent      — optional accent word in H1 (passed to PageHead)
    sub         — optional muted sub-paragraph (passed to PageHead)
    animate     — when true, propagates admin-animate context to child Sections
    actions     — optional right-aligned action cluster (snippet)
    steps       — ordered list of step label strings; omit to hide indicator
    currentStep — 0-based index of the active step
    form        — main tool form / controls (required snippet)
    result      — optional output area rendered below the form (snippet)
    history     — optional history/log area rendered last (snippet)

  Example (no steps):
    <ToolPage eyebrow="Administration" title="Daten importieren">
      {#snippet form()}
        <Section title="DATEI HOCHLADEN">
          <ImportDropzone />
        </Section>
      {/snippet}
    </ToolPage>

  Example (with steps):
    <ToolPage
      eyebrow="Administration"
      title="DATEV-Export"
      steps={["Zeitraum", "Prüfen", "Exportieren"]}
      currentStep={1}
    >
      {#snippet form()}
        <Section title="PRÜFBERICHT"><ReviewTable /></Section>
      {/snippet}
      {#snippet result()}
        <Section title="ERGEBNIS"><DownloadLinks /></Section>
      {/snippet}
    </ToolPage>
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
    steps?: string[];
    currentStep?: number;
    /**
     * Optional tab strip rendered between PageHead and step indicator.
     * When present, the page's `form` snippet is responsible for branching
     * on `activeTab`. Step indicator visibility is still controlled by
     * `steps` — pass `undefined` to hide it on tabs that aren't a wizard.
     */
    tabs?: Tab[];
    activeTab?: string;
    form: Snippet;
    result?: Snippet;
    history?: Snippet;
  }

  let {
    eyebrow,
    title,
    accent,
    sub,
    animate = false,
    actions,
    steps,
    currentStep = 0,
    tabs,
    activeTab = $bindable(undefined),
    form,
    result,
    history,
  }: Props = $props();

  const id = $props.id();
  const showSteps = $derived(steps !== undefined && steps.length > 0 && currentStep !== undefined);

  // Propagate animate to nested Section components via context.
  setContext("admin-animate", animate);

  // Default to the first tab id when tabs are present and activeTab is unset.
  const defaultActiveTab = $derived(tabs && tabs.length > 0 ? tabs[0].id : undefined);
  const currentTab = $derived(activeTab ?? defaultActiveTab);

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
        window.history.replaceState(null, "", target);
      }
    }
  });

  function selectTab(tabId: string) {
    activeTab = tabId;
  }

  function handleTabsKeydown(event: KeyboardEvent) {
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

{#if tabs && tabs.length > 0}
  <div
    class="view-tabs toolpage-tabs"
    role="tablist"
    aria-label={title}
    onkeydown={handleTabsKeydown}
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
{/if}

{#if showSteps && steps}
  <nav class="step-indicator" role="navigation" aria-label="Schritte">
    <ol class="steps-list">
      {#each steps as step, i}
        {@const isCompleted = i < currentStep}
        {@const isActive = i === currentStep}
        {#if isActive}
          <li class="step step--active" aria-current="step">
            {#if i > 0}
              <div class="step-connector" aria-hidden="true"></div>
            {/if}
            <div class="step-circle" aria-hidden="true">
              <span>{i + 1}</span>
            </div>
            <span class="step-label">{step}</span>
          </li>
        {:else if isCompleted}
          <li class="step step--completed">
            {#if i > 0}
              <div class="step-connector" aria-hidden="true"></div>
            {/if}
            <div class="step-circle" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M2 6l3 3 5-5"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </div>
            <span class="step-label">{step}</span>
          </li>
        {:else}
          <li class="step">
            {#if i > 0}
              <div class="step-connector" aria-hidden="true"></div>
            {/if}
            <div class="step-circle" aria-hidden="true">
              <span>{i + 1}</span>
            </div>
            <span class="step-label">{step}</span>
          </li>
        {/if}
      {/each}
    </ol>
  </nav>
{/if}

<div
  class="page"
  role={tabs && tabs.length > 0 ? "tabpanel" : undefined}
  id={tabs && tabs.length > 0 && currentTab ? `${id}-panel-${currentTab}` : undefined}
  aria-labelledby={tabs && tabs.length > 0 && currentTab ? `${id}-tab-${currentTab}` : undefined}
>
  {@render form()}
  {@render result?.()}
  {@render history?.()}
</div>

<style>
  .toolpage-tabs {
    margin-bottom: var(--s-4);
  }

  /* ── Step Indicator ─────────────────────────────────────────── */

  .step-indicator {
    margin-bottom: var(--s-2);
  }

  .steps-list {
    display: flex;
    align-items: center;
    gap: 0;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .step {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    position: relative;
  }

  /* Connector line between steps */
  .step-connector {
    width: var(--s-8);
    height: 2px;
    background: var(--border);
    flex-shrink: 0;
    transition: background 0.2s var(--ease);
    margin-right: var(--s-2);
  }

  .step--completed .step-connector {
    background: var(--good);
  }

  /* Step circle — 24px diameter */
  .step-circle {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    border: 2px solid var(--border);
    color: var(--text-faint);
    background: var(--bg-card);
    transition:
      background 0.2s var(--ease),
      border-color 0.2s var(--ease),
      color 0.2s var(--ease);
  }

  .step--active .step-circle {
    background: var(--brand);
    border-color: var(--brand);
    color: var(--text-on-brand);
  }

  .step--completed .step-circle {
    background: var(--good);
    border-color: var(--good);
    color: #ffffff;
  }

  /* Step label */
  .step-label {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 500;
    color: var(--text-faint);
    white-space: nowrap;
    transition: color 0.2s var(--ease);
  }

  .step--active .step-label {
    color: var(--text);
    font-weight: 600;
  }

  .step--completed .step-label {
    color: var(--text-muted);
  }

  /* Responsive: hide labels on small screens, keep circles + connectors */
  @media (max-width: 480px) {
    .step-label {
      display: none;
    }

    .step-connector {
      width: var(--s-4);
    }
  }
</style>
