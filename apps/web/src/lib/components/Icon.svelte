<script lang="ts">
  // Phase 49.4 — Shared inline SVG icon, mirrors Sidebar `navIcon` style.
  // 17×17 default, currentColor stroke, rounded linecaps; expand size via prop.
  interface Props {
    name: string;
    size?: number;
    title?: string;
  }
  let { name, size = 17, title }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={title ? "img" : "presentation"}
  aria-label={title}
  aria-hidden={title ? undefined : true}
>
  {#if name === "dashboard"}
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  {:else if name === "clock"}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  {:else if name === "calendar"}
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M16 3v4M8 3v4M3 10h18" />
  {:else if name === "calendar-check"}
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M16 3v4M8 3v4M3 10h18" />
    <path d="M9 15l2.5 2.5L16 13" />
  {:else if name === "umbrella"}
    <path d="M12 3v18M3 12a9 9 0 0 1 18 0H3z" />
    <path d="M9 12a3 3 0 0 1 6 0" />
    <path d="M12 21a2 2 0 0 1-2-2" />
  {:else if name === "inbox"}
    <path d="M3 13l3-9h12l3 9" />
    <path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
    <path d="M3 13h5l1 3h6l1-3h5" />
  {:else if name === "users"}
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <circle cx="17" cy="9" r="2.8" />
    <path d="M16 20a5 5 0 0 1 5.5-5" />
  {:else if name === "grid"}
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  {:else if name === "chart"}
    <path d="M4 20V8M10 20V4M16 20v-7M22 20H2" />
  {:else if name === "shield"}
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  {:else if name === "download"}
    <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
    <path d="M4 19h16" />
  {:else if name === "upload"}
    <path d="M12 21V9m0 0l-4 4m4-4l4 4" />
    <path d="M4 5h16" />
  {:else if name === "lock"}
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  {:else if name === "palette"}
    <path d="M12 3a9 9 0 0 0 0 18c1 0 2-.8 2-2a2 2 0 0 1 2-2h1a4 4 0 0 0 4-4 9 9 0 0 0-9-10z" />
    <circle cx="7.5" cy="10.5" r="1" />
    <circle cx="12" cy="7.5" r="1" />
    <circle cx="16.5" cy="10.5" r="1" />
  {:else if name === "star"}
    <path d="M12 2.5l3 6.2 6.8 1-4.9 4.8 1.2 6.8L12 17.9 5.9 21.3l1.2-6.8L2.2 9.7l6.8-1z" />
  {:else if name === "wifi"}
    <path d="M3 9a15 15 0 0 1 18 0" />
    <path d="M6 12.5a10 10 0 0 1 12 0" />
    <path d="M9 16a5 5 0 0 1 6 0" />
    <circle cx="12" cy="19.5" r="1" fill="currentColor" />
  {:else if name === "settings"}
    <circle cx="12" cy="12" r="3" />
    <path
      d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
    />
  {:else if name === "logout"}
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  {:else if name === "sun"}
    <circle cx="12" cy="12" r="4" />
    <path
      d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
    />
  {:else if name === "alert"}
    <path
      d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
    />
    <path d="M12 9v4M12 17h.01" />
  {:else if name === "circle-fill"}
    <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
  {:else if name === "medical"}
    <path d="M12 3v18M3 12h18" />
    <rect x="3" y="3" width="18" height="18" rx="3" />
  {:else if name === "baby"}
    <path d="M9 12h.01M15 12h.01" />
    <path d="M9.5 16.5a4.5 4.5 0 0 0 5 0" />
    <circle cx="12" cy="12" r="9" />
    <path d="M8 3a4 4 0 0 1 8 0" />
  {:else if name === "heart"}
    <path
      d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
    />
  {:else if name === "x"}
    <path d="M18 6L6 18M6 6l12 12" />
  {:else if name === "check"}
    <path d="M5 12l5 5L20 7" />
  {:else if name === "minus"}
    <path d="M5 12h14" />
  {:else if name === "leaf"}
    <path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 11-9h5a14 14 0 0 1-9 16z" />
    <path d="M2 22c3-3 6-6 9-9" />
  {/if}
</svg>
