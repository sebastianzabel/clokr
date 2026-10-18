/**
 * Issue #612 (ADD-1) - the typed answer of `GET /dashboard/today-attendance`, as the tab „Heute“
 * renders it. Display fields only: the status is the API's decision (`resolveDayStatus`), nothing is
 * derived in the web.
 */

export type TodayEmployee = {
  id: string;
  name: string;
  employeeNumber: string;
  status:
    | "present"
    | "absent"
    | "clocked_in"
    | "missing"
    | "scheduled"
    | "requested"
    | "none"
    | "holiday";
  reason: string | null;
  // Issue #542 (AC-542-7): set by the server under a salon filter when the person worked in
  // another salon today; a boolean, never a salon or a time.
  workedElsewhere?: boolean;
  // Issue #587 (D-587-3): the planned start of today's first shift and the minutes since it
  // (only for a missing row); finished values from the API, nothing is computed here.
  expectedStart?: string | null;
  lateMinutes?: number | null;
};

export type TodayAttendanceData = {
  date: string;
  // Issue #542: present only under a salon filter.
  salonId?: string;
  employees: TodayEmployee[];
  summary: {
    present: number;
    absent: number;
    clockedIn: number;
    missing: number;
    holiday: number;
  };
};
