---
quick_id: 260411-ctn
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/db/prisma/schema.prisma
  - apps/api/src/plugins/notify.ts
  - apps/api/src/routes/notifications.ts
  - apps/api/src/routes/leave.ts
  - apps/api/src/plugins/attendance-checker.ts
  - apps/api/src/__tests__/notifications.test.ts
  - apps/web/src/routes/(app)/+layout.svelte
autonomous: true
requirements:
  - NOTIF-DISMISS-01
  - NOTIF-DISMISS-02
must_haves:
  truths:
    - "User sees an X button on each notification in the dropdown"
    - "Clicking the X soft-dismisses the notification: it disappears from the list and unread count updates"
    - "Dismissed notifications never reappear on reload"
    - "When a LEAVE_REQUEST notification's underlying request is approved or rejected, the LEAVE_REQUEST notification on the manager's list is auto-dismissed"
    - "When a CLOCK_OUT_REMINDER notification's underlying open time entry is closed (clock-out), that reminder is auto-dismissed"
    - "Audit-proof: dismissal is a soft update (dismissedAt), not a hard delete"
  artifacts:
    - path: "packages/db/prisma/schema.prisma"
      provides: "Notification.dismissedAt, relatedType, relatedId columns + index"
      contains: "dismissedAt"
    - path: "apps/api/src/routes/notifications.ts"
      provides: "DELETE /notifications/:id endpoint that soft-dismisses"
      exports: ["notificationRoutes"]
    - path: "apps/api/src/plugins/notify.ts"
      provides: "notify() accepts and persists relatedType/relatedId; dismissByRelated() helper"
    - path: "apps/web/src/routes/(app)/+layout.svelte"
      provides: "X dismiss button per notification item, optimistic UI, shared between sidebar + mobile header"
  key_links:
    - from: "apps/web/src/routes/(app)/+layout.svelte"
      to: "DELETE /api/v1/notifications/:id"
      via: "api.delete() in dismissNotification handler"
      pattern: "api\\.delete.*notifications"
    - from: "apps/api/src/routes/leave.ts (review handler)"
      to: "app.dismissByRelated('LeaveRequest', id)"
      via: "called after status transition to APPROVED/REJECTED/CANCELLED"
      pattern: "dismissByRelated.*LeaveRequest"
    - from: "apps/api/src/routes/notifications.ts (GET /)"
      to: "Notification query"
      via: "where filter includes dismissedAt: null"
      pattern: "dismissedAt: null"
---

<objective>
Add user-dismissible notifications with an X button on each item in the notification dropdown, plus automatic dismissal when the underlying action is resolved (leave request approved/rejected/cancelled, open clock-out closed). Dismissal is soft (dismissedAt timestamp) to preserve Revisionssicherheit — dismissed notifications are filtered from GET queries but rows remain in the database.

Purpose: Users currently have no way to clear stale notifications except "mark all read". Actionable notifications (leave requests, clock-out reminders) stay in the list even after the underlying action is resolved, causing notification clutter and confusion. This change lets users clean up manually and ensures resolved-action notifications disappear on their own.

Output: Schema migration + API changes + UI changes so every notification can be dismissed with one click and relevant notifications auto-dismiss when their action completes.
</objective>

<execution_context>
@/Users/sebastianzabel/git/clokr/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastianzabel/git/clokr/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@apps/api/src/routes/notifications.ts
@apps/api/src/plugins/notify.ts
@apps/web/src/routes/(app)/+layout.svelte
@apps/api/src/routes/leave.ts
@apps/api/src/plugins/attendance-checker.ts
@apps/api/src/__tests__/notifications.test.ts

