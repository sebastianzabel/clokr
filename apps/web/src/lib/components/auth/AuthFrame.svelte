<script lang="ts">
  // Issue #855 (D-855-01): the one frame of every signed-out page (sign-in, 2FA, invitation, password
  // forgotten / reset) and of the standalone error page. A calm surface on the page ground with the
  // logo of #852 above the title — no brand panel, gradient or floating decoration (design concept
  // § 1 and criterion 4). The page owns its content; the frame owns layout, logo and heading.
  import type { Snippet } from "svelte";
  import BrandLogo from "$lib/components/brand/BrandLogo.svelte";

  interface Props {
    title: string;
    subtitle?: string;
    children: Snippet;
    /** Secondary links under the surface (e.g. „Zurück zur Anmeldung“). */
    footer?: Snippet;
  }

  let { title, subtitle, children, footer }: Props = $props();
</script>

<div class="auth-page">
  <main class="auth-main" id="main-content">
    <div class="auth-logo">
      <BrandLogo size={32} />
    </div>
    <section class="auth-card" aria-labelledby="auth-title">
      <header class="auth-head">
        <h1 id="auth-title" class="auth-title">{title}</h1>
        {#if subtitle}<p class="auth-subtitle">{subtitle}</p>{/if}
      </header>
      <div class="auth-body">
        {@render children()}
      </div>
    </section>
    {#if footer}
      <div class="auth-footer">{@render footer()}</div>
    {/if}
  </main>
</div>

<style>
  .auth-page {
    min-height: 100dvh;
    background: var(--bg);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--s-8) var(--s-4);
  }

  .auth-main {
    width: 100%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--s-6);
  }

  .auth-logo {
    display: flex;
    justify-content: center;
    color: var(--text);
  }

  .auth-card {
    background: var(--card);
    border: 1px solid var(--line);
    /* a surface (Fläche, 14 px), not the stage (design concept § 3) */
    border-radius: var(--r-card);
    box-shadow: var(--shadow);
    padding: var(--s-8) var(--s-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }

  .auth-head {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .auth-title {
    font-size: var(--fs-h1);
    font-weight: 600;
    line-height: 1.3;
    margin: 0;
    color: var(--text);
  }

  .auth-subtitle {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--text-2);
  }

  .auth-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .auth-footer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  /* Shared pieces the auth pages place inside the body (one recipe, not one copy per page). */
  .auth-body :global(.auth-form) {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .auth-body :global(.auth-submit) {
    width: 100%;
    height: var(--h-stage);
    justify-content: center;
    gap: var(--s-2);
  }

  .auth-body :global(.auth-row),
  .auth-footer :global(.auth-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    font-size: var(--fs-sm);
  }

  .auth-body :global(.auth-link),
  .auth-footer :global(.auth-link) {
    color: var(--brand);
    text-decoration: none;
    font-weight: 500;
  }

  .auth-body :global(.auth-link:hover),
  .auth-footer :global(.auth-link:hover) {
    text-decoration: underline;
  }

  @media (max-width: 480px) {
    .auth-card {
      padding: var(--s-6) var(--s-4);
    }
  }
</style>
