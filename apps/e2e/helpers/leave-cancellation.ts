/**
 * Leave-cancellation flow helpers — Phase 74-04.
 *
 * Reusable steps for the leave cancellation E2E spec
 * (`apps/e2e/tests/cancellation.spec.ts`). Per CLAUDE.md
 * "Leave Cancellation Flow":
 *
 *   1. Employee/Manager requests cancellation → status = CANCELLATION_REQUESTED
 *   2. Leave remains active during this window
 *   3. Time entries during this window are allowed but marked `isInvalid: true`
 *      with reason "Urlaubsstornierung ausstehend"
 *   4. Another manager approves cancellation → status = CANCELLED + entries
 *      auto-revalidated
 *   5. If cancellation rejected → status reverts to APPROVED, entries stay invalid
 *
 * Per CLAUDE.md ArbZG §8 BUrlG: cancellation always requires approval by a
 * DIFFERENT manager (self-approval blocked). This module's `reviewCancellation`
 * helper returns the raw status+body so the spec can assert 403 on the
 * self-approval path without throwing.
 *
 * All API calls go through the test-tenant adminToken or a second-manager
 * token created via `createManager()`. The fixture from Phase 73-02 provides
 * the tenant + adminToken; this module adds the per-spec
 * second-manager-bootstrap helper that the plan calls out as "If 73-02 doesn't
 * expose this, this plan adds it inline."
 */

import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

/**
 * A second-tier manager created inside the test tenant.
 *
 * The plan asserts that cancellation approval REQUIRES a different manager
 * than the requester. Tests instantiate two of these (Manager A + Manager B)
 * to prove the cross-actor approval contract.
 */
export interface TestManager {
  /** Employee id (UUID) — used for tenant-scoped queries */
  id: string;
  /** Email — used for audit-trail assertions */
  email: string;
  /** JWT — bearer token authenticating this manager against the API */
  token: string;
}

/**
 * Outcome of `seedApprovedLeave` — everything the spec needs to drive the
 * cancellation flow without re-querying the API.
 */
export interface ApprovedLeaveSeed {
  /** UUID of the LeaveRequest that is now APPROVED */
  leaveRequestId: string;
  /** UUID of the employee whose leave was approved */
  employeeId: string;
  /** Employee email — used for log messages */
  employeeEmail: string;
  /** "YYYY-MM-DD" — first day of the leave window */
  startDate: string;
  /** "YYYY-MM-DD" — last day of the leave window */
  endDate: string;
}

/**
 * Raw HTTP response for the review endpoint — exposes status + body so the
 * spec can assert 403 on the self-approval path without try/catch.
 */
export interface ReviewResult {
  status: number;
  body: unknown;
}

interface CreateManagerOpts {
  /** Optional email override — defaults to `manager-{nanoid}@{tenant}.test` */
  email?: string;
  /** Optional first name — defaults to "Manager" */
  firstName?: string;
  /** Optional last name — defaults to a unique suffix */
  lastName?: string;
}

interface SeedOpts {
  /** "YYYY-MM-DD" — first day of the leave window */
  startDate: string;
  /** "YYYY-MM-DD" — last day of the leave window */
  endDate: string;
  /** Approver token — defaults to `tenant.adminToken` */
  approverToken?: string;
  /** Optional employee email override */
  employeeEmail?: string;
}

