# Clokr – Project Rules

## Tech Stack

- **Monorepo**: pnpm workspaces (`apps/api`, `apps/web`, `packages/db`)
- **API**: Fastify + TypeScript, Zod validation, Prisma ORM (PostgreSQL)
- **Web**: SvelteKit + Svelte 5 (runes: `$state`, `$derived`, `$effect`, `$props`)
- **DB**: PostgreSQL 17, Prisma schema at `packages/db/prisma/schema.prisma`
- **Docker**: `docker compose up --build -d` for full stack

## Commands

- `pnpm dev` — start all dev servers
- `pnpm --filter @clokr/api dev` — API only
- `pnpm --filter @clokr/web dev` — Web only
- `pnpm --filter @clokr/db exec prisma db push` — sync schema to DB
- `pnpm --filter @clokr/db exec prisma generate` — regenerate Prisma client
- `docker compose up --build -d` — rebuild and restart all containers

## Path Aliases (SvelteKit)

- `$stores` → `src/lib/stores/`
- `$api` → `src/lib/api/`

## Language

- UI labels and user-facing text: **German**
- Code, comments, commit messages, docs: **English**
- API descriptions (Swagger): English

## ArbZG (Arbeitszeitgesetz) Rules

These rules MUST be followed when implementing or modifying ArbZG compliance checks:

- **§ 3 Daily max: 10h absolute limit** — this is the hard daily cap, never exceeded
- **§ 3 The 8h rule is a 24-week/6-month AVERAGE, NOT a daily limit!**
  - A 4-day week with 39h (= 9.75h/day) is perfectly legal
  - Only warn/error when the 24-week rolling average exceeds 8h per workday
  - Do NOT show warnings for individual days between 8h and 10h
- **§ 3 Weekly max: 48h** — hard weekly cap (Mo-Sa = 6 Werktage)
- **§ 4 Breaks**: >6h work = min 30min break; >9h work = min 45min break
- **§ 5 Rest period**: min 11h between end of work and start of next day
- **§ 8 BUrlG**: No work during approved vacation — time entry creation
  (manual, clock-in, NFC) is BLOCKED when approved leave exists on that day.
  Employee must cancel the leave first before tracking time.

## Schedule Types

- `FIXED_WEEKLY` — fixed weekly hours with per-day allocation (e.g., 40h, Mo-Fr 8h)
- `MONTHLY_HOURS` — monthly hour budget for Minijobber/flexible workers
  - `monthlyHours` is optional — when null/0, pure time tracking without Soll comparison
  - No daily targets, no daily +/- display in calendar
  - Holiday/absence deductions do NOT apply (flexible schedule)

## Svelte 5 Gotchas

- `{@const}` can only be used inside `{#if}`, `{#each}`, `{#snippet}` — NOT inside `<div>`
- Use `$derived` for computed values instead of `{@const}` in templates
- Use `preventDefault` from `svelte/legacy` for form handlers

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.