<interfaces>
<!-- Current Notification model (packages/db/prisma/schema.prisma, ~line 698) -->
```prisma
model Notification {
  id         String   @id @default(uuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  type       String   // LEAVE_REQUEST, LEAVE_APPROVED, LEAVE_REJECTED, OVERTIME_WARNING, MISSING_ENTRY, CLOCK_OUT_REMINDER, MONTH_CLOSED, ACCOUNT_LOCKED
  title      String
  message    String
  link       String?
  read       Boolean  @default(false)
  createdAt  DateTime @default(now()) @db.Timestamptz

  @@index([userId, read])
  @@index([userId, createdAt])
  @@index([createdAt])
}
```

<!-- Existing notify plugin signature (apps/api/src/plugins/notify.ts) -->
```ts
interface NotifyParams {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  tenantId?: string;
}
// Decorated as app.notify(params): Promise<void>
```

<!-- Existing API client method (apps/web/src/lib/api/client.ts) -->
```ts
api.delete<T>(path: string): Promise<T>;
```

<!-- Existing UI state in +layout.svelte -->
```ts
let notifications: Notification[] = $state([]);
let unreadCount = $state(0);
// markRead(id), markAllRead(), handleNotificationClick(n) already exist
// Dropdown is rendered twice: sidebar (.notification-dropdown) and mobile header (.notification-dropdown--mobile)
```

