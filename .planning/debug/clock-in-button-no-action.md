---
status: resolved
trigger: "Der 'Einstempeln' Button zeigt kurzes visuelles Feedback (Button-Animation), aber speichert nichts und wechselt nicht zur Timer-Ansicht. Problem tritt auf Mobile UND Desktop auf."
created: 2026-04-09T00:00:00Z
updated: 2026-04-09T00:00:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED (second root cause) — loadData() uses Promise.all for clock-state + stats; if GET /dashboard throws (e.g. undefined employeeId), the whole loadData fails silently, leaving clockedIn=false even when user is actually clocked in
test: Implementing (1) Promise.allSettled so clock state loads independently of stats, (2) catch block on loadData to surface errors, (3) guard in dashboard.ts API route for undefined employeeId
expecting: Dashboard correctly shows clock state even when stats fail; no silent failures
next_action: Apply fix to dashboard/+page.svelte (loadData) and apps/api/src/routes/dashboard.ts

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Clock-in Button speichert aktuelle Zeit als Arbeitsbeginn, UI wechselt zum laufenden Timer
actual: Kurzes Button-Feedback (Ripple/Animation) sichtbar, danach passiert nichts — kein Laden, kein Fehler, keine UI-Änderung
errors: Nicht geprüft (Konsole nicht geöffnet)
reproduction: Einstempel-Button auf der Hauptseite/Dashboard drücken (Mobile und Desktop betroffen)
started: Unbekannt

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: Route ordering issue — POST /:id/clock-out matches /clock-in
  evidence: Fastify always prefers static routes over parametric; /clock-in is static and registered first
  timestamp: 2026-04-09T01:00:00Z

- hypothesis: Stale Docker image missing the /clock-in route
  evidence: git log shows clock-in route existed since commit 9b9f26e (March 2026), well before any recent prod build
  timestamp: 2026-04-09T01:00:00Z

- hypothesis: Invalid source enum MOBILE causing Zod parse failure
  evidence: TimeEntrySource enum includes MOBILE; clockInSchema validates it correctly
  timestamp: 2026-04-09T01:00:00Z

- hypothesis: GET /time-entries date filter misses open entry due to timezone
  evidence: Both todayInTz() and new Date("yyyy-MM-dd") produce midnight UTC; PostgreSQL DATE comparison works correctly
  timestamp: 2026-04-09T01:00:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-04-09T00:00:00Z
  checked: knowledge-base.md
  found: No direct keyword match for this bug pattern.
  implication: Fresh investigation needed

- timestamp: 2026-04-09T00:01:00Z
  checked: dashboard +page.svelte handleClock function (line 558-579)
  found: handleClock() has try/finally but NO catch block. Any error from api.post() or loadData() causes: (1) finally runs clockLoading=false, (2) error re-thrown as unhandled promise rejection, (3) UI resets silently. The "animation" users see is CSS :active{ transform: translateY(1px) } on .btn — fires on every click regardless of handler outcome.
  implication: This is the direct cause of "button feedback, nothing happens"

- timestamp: 2026-04-09T00:02:00Z
  checked: CSS .btn:active rule in app.css (line 522-524)
  found: .btn:active:not(:disabled) { transform: translateY(1px) } — this is the "ripple/animation" reported. Confirms handler IS being called (function runs, clockLoading set, but error swallowed before UI updates).
  implication: The reported "animation" is CSS-only, confirms handler executes but fails silently

- timestamp: 2026-04-09T00:03:00Z
  checked: handleClock() clock-in API path + API clock-in endpoint
  found: API can return 400 (no employeeId), 403 (deactivated), 409 (already clocked in OR approved leave today). Any of these becomes ApiError thrown in api.post() → swallowed by missing catch. The dashboard page does NOT import toasts, so no error feedback exists.
  implication: The fix is: add catch block that calls toasts.error() + import toasts store

- timestamp: 2026-04-09T00:04:00Z
  checked: svelte-check output
  found: TypeScript ERROR at line 618: "Property 'overtime' does not exist on type 'never'" — stats?.overtime.balanceHours. stats is DashboardStats|null but $derived infers 'never'. This is a TS-only issue, does not affect runtime.
  implication: Secondary bug — should fix but not the cause of the button issue

- timestamp: 2026-04-09T00:05:00Z
  checked: activeEntryId declaration (line 90)
  found: let activeEntryId: string | null = null — NOT $state. This means Svelte 5 won't track this for reactivity. However it's only used inside handleClock (not in template), so clock-in path is unaffected. Clock-out path reads it correctly from memory.
  implication: Minor: could cause stale clock-out if page state gets out of sync, but not the primary bug

- timestamp: 2026-04-09T01:00:00Z
  checked: dashboard.ts GET / handler — line 20
  found: const employeeId = req.user.employeeId! — TypeScript non-null assertion is a lie. At runtime, employeeId can be undefined (e.g. admin users, API-key users, or users whose JWT was issued before employee record was linked). Downstream: overtimeAccount.findUnique({ where: { employeeId: undefined } }) throws Prisma validation error "Argument employeeId is missing". This makes GET /dashboard return 500, which causes Promise.all in loadData to reject, leaving clockedIn=false even if user is actually clocked in.
  implication: Direct cause of "dashboard shows wrong clock state". Fix: guard for !employeeId at top of handler, return empty stats.

- timestamp: 2026-04-09T01:01:00Z
  checked: loadData() in dashboard/+page.svelte — Promise.all usage
  found: Promise.all is used for GET /time-entries + GET /dashboard. If either throws, the whole loadData fails (caught by finally{loading=false} only). The clock state (clockedIn, activeEntryId) is set AFTER the awaited Promise.all. So any failure in /dashboard prevents clock state from being set.
  implication: The "dashboard shows Einstempeln when already clocked in" symptom is this. Fix: use Promise.allSettled so each call is independent, and clock state is set from time-entries result regardless of stats failure.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: THREE compounding bugs: (1) handleClock() had try/finally but no catch — any API error was silently swallowed, UI reset with no feedback. (2) loadData() uses Promise.all for clock-state + stats; if GET /dashboard throws (e.g. employeeId undefined in JWT payload, Prisma validation error), the entire loadData fails silently in finally{loading=false}, leaving clockedIn=false even when user is actually clocked in via NFC. (3) autoInvalidateOpenEntries() marks stale open entries as isInvalid: true but leaves endTime: null. The clock-in conflict check queried { endTime: null, deletedAt: null } without filtering by isInvalid, so it found old invalid entries and returned 409 "Bereits eingestempelt" — permanently blocking future clock-ins.
fix: (1) toasts import + catch block in handleClock() [done]; (2) activeEntryId changed to $state [done]; (3) TS fix for stats?.overtime [done]; (4) loadData refactored to use Promise.allSettled so clock state loads independently of stats; (5) catch block added to loadData to show a toast if critical data fails; (6) dashboard.ts API guard: early return 204/empty stats when req.user.employeeId is undefined instead of crashing Prisma; (7) Additional fix: clock-in conflict check (POST /clock-in and NFC punch) now filters by isInvalid: false to ignore auto-invalidated stale entries that previously caused permanent 409 blocks.
verification: resolved
files_changed: [apps/web/src/routes/(app)/dashboard/+page.svelte, apps/api/src/routes/dashboard.ts, apps/api/src/routes/time-entries.ts]
