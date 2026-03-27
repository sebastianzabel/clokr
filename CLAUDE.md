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

## Audit-Proof / Revisionssicherheit

Clokr MUST be audit-proof (revisionssicher). All data relevant to working time, leave, and payroll must be tamper-proof and traceable:

- **No hard deletes** of time entries, leave requests, or employee records — use soft delete (`deletedAt`) or status changes instead
- **Soft delete queries**: ALL queries on soft-deletable models (TimeEntry, LeaveRequest, Absence) MUST include `deletedAt: null` in the where clause
- **Audit trail**: Every create, update, and delete must be logged with userId, timestamp, IP, and before/after values (via `app.audit()`)
- **Immutability after lock**: Once a month is closed (`isLocked`), entries MUST NOT be editable or deletable — not even by admins. Always check `isLocked` before UPDATE/DELETE.
- **No silent overwrites**: Any correction to a locked/finalized entry must create a new correction entry with reference to the original, not modify it in place
- **Traceability**: It must always be possible to reconstruct who changed what, when, and why
- **CASCADE = Restrict**: Critical relations (Employee→TimeEntry/LeaveRequest/Absence) use `onDelete: Restrict` to prevent silent cascade deletion

These rules apply to ALL code changes touching time entries, leave, overtime, and employee data. When in doubt, prefer creating an audit log entry over skipping it.

### DSGVO Employee Deletion = Anonymization

When an employee is "deleted" (DSGVO Art. 17), the system **anonymizes** instead of hard-deleting:

- **Employee**: firstName → "Gelöscht", lastName/employeeNumber → "GELÖSCHT-XXX", nfcCardId → null
- **User**: email → anonymized, passwordHash → "ANONYMIZED", isActive → false
- **Notes**: All notes in TimeEntries, LeaveRequests, Absences are set to null
- **Documents**: Absence documentPath → null
- **Auth tokens**: Invitations, OTP, RefreshTokens are hard-deleted (not retention-relevant)
- **Preserved**: TimeEntries, LeaveRequests, Absences, Schedules, OvertimeAccount (for retention compliance)
- **AuditLog**: userId → null (anonymized, not deleted)

## Data Retention (Aufbewahrungsfristen)

Legal retention periods (Germany):

| Basis                             | Retention                              | Reference            |
| --------------------------------- | -------------------------------------- | -------------------- |
| Arbeitszeitnachweis               | 2 years                                | § 16 Abs. 2 ArbZG    |
| Lohnkonten                        | 6 years                                | § 41 EStG            |
| Buchungsbelege (payroll-relevant) | 10 years                               | § 147 AO / § 257 HGB |
| DSGVO                             | Delete after longest retention expires | Art. 17 DSGVO        |

**Default retention: 10 years** (configurable per tenant, minimum 2 years). Retention period starts at end of calendar year of record creation. Deletion is NOT rolling — it happens annually (Stichtag), e.g., on Jan 1st for records whose retention expired on Dec 31st.

## Saldo Calculation & Monatsabschluss (planned)

**Current state**: Saldo is recalculated from hire date on every request. This does not scale.

**Target architecture** (see issue #6):

- **Monatsabschluss**: Monthly `SaldoSnapshot` freezes worked/expected/balance/carryOver per employee
- **Current saldo** = last snapshot `carryOver` + entries since snapshot date
- **Jahresübertrag**: Yearly snapshot at Dec 31st, configurable carry-over rules (FULL / CAPPED / RESET)
- **Archival**: After retention period, old entries can be soft-deleted/archived because snapshots preserve saldo integrity
- Corrections to closed months: unlock → correct → re-close (new snapshot with audit trail)

## Time Entry Rules

- **One entry per day** per employee (multiple breaks allowed within that entry)
- Break model: `Break[]` records with startTime/endTime (legacy: `breakMinutes` integer)
- `openAdd()` on frontend redirects to edit if entry already exists for that day
- API POST rejects with 409 if entry already exists for employee+date

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
- **§ 8 BUrlG**: Leave and time tracking interaction rules:
  - **APPROVED leave**: Time entry creation is BLOCKED. Employee must request cancellation first.
  - **CANCELLATION_REQUESTED leave**: Time entries ARE allowed but created as `isInvalid: true`
    with reason "Urlaubsstornierung ausstehend". These entries don't count in saldo.
  - **When cancellation is approved** (→ CANCELLED): Invalid entries are automatically revalidated.
  - **When cancellation is rejected**: Entries stay invalid (manager can manually handle).
  - Cancellation always requires approval by a DIFFERENT manager (self-approval blocked).
  - Leave remains active (shown in calendar, counts for saldo) until cancellation is approved.

## Leave Cancellation Flow

1. Employee/Manager requests cancellation → status = `CANCELLATION_REQUESTED`
2. Leave remains active: shown in calendar (special styling), blocks regular time tracking
3. Time entries during this period: allowed but marked `isInvalid` (needs cancellation approval first)
4. Another manager approves cancellation → status = `CANCELLED`, time entries auto-revalidated
5. If cancellation rejected → status reverts to `APPROVED`, time entries stay invalid

## Overtime Saldo Calculation (current)

- **Saldo = Worked hours − Expected hours** (both calculated for the same date range)
- **Date range**: From hire date (or month start) up to today (if entries exist) or yesterday
- Leave, holidays, and absences within this range reduce expected hours
- Leave/holidays are clamped to the effective range (no over-deduction from pre-hire leave)
- Saldo recalculates on every GET /overtime/:employeeId request
- **Note**: This will be replaced by snapshot-based calculation (see "Saldo Calculation & Monatsabschluss" above)

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
