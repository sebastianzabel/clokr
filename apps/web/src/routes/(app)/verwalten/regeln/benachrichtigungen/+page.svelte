<!--
  Verwalten › Regeln › Benachrichtigungen & E-Mail (Issue #854, D-854-03): the mail server (with a test
  mail), the e-mail notification switches and the reminder settings of the company. The sections were moved
  here from the System page (Kommunikation) and the Urlaub page (Erinnerungen) - every setting lives exactly
  once (lib/settings/settings-pages.ts). The shift reminders are not here, they belong to the roster settings.

  The three sections read three different endpoints, so the page loads each one only when the person may
  open the section that needs it (D-854-05: a section keeps the permission alternatives of the page it came
  from). A section whose data could not be loaded shows that instead of an editable form with made-up
  defaults: saving those would overwrite the stored values. Each section keeps its own snapshot and sends
  only its own fields (#878).
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { mailWithoutDelivery } from "$lib/admin/setup-checks"; // Issue #847
  import { pageLabel } from "$lib/nav/page-labels";
  import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";
  import type {
    ReminderConfig,
    SecurityEmailConfig,
    SmtpConfig,
  } from "$lib/settings/benachrichtigungen";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import SmtpSection from "$lib/components/admin/benachrichtigungen/SmtpSection.svelte";
  import EmailSection from "$lib/components/admin/benachrichtigungen/EmailSection.svelte";
  import RemindersSection from "$lib/components/admin/benachrichtigungen/RemindersSection.svelte";

  const LOAD_ERROR = "Diese Einstellungen konnten nicht geladen werden.";

  /** One endpoint of the page: not asked yet, loading, loaded or failed. */
  type Loaded<T> =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; data: T }
    | { status: "failed"; message: string };

  let smtp = $state<Loaded<SmtpConfig>>({ status: "idle" });
  let security = $state<Loaded<SecurityEmailConfig>>({ status: "idle" });
  let work = $state<Loaded<ReminderConfig>>({ status: "idle" });

  // Issue #847: whether mail can be sent (the server's `deliveryReady`) and the STORED master switch decide
  // the one warning „E-Mail aktiv, SMTP nicht eingerichtet“ - both sections show it, the rule is the shared
  // `mailWithoutDelivery()`. A source that was not read (no permission, load failed) never warns.
  let deliveryReady = $state<boolean | null>(null);
  let emailEnabled = $state<boolean | undefined>(undefined);
  const mailWarning = $derived(
    mailWithoutDelivery(
      { emailNotificationsEnabled: emailEnabled },
      deliveryReady === null ? null : { deliveryReady },
    ),
  );

  /** Re-read after an SMTP save: the warning follows the server's answer, not the typed form. */
  async function refreshDelivery() {
    deliveryReady =
      (await api.get<SmtpConfig>("/settings/smtp").catch(() => null))?.deliveryReady ??
      deliveryReady;
  }

  const user = $derived($authStore.user);
  const show = $derived({
    smtp: mayOpenSection(user, settingsSection("benachrichtigungen-smtp")),
    email: mayOpenSection(user, settingsSection("benachrichtigungen-email")),
    erinnerungen: mayOpenSection(user, settingsSection("benachrichtigungen-erinnerungen")),
  });

  async function load<T>(path: string, set: (next: Loaded<T>) => void) {
    set({ status: "loading" });
    try {
      set({ status: "ready", data: await api.get<T>(path) });
    } catch (err) {
      set({ status: "failed", message: err instanceof Error ? err.message : LOAD_ERROR });
    }
  }

  // Each endpoint is asked once, as soon as the person is known to be allowed to open its section.
  $effect(() => {
    if (show.smtp && untrack(() => smtp.status) === "idle") {
      void load<SmtpConfig>("/settings/smtp", (next) => {
        smtp = next;
        if (next.status === "ready") deliveryReady = next.data.deliveryReady ?? null;
      });
    }
  });
  $effect(() => {
    if (show.email && untrack(() => security.status) === "idle") {
      void load<SecurityEmailConfig>("/settings/security", (next) => {
        security = next;
        if (next.status === "ready") emailEnabled = next.data.emailNotificationsEnabled ?? false;
      });
    }
  });
  $effect(() => {
    if (show.erinnerungen && untrack(() => work.status) === "idle") {
      void load<ReminderConfig>("/settings/work", (next) => (work = next));
    }
  });

  // The unsaved counts of the sections, summed into ONE registration (a second registration under the
  // same id would let one section's cleanup disarm the others).
  const changes = $state({ smtp: 0, email: 0, erinnerungen: 0 });
  const totalChanges = $derived(changes.smtp + changes.email + changes.erinnerungen);

  // Gated on "a baseline has been taken": only a loaded section can have unsaved changes, and a page
  // that shows nothing but errors must not arm the navigation guard.
  const snapshotsReady = $derived(
    smtp.status === "ready" || security.status === "ready" || work.status === "ready",
  );

  $effect(() => {
    markUnsaved("regeln-benachrichtigungen", snapshotsReady && totalChanges > 0);
    return () => markUnsaved("regeln-benachrichtigungen", false);
  });

  const loading = $derived(
    (show.smtp && (smtp.status === "idle" || smtp.status === "loading")) ||
      (show.email && (security.status === "idle" || security.status === "loading")) ||
      (show.erinnerungen && (work.status === "idle" || work.status === "loading")),
  );
</script>

<svelte:head>
  <title>{pageLabel("/verwalten/regeln/benachrichtigungen")} – Clokr</title>
</svelte:head>

<Breadcrumb
  crumbs={[
    { label: pageLabel("/verwalten/regeln"), href: "/verwalten/regeln" },
    { label: pageLabel("/verwalten/regeln/benachrichtigungen") },
  ]}
/>
<PageHead
  title={pageLabel("/verwalten/regeln/benachrichtigungen")}
  sub="Hier richtest du den E-Mail-Versand ein und legst fest, worüber Clokr benachrichtigt und woran es erinnert."
/>

{#if loading}
  <Skeleton shape="card" lines={4} />
{/if}

{#if show.smtp}
  {#if smtp.status === "ready"}
    <SmtpSection
      config={smtp.data}
      bind:changes={changes.smtp}
      {mailWarning}
      onSaved={refreshDelivery}
    />
  {:else if smtp.status === "failed"}
    <div role="alert"><Note tone="bad">{LOAD_ERROR} (E-Mail-Server)</Note></div>
  {/if}
{/if}
{#if show.email}
  {#if security.status === "ready"}
    <EmailSection
      config={security.data}
      bind:changes={changes.email}
      {mailWarning}
      onSaved={(enabled) => (emailEnabled = enabled)}
    />
  {:else if security.status === "failed"}
    <div role="alert"><Note tone="bad">{LOAD_ERROR} (E-Mail-Benachrichtigungen)</Note></div>
  {/if}
{/if}
{#if show.erinnerungen}
  {#if work.status === "ready"}
    <RemindersSection config={work.data} bind:changes={changes.erinnerungen} />
  {:else if work.status === "failed"}
    <div role="alert"><Note tone="bad">{LOAD_ERROR} (Erinnerungen)</Note></div>
  {/if}
{/if}
