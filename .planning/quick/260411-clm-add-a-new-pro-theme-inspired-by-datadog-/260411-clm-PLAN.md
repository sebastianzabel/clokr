---
phase: 260411-clm
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/web/src/app.css
  - apps/web/src/lib/stores/theme.ts
autonomous: false
requirements:
  - CLM-01  # Register a new "pro" theme (data-theme="pro") in app.css
  - CLM-02  # Add "pro" to theme store type + themes registry
  - CLM-03  # Theme uses indigo #4f46e5 accent, sharper radii, solid surfaces, denser layout, high-contrast text

must_haves:
  truths:
    - "User can open Admin → System → Erscheinungsbild and see 'Pro' as a fifth option in the theme dropdown"
    - "Selecting 'Pro' applies data-theme=\"pro\" on <html> and the entire app re-styles with indigo accent, near-black text on near-white background, solid (non-blurred) sidebar, and smaller radii"
    - "Selection persists across page reload (localStorage key 'theme' = 'pro')"
    - "Existing themes (pflaume, nacht, wald, schiefer) continue to work unchanged"
    - "Nav active state, buttons, inputs, cards, notification dropdown, and mobile nav all render correctly in Pro theme (no hardcoded pflaume colors leak through)"
  artifacts:
    - path: "apps/web/src/app.css"
      provides: "[data-theme=\"pro\"] block defining all required CSS custom properties"
      contains: "[data-theme=\"pro\"]"
    - path: "apps/web/src/lib/stores/theme.ts"
      provides: "'pro' added to Theme union and themes registry"
      contains: "'pro'"
  key_links:
    - from: "apps/web/src/lib/stores/theme.ts"
      to: "document.documentElement data-theme attribute"
      via: "theme.subscribe → setAttribute"
      pattern: "setAttribute.*data-theme"
    - from: "apps/web/src/routes/(app)/admin/system/+page.svelte"
      to: "themes array from $stores/theme"
      via: "{#each themes as t} <option value={t.id}>"
      pattern: "each themes"
    - from: "apps/web/src/app.css [data-theme=\"pro\"]"
      to: "every component that uses var(--color-brand|--color-bg|--radius-*|--glass-*)"
      via: "CSS custom property cascade on <html>"
      pattern: "var\\(--color-"
---

<objective>
Add a new "pro" theme inspired by Datadog/Linear to Clokr's existing 4-theme system (pflaume, nacht, wald, schiefer).

Purpose: Offer users a dense, high-contrast, professional-looking theme with indigo accent, solid surfaces (no glass blur), sharper corners, and a cold neutral palette — aimed at power users who prefer information density over the warm/soft aesthetic of pflaume.

Output: A fully registered fifth theme that users can select from Admin → System → Erscheinungsbild, with all UI elements (sidebar, nav, cards, inputs, dropdowns, notifications) rendering correctly.
</objective>

<execution_context>
@/Users/sebastianzabel/git/clokr/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@./CLAUDE.md
@apps/web/src/app.css
@apps/web/src/lib/stores/theme.ts
@apps/web/src/routes/(app)/admin/system/+page.svelte

<!--
  Existing theme blocks in app.css (reference):
  - [data-theme="pflaume"]  lines ~72–181  (warm plum, default)
  - [data-theme="nacht"]    lines ~189–278  (dark mode)
  - [data-theme="wald"]     lines ~280–354  (green)
  - [data-theme="schiefer"] lines ~356–432  (slate — closest structural analog to "pro")

  Every theme block MUST define (extracted from pflaume as the canonical template):
    Brand:       --color-brand, --color-brand-dark, --color-brand-light,
                 --color-brand-tint, --color-brand-tint-hover
    Surfaces:    --color-surface, --color-surface-raised
    Backgrounds: --color-bg, --color-bg-subtle, --color-bg-muted
    Text:        --color-text, --color-text-muted, --color-text-heading
    Borders:     --color-border, --color-border-subtle
    Grays:       --gray-50 .. --gray-900
    Status:      --color-green/yellow/red/blue/purple/orange (+ -bg, -border), --color-danger
    Typography:  --font-sans (keep "DM Sans", system-ui, sans-serif for consistency)
    Radii:       --radius-sm, --radius-md, --radius-lg  (ONLY pflaume declares these — other
                 themes inherit. For "pro" we OVERRIDE to 4px/8px/12px to get sharper corners.)
    Shadows:     --shadow-xs, --shadow-sm, --shadow-md, --shadow-lg
    Sidebar:     --sidebar-bg, --sidebar-border, --sidebar-brand-gradient,
                 --nav-active-bg, --nav-active-color, --nav-active-border
    Glass:       --glass-bg, --glass-bg-strong, --glass-border, --glass-blur, --glass-shadow
                 (For "pro": --glass-blur: 0; --glass-bg and -strong as solid opaque colors)
    (Optional)   --leave-type-* — only pflaume and nacht declare these; others inherit from pflaume.
                 Pro does NOT need to redeclare them.