<!-- Existing leave review handler call sites that need auto-dismiss wiring -->
```ts
// apps/api/src/routes/leave.ts:
// - ~line 509:  existing.status transitions PENDING → APPROVED  (regular approval)
// - ~line 512:  CANCELLATION_REQUESTED → CANCELLED             (cancellation approved)
// - ~line 585:  CANCELLATION_REQUESTED → APPROVED              (cancellation rejected → reverts)
// - ~line 640:  PENDING → REJECTED                              (regular rejection)
// Each of these resolves the original LEAVE_REQUEST notification sent to managers.

// apps/api/src/plugins/attendance-checker.ts:
// - ~line 68:   CLOCK_OUT_REMINDER sent with link=/time-entries?highlight=<entryId>
// When the user closes the open entry, the reminder should auto-dismiss.
// Clock-out path: PATCH /api/v1/time-entries/:id (where endTime transitions from null → set)
// See apps/api/src/routes/time-entries.ts for the handler.
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add soft-dismiss schema + notify plugin + API endpoint</name>
  <files>
    packages/db/prisma/schema.prisma,
    apps/api/src/plugins/notify.ts,
    apps/api/src/routes/notifications.ts
  </files>
  <action>
1. **Schema** — in `packages/db/prisma/schema.prisma`, extend `model Notification` with three new nullable columns and one additional index:
   - `dismissedAt DateTime? @db.Timestamptz`  — null = visible, set = dismissed (soft, preserves audit trail per Revisionssicherheit rules)
   - `relatedType String?`  — e.g. `"LeaveRequest"`, `"TimeEntry"`. Used by auto-dismiss lookup.
   - `relatedId   String?`  — FK-shaped id of the related entity; NOT a real FK so we can reference any table without cascade coupling
   - Add `@@index([userId, dismissedAt])` and `@@index([relatedType, relatedId])`
   - Do NOT drop or rename any existing field. Do NOT alter `read` semantics.
   - Apply with `pnpm --filter @clokr/db exec prisma db push` and regenerate with `pnpm --filter @clokr/db exec prisma generate`.

2. **notify plugin** — in `apps/api/src/plugins/notify.ts`:
   - Extend `NotifyParams` with optional `relatedType?: string` and `relatedId?: string`.
   - In the `prisma.notification.create` call, pass `relatedType` and `relatedId` through.
   - Add a new decorator `app.dismissByRelated(relatedType: string, relatedId: string): Promise<number>` that runs:
     ```ts
     const { count } = await app.prisma.notification.updateMany({
       where: { relatedType, relatedId, dismissedAt: null },
       data: { dismissedAt: new Date() },
     });
     return count;
     ```
   - Declare both in the `declare module "fastify"` block:
     ```ts
     interface FastifyInstance {
       notify: (params: NotifyParams) => Promise<void>;
       dismissByRelated: (relatedType: string, relatedId: string) => Promise<number>;
     }
     ```

3. **Notifications route** — in `apps/api/src/routes/notifications.ts`:
   - Update the existing `GET /` handler so both `findMany` and `count` filter with `dismissedAt: null` in the where clause (dismissed items must not reappear).
   - Add a new handler `DELETE /:id` that soft-dismisses:
     ```ts
     app.delete("/:id", {
       schema: { tags: ["Benachrichtigungen"], security: [{ bearerAuth: [] }] },
       handler: async (req, reply) => {
         const { id } = req.params as { id: string };
         const result = await app.prisma.notification.updateMany({
           where: { id, userId: req.user.sub, dismissedAt: null },
           data: { dismissedAt: new Date() },
         });
         if (result.count === 0) return reply.code(404).send({ error: "Benachrichtigung nicht gefunden" });
         return { success: true };
       },
     });
     ```
   - Also add `DELETE /dismiss-all` that soft-dismisses all of the current user's non-dismissed notifications (used for "clear all" in future; the UI change in Task 3 only wires per-item dismiss but the endpoint pairs naturally with the existing `read-all` endpoint). Response: `{ success: true, count }`.
   - Ensure `updateMany` always scopes by `userId: req.user.sub` to prevent cross-user dismissal (tenant-isolation invariant).

4. **Do NOT** hard-delete any row. Do NOT add `onDelete: Cascade` relationship from Notification → any entity (relatedId is a loose reference by design so we can point at LeaveRequest, TimeEntry, etc. without schema coupling).

5. **Do NOT** update call sites that currently use `app.notify()` to start passing `relatedType/relatedId` in this task — that happens in Task 2 for the specific sites we want to auto-dismiss.
  </action>
  <verify>
    <automated>pnpm --filter @clokr/api exec vitest run src/__tests__/notifications.test.ts</automated>
  </verify>
  <done>
    - Prisma schema has `dismissedAt`, `relatedType`, `relatedId` + two new indexes
    - `pnpm --filter @clokr/db exec prisma db push` succeeds
    - `app.notify()` accepts `relatedType`/`relatedId` and persists them
    - `app.dismissByRelated(type, id)` returns count of dismissed rows
    - `GET /api/v1/notifications` filters out `dismissedAt != null` rows
    - `DELETE /api/v1/notifications/:id` returns 200 + soft-dismisses a user's own notification
    - `DELETE /api/v1/notifications/:id` returns 404 for a non-existent or already-dismissed id
    - `DELETE /api/v1/notifications/:id` does NOT dismiss another user's notification (returns 404)
    - Existing notification tests still pass
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire auto-dismiss into leave review + clock-out + extend API tests</name>
  <files>
    apps/api/src/routes/leave.ts,
    apps/api/src/plugins/attendance-checker.ts,
    apps/api/src/routes/time-entries.ts,
    apps/api/src/__tests__/notifications.test.ts
  </files>
  <action>
1. **Stamp LEAVE_REQUEST notifications with the request id at creation time** — in `apps/api/src/routes/leave.ts`, find the manager-notify loop in the POST `/requests` handler (around line 355). Add `relatedType: "LeaveRequest"` and `relatedId: request.id` to the `app.notify({...})` call so the notification carries the link we can match against later.

2. **Auto-dismiss on leave review** — in the same file, find the PATCH review handler (around line 480). After each successful status transition that resolves the pending review, call:
   ```ts
   await app.dismissByRelated("LeaveRequest", existing.id);
   ```
   The call must fire in ALL four transition branches:
   - `PENDING → APPROVED` (regular approval, ~line 640 / around `body.status === "APPROVED"` for non-cancellation path)
   - `PENDING → REJECTED` (regular rejection, same block `body.status !== "APPROVED"` path)
   - `CANCELLATION_REQUESTED → CANCELLED` (cancellation approved, ~line 507)
   - `CANCELLATION_REQUESTED → APPROVED` (cancellation rejected reverts to APPROVED, ~line 581/585)
   Place the dismiss call AFTER the prisma update but BEFORE the `reply.send`. It must not throw; wrap in `try { ... } catch (err) { app.log.warn(...) }` so a dismiss failure never blocks the review action.

3. **Stamp CLOCK_OUT_REMINDER with entry id** — in `apps/api/src/plugins/attendance-checker.ts`, find the `app.notify({ type: "CLOCK_OUT_REMINDER", ... })` call (around line 68). Add `relatedType: "TimeEntry"` and `relatedId: entry.id`.

4. **Auto-dismiss on clock-out** — in `apps/api/src/routes/time-entries.ts`, find the handler that transitions an entry from open (endTime null) to closed (endTime set). This is the PATCH `/:id` (or the dedicated `/clock-out` endpoint — use whichever mutates endTime from null → Date). After the successful Prisma update, call:
   ```ts
   await app.dismissByRelated("TimeEntry", entry.id);
   ```
   Wrap in try/catch with `app.log.warn` on failure so the clock-out itself never fails due to dismiss logic.
   - If the handler currently has no such "open → closed" detection, detect it by comparing the pre-update state: `if (before.endTime === null && after.endTime !== null) dismiss...`.
   - Skip this step ONLY if the codebase has no clock-out-style handler; in that case add a `// TODO` comment and log a warning (should not happen — verify first).

