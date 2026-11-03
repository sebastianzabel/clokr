// Typed client for the person's own shift reminder settings (Issue #609, D-02). Both calls hit
// `/employees/me/reminders`: the GET answers which occasions the tenant enabled together with the
// caller's own opt-outs, the PATCH changes only the opt-outs it names. A caller without an
// employee profile gets a 400 (an ApiError), never a 401.
import { api } from "$api/client";

// ── Types ─────────────────────────────────────────────────────────────────────

/** What the tenant switched on (admin, /admin/vacation) - read-only for the person. */
export interface TenantReminderSettings {
  shiftStartEnabled: boolean;
  shiftEndEnabled: boolean;
  dayCloseEnabled: boolean;
  /** Minutes after shift start / end (5-120). */
  offsetMinutes: number;
  /** Evening reminder time as HH:MM in the tenant time zone. */
  dayCloseTime: string;
}

/** The person's own opt-outs: true = this person does not want that reminder. */
export interface MyReminderOptOuts {
  shiftStartOff: boolean;
  shiftEndOff: boolean;
  dayCloseOff: boolean;
}

export interface MyReminders {
  tenant: TenantReminderSettings;
  own: MyReminderOptOuts;
}

// ── API helpers ───────────────────────────────────────────────────────────────

export function getMyReminders(): Promise<MyReminders> {
  return api.get<MyReminders>("/employees/me/reminders");
}

/** Sends only the named opt-outs; the answer is the same shape as the GET. */
export function updateMyReminders(patch: Partial<MyReminderOptOuts>): Promise<MyReminders> {
  return api.patch<MyReminders>("/employees/me/reminders", patch);
}
