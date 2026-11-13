<!--
  Verwalten › System › Allgemein (Issue #854, D-854-03): what is left of the former System page once the
  working-time defaults, the closing settings, the mail settings, the roster settings and the integrations
  moved to their own pages - the company and its region, and the security of the sign-in (two-factor,
  password policy, sessions). The page is a settings page without tabs: four sections, each with its own
  save (lib/settings/settings-pages.ts). Branding & Themes is its own page.

  The company section reads `GET /settings/work`, the three security sections read `GET /settings/security`.
  A section whose data could not be loaded shows that instead of an editable form with made-up defaults:
  saving those would overwrite the stored values (the former page swallowed a failed security load). Each
  section keeps its own snapshot and sends only its own fields (#878).
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { pageLabel } from "$lib/nav/page-labels";
  import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";
  import type { CompanyConfig, SecurityConfig } from "$lib/settings/allgemein";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import CompanySection from "$lib/components/admin/allgemein/CompanySection.svelte";
  import PasswordSection from "$lib/components/admin/allgemein/PasswordSection.svelte";
  import SessionSection from "$lib/components/admin/allgemein/SessionSection.svelte";
  import TwoFactorSection from "$lib/components/admin/allgemein/TwoFactorSection.svelte";

  const LOAD_ERROR = "Diese Einstellungen konnten nicht geladen werden.";

  /** One endpoint of the page: not asked yet, loading, loaded or failed. */
  type Loaded<T> =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; data: T }
    | { status: "failed"; message: string };

  let company = $state<Loaded<CompanyConfig>>({ status: "idle" });
  let security = $state<Loaded<SecurityConfig>>({ status: "idle" });

  const user = $derived($authStore.user);
  const show = $derived({
    unternehmen: mayOpenSection(user, settingsSection("allgemein-unternehmen")),
    zweiFaktor: mayOpenSection(user, settingsSection("allgemein-zwei-faktor")),
    passwort: mayOpenSection(user, settingsSection("allgemein-passwort")),
    sitzungen: mayOpenSection(user, settingsSection("allgemein-sitzungen")),
  });
  const showSecurity = $derived(show.zweiFaktor || show.passwort || show.sitzungen);

  async function load<T>(path: string, set: (next: Loaded<T>) => void) {
    set({ status: "loading" });
    try {
      set({ status: "ready", data: await api.get<T>(path) });
    } catch (err) {
      set({ status: "failed", message: err instanceof Error ? err.message : LOAD_ERROR });
    }
  }

  // Each endpoint is asked once, as soon as the person is known to be allowed to open a section that needs it.
  $effect(() => {
    if (show.unternehmen && untrack(() => company.status) === "idle") {
      void load<CompanyConfig>("/settings/work", (next) => (company = next));
    }
  });
  $effect(() => {
    if (showSecurity && untrack(() => security.status) === "idle") {
      void load<SecurityConfig>("/settings/security", (next) => (security = next));
    }
  });

  // The unsaved counts of the sections, summed into ONE registration (a second registration under the
  // same id would let one section's cleanup disarm the others). The two-factor switch saves instantly and
  // is never unsaved.
  const changes = $state({ unternehmen: 0, passwort: 0, sitzungen: 0 });
  const totalChanges = $derived(changes.unternehmen + changes.passwort + changes.sitzungen);

  // Gated on "a baseline has been taken": only a loaded section can have unsaved changes, and a page
  // that shows nothing but errors must not arm the navigation guard.
  const snapshotsReady = $derived(company.status === "ready" || security.status === "ready");

  $effect(() => {
    markUnsaved("admin-system", snapshotsReady && totalChanges > 0);
    return () => markUnsaved("admin-system", false);
  });

  const loading = $derived(
    (show.unternehmen && (company.status === "idle" || company.status === "loading")) ||
      (showSecurity && (security.status === "idle" || security.status === "loading")),
  );
</script>

<svelte:head>
  <title>{pageLabel("/admin/system")} – Clokr</title>
</svelte:head>

<!-- `display: contents` keeps the layout intact while giving the e2e specs a stable page-root selector. -->
<div data-testid="admin-system-page" style="display: contents;">
  <PageHead
    title={pageLabel("/admin/system")}
    sub="Hier legst du den Namen, die Region und die Sicherheit der Anmeldung für das ganze Unternehmen fest."
  />

  {#if loading}
    <Skeleton shape="card" lines={4} />
  {/if}

  {#if show.unternehmen}
    {#if company.status === "ready"}
      <CompanySection config={company.data} bind:changes={changes.unternehmen} />
    {:else if company.status === "failed"}
      <div role="alert"><Note tone="bad">{LOAD_ERROR} (Unternehmen & Region)</Note></div>
    {/if}
  {/if}

  {#if showSecurity}
    {#if security.status === "ready"}
      {#if show.zweiFaktor}
        <TwoFactorSection config={security.data} />
      {/if}
      {#if show.passwort}
        <PasswordSection config={security.data} bind:changes={changes.passwort} />
      {/if}
      {#if show.sitzungen}
        <SessionSection config={security.data} bind:changes={changes.sitzungen} />
      {/if}
    {:else if security.status === "failed"}
      <div role="alert"><Note tone="bad">{LOAD_ERROR} (Sicherheit)</Note></div>
    {/if}
  {/if}
</div>