5. **Extend tests** — in `apps/api/src/__tests__/notifications.test.ts`:
   - Add `describe("DELETE /api/v1/notifications/:id")` with tests for:
     - Dismissing own notification returns 200 and removes it from GET response
     - Dismissing another user's notification returns 404 (cross-user protection)
     - Dismissing a non-existent id returns 404
     - Dismissing an already-dismissed id returns 404
   - Add `describe("Auto-dismiss on leave review")` verifying that after a manager approves a leave request, the manager's `LEAVE_REQUEST` notification for that `request.id` no longer appears in GET `/notifications` (use `data.adminToken` as the manager).
   - Use `app.inject` consistently with existing test style.

6. **Do NOT** mark notifications as `read` when auto-dismissing — dismiss and read are independent states. Dismissed implies "hidden from list"; read implies "user has seen it". A dismissed notification still counts toward historical audit logs.
  </action>
  <verify>
    <automated>pnpm --filter @clokr/api exec vitest run src/__tests__/notifications.test.ts src/__tests__/leave.test.ts</automated>
  </verify>
  <done>
    - `LEAVE_REQUEST` notifications are created with `relatedType="LeaveRequest"` and `relatedId=<request.id>`
    - Approving, rejecting, cancelling, or reverting a leave request auto-dismisses the corresponding manager LEAVE_REQUEST notifications
    - `CLOCK_OUT_REMINDER` notifications are created with `relatedType="TimeEntry"` and `relatedId=<entry.id>`
    - Closing an open time entry auto-dismisses any CLOCK_OUT_REMINDER for that entry
    - Dismiss failures are logged (`app.log.warn`) but never block the underlying business action
    - New test cases pass and existing tests still pass
  </done>
</task>

<task type="auto">
  <name>Task 3: UI X button per notification + optimistic dismiss (sidebar + mobile)</name>
  <files>
    apps/web/src/routes/(app)/+layout.svelte
  </files>
  <action>
1. **Add dismiss handler** — in the `<script>` block of `apps/web/src/routes/(app)/+layout.svelte`, next to `markRead` / `markAllRead`, add:
   ```ts
   async function dismissNotification(id: string, wasUnread: boolean) {
     // Optimistic: remove locally first, roll back on error
     const snapshot = notifications;
     const snapshotCount = unreadCount;
     notifications = notifications.filter((n) => n.id !== id);
     if (wasUnread) unreadCount = Math.max(0, unreadCount - 1);
     try {
       await api.delete(`/notifications/${id}`);
     } catch (err) {
       console.error("Failed to dismiss notification:", err);
       notifications = snapshot;
       unreadCount = snapshotCount;
     }
   }
   ```