/** Random suffix for unique emails inside the tenant */
function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function headersFor(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

/**
 * Create a MANAGER employee inside the test tenant and log them in so the
 * spec gets a usable bearer token.
 *
 * Two-step process:
 *   1. POST /api/v1/employees with role=MANAGER + password — creates User +
 *      Employee inside `tenant.tenantId`.
 *   2. POST /api/v1/auth/login with the same credentials — returns
 *      `accessToken` we use as bearer for subsequent calls.
 *
 * The test-bootstrap admin token from Phase 73-01 creates the manager; the
 * manager's own token is then used for the multi-actor approval flow.
 */
export async function createManager(
  tenant: TestTenant,
  opts: CreateManagerOpts = {},
): Promise<TestManager> {
  const suffix = uniqueSuffix();
  const email = opts.email ?? `manager-${suffix}@${tenant.tenantId}.test`;
  const password = "test-password-123";

  const createRes = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers: headersFor(tenant.adminToken),
    body: JSON.stringify({
      email,
      firstName: opts.firstName ?? "Manager",
      lastName: opts.lastName ?? `Test-${suffix}`,
      employeeNumber: `MGR-${suffix}`,
      hireDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      role: "MANAGER",
      password,
    }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(
      `createManager: employee create failed (${createRes.status}): ${text}`,
    );
  }
  const employee = (await createRes.json()) as { id: string };

  const loginRes = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(
      `createManager: login failed for ${email} (${loginRes.status}): ${text}`,
    );
  }
  const tokens = (await loginRes.json()) as { accessToken: string };
  if (!tokens.accessToken) {
    throw new Error(
      `createManager: login response missing accessToken for ${email}`,
    );
  }

  return { id: employee.id, email, token: tokens.accessToken };
}

/**
 * Seed a fully-APPROVED VACATION leave request inside the test tenant.
 *
 * Flow:
 *   1. Create a fresh employee (EMPLOYEE role) via the admin token.
 *   2. File a VACATION leave request on behalf of that employee via the
 *      admin token (admin = manager-on-behalf-of).
 *   3. Approve the request via the admin token (or the configured approver).
 *
 * Returns the IDs the spec needs to drive the cancellation flow.
 */
export async function seedApprovedLeave(
  tenant: TestTenant,
  opts: SeedOpts,
): Promise<ApprovedLeaveSeed> {
  const approverToken = opts.approverToken ?? tenant.adminToken;
  const suffix = uniqueSuffix();
  const employeeEmail = opts.employeeEmail ?? `emp-${suffix}@${tenant.tenantId}.test`;

  // 1. Create employee inside the tenant
  const empRes = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers: headersFor(tenant.adminToken),
    body: JSON.stringify({
      email: employeeEmail,
      firstName: "Cancel",
      lastName: `Test-${suffix}`,
      employeeNumber: `EMP-${suffix}`,
      hireDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      role: "EMPLOYEE",
    }),
  });
  if (!empRes.ok) {
    const text = await empRes.text();
    throw new Error(
      `seedApprovedLeave: employee create failed (${empRes.status}): ${text}`,
    );
  }
  const employee = (await empRes.json()) as { id: string };

  // 2. File a VACATION leave request via manager-on-behalf-of (admin can act for any employee).
  //    POST /api/v1/leave/requests with employeeId override.
  const requestRes = await fetch(`${API_BASE}/api/v1/leave/requests`, {
    method: "POST",
    headers: headersFor(approverToken),
    body: JSON.stringify({
      type: "VACATION",
      startDate: opts.startDate,
      endDate: opts.endDate,
      employeeId: employee.id,
    }),
  });
  if (!requestRes.ok) {
    const text = await requestRes.text();
    throw new Error(
      `seedApprovedLeave: leave request create failed (${requestRes.status}): ${text}`,
    );
  }
  const leaveRequest = (await requestRes.json()) as { id: string; status: string };

  // 3. Approve the request — only needed if it didn't auto-approve (VACATION = PENDING by default).
  if (leaveRequest.status !== "APPROVED") {
    const approveRes = await fetch(
      `${API_BASE}/api/v1/leave/requests/${leaveRequest.id}/review`,
      {
        method: "PATCH",
        headers: headersFor(approverToken),
        body: JSON.stringify({ status: "APPROVED" }),
      },
    );
    if (!approveRes.ok) {
      const text = await approveRes.text();
      throw new Error(
        `seedApprovedLeave: approve failed (${approveRes.status}): ${text}`,
      );
    }
  }

  return {
    leaveRequestId: leaveRequest.id,
    employeeId: employee.id,
    employeeEmail,
    startDate: opts.startDate,
    endDate: opts.endDate,
  };
}