-->

<!--
  Theme store contract (apps/web/src/lib/stores/theme.ts):
    export type Theme = 'pflaume' | 'nacht' | 'wald' | 'schiefer';
    export const themes: { id: Theme; label: string; color: string }[] = [...];
  theme.subscribe() writes localStorage.setItem('theme', value)
                  and document.documentElement.setAttribute('data-theme', value).
  The admin select in routes/(app)/admin/system/+page.svelte iterates {#each themes}
  — adding a new entry to the registry automatically adds it to the UI dropdown.
-->

<!--
  Pro theme palette (locked by user description — DO NOT deviate):
    Accent:       indigo #4f46e5  (Tailwind indigo-600 — Linear/Datadog-ish)
    Accent dark:  #4338ca  (indigo-700, for hover/active)
    Accent light: #818cf8  (indigo-400, for tints)

    Cold neutrals (near-neutral, slightly cooler than schiefer):
      bg:          #fafbfc  (near-white, very slight cool cast)
      bg-subtle:   #f3f5f8
      bg-muted:    #e4e8ee
      surface:     #ffffff
      text:        #0f172a  (near-black, high contrast)
      text-muted:  #475569  (slate-600 — WCAG AA on bg)
      text-heading:#020617  (darkest)
      border:      #d4d8df
      border-subtle: #e4e8ee

    Radii (sharper):
      --radius-sm: 4px
      --radius-md: 8px
      --radius-lg: 12px

    Solid surfaces (no glass blur):
      --glass-blur: 0
      --glass-bg: #ffffff
      --glass-bg-strong: #ffffff
      --glass-border: #d4d8df

    Denser layout: achieved via html[data-theme="pro"] { font-size: 15px; }
    (rem-based components shrink proportionally — safer than editing every component).

    Status colors: keep the pflaume/schiefer values (#16a34a green, #dc2626 red, etc.)
    BUT set --color-purple to the indigo accent family for consistency:
      --color-purple: #4f46e5
      --color-purple-bg: #eef2ff
      --color-purple-border: #c7d2fe

    Switcher badge color (for themes[] array):
      color: '#4f46e5'
    Label (German UI):
      label: 'Pro'
-->
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add [data-theme="pro"] block to app.css</name>
  <files>apps/web/src/app.css</files>
  <action>
Append a new theme block AFTER the existing `[data-theme="schiefer"]` block (insert before the "Base Reset" comment at line ~434). Do NOT modify any existing theme blocks.

The new block MUST define every CSS custom property listed in the template comment in <context>. Use the exact "Pro theme palette" values locked by the user.

Key requirements (non-negotiable):
  1. Accent is indigo #4f46e5 — use this for --color-brand.
  2. --radius-sm: 4px, --radius-md: 8px, --radius-lg: 12px (overrides pflaume's 8/14/22).
  3. --glass-blur: 0 and --glass-bg / --glass-bg-strong as SOLID opaque #ffffff (no rgba transparency). This gives the solid-surface look — sidebar and dropdowns will render without backdrop-filter blur.
  4. --color-text: #0f172a (near-black) on --color-bg: #fafbfc — high contrast text hierarchy.
  5. --sidebar-bg: #ffffff (solid, not glass).
  6. --nav-active-bg: #eef2ff, --nav-active-color: #4f46e5, --nav-active-border: #4f46e5.
  7. --color-brand-tint: #eef2ff (indigo-50), --color-brand-tint-hover: #e0e7ff (indigo-100).
  8. Gray scale: use cool neutral values (--gray-50: #fafbfc through --gray-900: #0f172a).
  9. Shadows: keep neutral (copy from schiefer — neutral gray rgba, not colored).
  10. --font-sans: same as other themes ("DM Sans", system-ui, sans-serif). Do NOT change font.
  11. Do NOT declare --leave-type-* vars (inherit from pflaume/nacht — same as wald/schiefer).
  12. After the block, append a SEPARATE rule for denser layout:
      html[data-theme="pro"] { font-size: 15px; }
      (This scales all rem-based spacing/typography proportionally ~6% tighter.)

Use the existing `schiefer` block (lines ~356–432) as the structural template for which properties to declare and in what order — the variable SET must match so no fallback gaps appear.

Do NOT touch pflaume, nacht, wald, or schiefer blocks. Do NOT edit any other files in this task. Do NOT modify existing radius/glass/shadow defaults that pflaume sets.
  </action>
  <verify>
    <automated>
      pnpm --filter @clokr/web exec node -e "const fs=require('fs');const c=fs.readFileSync('src/app.css','utf8');const hasBlock=/\[data-theme=\"pro\"\]\s*\{[^}]*--color-brand:\s*#4f46e5/s.test(c);const hasRadius=/\[data-theme=\"pro\"\][\s\S]*?--radius-sm:\s*4px/.test(c);const hasRadiusMd=/\[data-theme=\"pro\"\][\s\S]*?--radius-md:\s*8px/.test(c);const hasNoBlur=/\[data-theme=\"pro\"\][\s\S]*?--glass-blur:\s*0/.test(c);const hasDensity=/html\[data-theme=\"pro\"\]\s*\{\s*font-size:\s*15px/.test(c);if(!hasBlock||!hasRadius||!hasRadiusMd||!hasNoBlur||!hasDensity){console.error('FAIL',{hasBlock,hasRadius,hasRadiusMd,hasNoBlur,hasDensity});process.exit(1)}console.log('OK')"
    </automated>
  </verify>
  <done>
- New `[data-theme="pro"]` block exists in apps/web/src/app.css after schiefer
- Block contains --color-brand: #4f46e5, --radius-sm: 4px, --radius-md: 8px, --glass-blur: 0
- A separate `html[data-theme="pro"] { font-size: 15px; }` rule exists for density
- No existing theme blocks modified
- File parses as valid CSS (svelte dev server starts without CSS errors)
  </done>
</task>

<task type="auto">
  <name>Task 2: Register "pro" in theme store</name>
  <files>apps/web/src/lib/stores/theme.ts</files>
  <action>
Make two minimal edits to apps/web/src/lib/stores/theme.ts:

1. Extend the Theme union type:
     export type Theme = 'pflaume' | 'nacht' | 'wald' | 'schiefer' | 'pro';

2. Append a new entry to the `themes` array (at the end, after `schiefer`):
     { id: 'pro', label: 'Pro', color: '#4f46e5' },

Do NOT change the initial-theme fallback logic (still defaults to 'pflaume' for new users). Do NOT change the subscribe/localStorage wiring.

No other files need editing: the admin theme switcher in apps/web/src/routes/(app)/admin/system/+page.svelte iterates `{#each themes}` so the new option appears automatically. The `(app)/+layout.svelte` does not reference the theme list directly — it only relies on the data-theme attribute set by the store subscription.
  </action>
  <verify>
    <automated>
      pnpm --filter @clokr/web exec node -e "const fs=require('fs');const c=fs.readFileSync('src/lib/stores/theme.ts','utf8');const hasType=/Theme\s*=\s*'pflaume'\s*\|\s*'nacht'\s*\|\s*'wald'\s*\|\s*'schiefer'\s*\|\s*'pro'/.test(c);const hasEntry=/id:\s*'pro'[^}]*label:\s*'Pro'[^}]*color:\s*'#4f46e5'/s.test(c);if(!hasType||!hasEntry){console.error('FAIL',{hasType,hasEntry});process.exit(1)}console.log('OK')" && pnpm --filter @clokr/web exec svelte-check --threshold error --output human 2>&1 | tail -20
    </automated>
  </verify>
  <done>
- Theme union includes 'pro'
- themes array has entry { id: 'pro', label: 'Pro', color: '#4f46e5' }
- svelte-check passes with no new type errors
- Manual test: open http://localhost:5173/admin/system, dropdown shows 5 options including "Pro"
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
Fifth theme "Pro" registered in Clokr:
- New [data-theme="pro"] block in apps/web/src/app.css with indigo #4f46e5 accent, sharper radii (4/8/12px), solid (non-blur) surfaces, cold neutral palette, high-contrast text
- Density tweak via html[data-theme="pro"] { font-size: 15px; }
- 'pro' added to Theme type and themes registry in apps/web/src/lib/stores/theme.ts
- Admin theme switcher auto-shows the new option via its {#each themes} loop
  </what-built>
  <how-to-verify>
Run stack via docker compose (per CLAUDE.md / MEMORY — never `pnpm dev`):

  1. `docker compose up --build -d` (rebuild web container so app.css changes are picked up)
  2. Visit http://localhost:5173/login → sign in as admin
  3. Navigate to Admin → System → Erscheinungsbild
  4. Confirm the Theme dropdown shows FIVE options: Pflaume, Nacht, Wald, Schiefer, Pro
  5. Select "Pro" and visually verify across the app:
     - Sidebar is SOLID white (no blur/transparency), sharp corners on nav items (~4px radius)
     - Active nav item has indigo #4f46e5 left border and tinted background
     - Page background is near-white cool neutral (#fafbfc), text is near-black (#0f172a)
     - Buttons, form inputs, cards, tables use indigo accent and sharp radii
     - Overall feels denser (slightly smaller text/spacing due to 15px root font-size)
  6. Visit Dashboard, Zeiterfassung, Abwesenheiten, Berichte — confirm no element falls back to pflaume colors (no stray plum tints)
  7. Open the notification bell dropdown — confirm solid background (no backdrop blur)
  8. Reload the browser — theme should persist as "Pro" (localStorage)
  9. Switch back to "Pflaume" and confirm the original theme restores correctly (regression check)
  10. Switch through Nacht, Wald, Schiefer to confirm existing themes still work

If any element looks wrong (stray warm tints, broken radii, glass blur bleeding through), list the component/route and approval is blocked until fixed.
  </how-to-verify>
  <resume-signal>Type "approved" or describe visual issues (component + route + what's wrong)</resume-signal>
</task>

</tasks>

<verification>
Overall phase checks:
- `pnpm --filter @clokr/web exec svelte-check` passes with no new errors
- `docker compose up --build -d` builds and starts web container cleanly
- Manual: admin theme dropdown shows 5 entries, "Pro" applies indigo palette + sharp radii + solid surfaces across all major routes
- Manual: existing 4 themes unchanged (regression-free)
- localStorage persists 'pro' selection across reload
</verification>

<success_criteria>
- [ ] apps/web/src/app.css contains `[data-theme="pro"]` block with all required CSS custom properties
- [ ] --color-brand is exactly #4f46e5; --radius-sm is 4px; --radius-md is 8px; --glass-blur is 0
- [ ] `html[data-theme="pro"] { font-size: 15px; }` density rule present
- [ ] apps/web/src/lib/stores/theme.ts Theme union includes 'pro'
- [ ] themes array contains `{ id: 'pro', label: 'Pro', color: '#4f46e5' }`
- [ ] svelte-check has no new type errors
- [ ] Human verified: Pro theme renders correctly across Dashboard, Zeiterfassung, Abwesenheiten, Berichte, Admin
- [ ] Human verified: existing 4 themes still render correctly
- [ ] Human verified: theme selection persists across reload
</success_criteria>

<output>
After completion, create `.planning/quick/260411-clm-add-a-new-pro-theme-inspired-by-datadog-/260411-clm-SUMMARY.md` documenting:
- Files changed (app.css + theme.ts)
- Final Pro theme palette values
- Any deviations from the plan (with rationale)
- Screenshots or notes from human verification
</output>