2. **Restructure notification item markup** — nesting a `<button>` inside another `<button>` is invalid HTML. The current item IS a button. Convert it to a `<div class="notification-item" role="button" tabindex="0">` with keyboard handling, OR — cleaner — keep the item as a button and add the X as a sibling absolutely-positioned button in the same `.notification-item-wrapper` container. Use the wrapper approach:
   - Replace the existing `<button class="notification-item" ...>` block (inside `{#each notifications as n (n.id)}`) with a wrapper:
     ```svelte
     <div class="notification-item-wrapper" class:notification-item-wrapper--unread={!n.read}>
       <button
         type="button"
         class="notification-item"
         onclick={() => handleNotificationClick(n)}
       >
         <div class="notification-item-title">{n.title}</div>
         <div class="notification-item-message">{n.message}</div>
         <div class="notification-item-time">{formatTimeAgo(n.createdAt)}</div>
       </button>
       <button
         type="button"
         class="notification-dismiss"
         aria-label="Benachrichtigung schließen"
         onclick={(e) => {
           e.stopPropagation();
           dismissNotification(n.id, !n.read);
         }}
       >
         <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <line x1="18" y1="6" x2="6" y2="18" />
           <line x1="6" y1="6" x2="18" y2="18" />
         </svg>
       </button>
     </div>
     ```
   - Move the `.notification-item--unread` background styling to `.notification-item-wrapper--unread` so the highlight covers the whole row including the dismiss button gutter.
   - The existing `.notification-arrow` hover indicator should remain as-is inside the main button (do not remove it).

3. **Duplicate in both dropdown instances** — this markup is repeated in TWO places: the sidebar dropdown (`.notification-dropdown`, ~line 265) AND the mobile header dropdown (`.notification-dropdown--mobile`, ~line 412). Apply the same change to BOTH blocks so mobile gets the X button too. The mobile block currently lacks the `.notification-arrow`; that's fine — only add the `.notification-dismiss` button there.