/**
 * Transition an APPROVED leave request to CANCELLATION_REQUESTED.
 *
 * Per `apps/api/src/routes/leave.ts` line ~1074: when DELETE /requests/:id is
 * called on an APPROVED request, the API transitions status to
 * CANCELLATION_REQUESTED (a different manager must then review it).
 *
 * Caller decides which token to use — typically the same manager who will
 * later be denied self-approval, OR a manager other than the eventual
 * approver.
 */
export async function requestCancellation(
  _tenant: TestTenant,
  leaveRequestId: string,
  requesterToken: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/leave/requests/${leaveRequestId}`,
    {
      method: "DELETE",
      headers: headersFor(requesterToken),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `requestCancellation: cancel-request failed (${res.status}): ${text}`,
    );
  }
}

/**
 * Review a CANCELLATION_REQUESTED leave — approving moves it to CANCELLED +
 * auto-revalidates invalid time entries; rejecting reverts to APPROVED and
 * leaves invalid entries untouched.
 *
 * Returns the raw `{ status, body }` so tests can assert 403 on the
 * self-approval path without try/catch — the spec specifically needs both
 * the HTTP code AND the German error body for the security gate.
 */
export async function reviewCancellation(
  _tenant: TestTenant,
  leaveRequestId: string,
  decision: "APPROVED" | "REJECTED",
  reviewerToken: string,
): Promise<ReviewResult> {
  const res = await fetch(
    `${API_BASE}/api/v1/leave/requests/${leaveRequestId}/review`,
    {
      method: "PATCH",
      headers: headersFor(reviewerToken),
      body: JSON.stringify({ status: decision }),
    },
  );
  // Try JSON first, fall back to text — error responses may not always be JSON.
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

/**
 * Result of creating a time entry while a leave is CANCELLATION_REQUESTED.
 *
 * Per CLAUDE.md ArbZG §8 BUrlG: "CANCELLATION_REQUESTED leave: Time entries
 * ARE allowed but created as `isInvalid: true` with reason
 * 'Urlaubsstornierung ausstehend'."
 */
export interface InvalidEntryResult {
  /** UUID of the created TimeEntry */
  timeEntryId: string;
  /** Mirror of the API response `isInvalid` field — should be true */
  isInvalid: boolean;
  /** Mirror of the API response `invalidReason` field */
  invalidReason: string | null;
}

/**
 * Create a manual time entry for `date` while the employee has an active
 * CANCELLATION_REQUESTED leave covering that date.
 *
 * The API MUST accept (HTTP 201) and stamp `isInvalid: true` per the BUrlG
 * §8 contract. The spec asserts both:
 *   1. The HTTP status is 201 (creation succeeded)
 *   2. The response body carries `isInvalid: true`
 *
 * If the API ever flips back to blocking this (i.e. returns 409), the spec
 * fails loudly because that breaks the documented Leave Cancellation Flow.
 */
export async function createInvalidTimeEntryDuringCancellation(
  tenant: TestTenant,
  employeeId: string,
  date: string,
): Promise<InvalidEntryResult> {
  // 08:00–16:00 local time on the target date — comfortably within a normal
  // work day, no ArbZG warnings. Pass as ISO-8601 to satisfy z.string().datetime().
  const startTime = `${date}T08:00:00.000Z`;
  const endTime = `${date}T16:00:00.000Z`;

  const res = await fetch(`${API_BASE}/api/v1/time-entries`, {
    method: "POST",
    headers: headersFor(tenant.adminToken),
    body: JSON.stringify({
      employeeId,
      date,
      startTime,
      endTime,
      breakMinutes: 30,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `createInvalidTimeEntryDuringCancellation: HTTP ${res.status} for ${date}: ${text}`,
    );
  }
  const entry = (await res.json()) as {
    id: string;
    isInvalid: boolean;
    invalidReason: string | null;
  };
  return {
    timeEntryId: entry.id,
    isInvalid: entry.isInvalid,
    invalidReason: entry.invalidReason,
  };
}