4. **Styles** — in the `<style>` block, add:
   ```css
   .notification-item-wrapper {
     position: relative;
     display: flex;
     align-items: stretch;
     border-bottom: 1px solid var(--color-border-subtle);
     transition: background-color 0.12s;
   }
   .notification-item-wrapper:hover {
     background-color: var(--color-bg-subtle);
   }
   .notification-item-wrapper--unread {
     background-color: var(--color-brand-tint, rgba(59, 130, 246, 0.05));
   }
   .notification-item-wrapper--unread:hover {
     background-color: var(--color-brand-tint, rgba(59, 130, 246, 0.1));
   }

   /* The inner button no longer needs its own border-bottom / hover bg */
   .notification-item {
     flex: 1;
     display: block;
     text-align: left;
     background: none;
     border: none;
     border-bottom: none;
     padding: 0.75rem 2.5rem 0.75rem 1rem;
     cursor: pointer;
     position: relative;
   }

   .notification-dismiss {
     flex-shrink: 0;
     display: flex;
     align-items: center;
     justify-content: center;
     width: 2rem;
     background: none;
     border: none;
     color: var(--color-text-muted);
     cursor: pointer;
     opacity: 0;
     transition: opacity 0.15s, color 0.12s;
   }
   .notification-item-wrapper:hover .notification-dismiss,
   .notification-dismiss:focus-visible {
     opacity: 0.8;
   }
   .notification-dismiss:hover {
     color: var(--color-text);
     opacity: 1;
   }
   ```
   - Remove the now-redundant `.notification-item` hover and `--unread` background rules (they're now on the wrapper) while keeping title/message/time/arrow styles intact.
   - Use ONLY CSS custom properties — NO hardcoded hex colors (per CLAUDE.md UI Consistency Rules).

5. **Svelte 5 compliance** — use the official Svelte MCP server (`list-sections` then `get-documentation` for Svelte 5 event handlers + `{#each}` + `svelte-autofixer`) to verify the modified component. Run `svelte-autofixer` on the final component until it reports no issues. The component uses runes already (`$state`, `$props`, `$effect`); keep that style.

6. **Accessibility**:
   - Dismiss button MUST have `aria-label="Benachrichtigung schließen"` (German UI).
   - Dismiss button MUST use `e.stopPropagation()` so clicking X does NOT also fire the parent item's navigation handler.
   - Keep `Escape` closing the dropdown (already implemented in `svelte:window`).

7. **Do NOT** remove or change `markAllRead`, `handleNotificationClick`, or the polling interval. Do NOT change the REST endpoints for read/read-all. Do NOT add a "Clear all" button in this task — the `DELETE /dismiss-all` endpoint exists for a future task.
  </action>
  <verify>
    <automated>pnpm --filter @clokr/web exec svelte-check --fail-on-warnings --tsconfig ./tsconfig.json</automated>
  </verify>
  <done>
    - Each notification in the dropdown has a visible X button on hover (and always visible on mobile / keyboard focus)
    - Clicking X dismisses the notification from the list immediately (optimistic) and calls `DELETE /api/v1/notifications/:id`
    - Clicking X does NOT navigate to the notification's link (stopPropagation works)
    - Unread count decreases correctly when an unread notification is dismissed
    - Dismissed notifications do not reappear on reload or on the next 60s poll
    - Both the sidebar dropdown and the mobile header dropdown show the X button
    - No hardcoded hex colors added; all colors use CSS custom properties
    - `svelte-check` passes with zero errors/warnings
    - `svelte-autofixer` reports no issues on the modified file
    - Keyboard: Tab reaches the X button, Enter/Space activates it
  </done>
</task>

</tasks>

<verification>
After all three tasks complete:

1. Run full API tests: `pnpm --filter @clokr/api test`
2. Run svelte-check on web: `pnpm --filter @clokr/web exec svelte-check --fail-on-warnings`
3. Manual smoke test in Docker dev stack (`docker compose up --build -d`):
   - Log in as admin, create a leave request as an employee, verify the admin sees a `LEAVE_REQUEST` notification with an X button
   - Click the X → notification disappears immediately; reload page → still gone
   - Create another leave request, approve it from admin → the manager's LEAVE_REQUEST notification auto-disappears (verify by checking the admin's notification list)
   - Verify theme: X button color responds to theme switching (pflaume / nacht / wald / schiefer / pro)
   - Verify mobile (<=768px): X button works in the mobile header dropdown
</verification>

<success_criteria>
- [ ] Schema extended with `dismissedAt`, `relatedType`, `relatedId` + indexes (soft-dismiss, audit-proof)
- [ ] `app.notify()` persists relatedType/relatedId; `app.dismissByRelated()` helper exists
- [ ] `DELETE /api/v1/notifications/:id` soft-dismisses; `GET /notifications` filters dismissed
- [ ] Leave review handler auto-dismisses `LEAVE_REQUEST` notifications on approve/reject/cancel/revert
- [ ] Clock-out handler auto-dismisses `CLOCK_OUT_REMINDER` notifications
- [ ] UI: X button per notification item in BOTH sidebar and mobile dropdown, themed, accessible, keyboard-reachable
- [ ] Optimistic dismiss with rollback on error
- [ ] All notification tests pass + new DELETE + auto-dismiss tests pass
- [ ] `svelte-check` passes with zero warnings
- [ ] No hardcoded colors added
- [ ] Soft-dismiss only — no hard deletes of Notification rows (Revisionssicherheit)
</success_criteria>

<output>
After completion, create `.planning/quick/260411-ctn-add-notification-dismissal-x-button-per-/260411-ctn-SUMMARY.md`
</output>
