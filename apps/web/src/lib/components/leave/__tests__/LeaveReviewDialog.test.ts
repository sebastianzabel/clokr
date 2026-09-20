// Phase 255 (GitHub issue #255) — the mounted test suite for the ONE shared absence review
// dialog. This is the phase's second, ticket-unnamed gain: logic that until now could only be
// pinned via source-read tests (apps/web/vitest.config.ts registers no `$app/*` alias, so a route
// file that imports `$app/stores` can never be mounted) is, for the first time, actually MOUNTED
// and exercised here — because the dialog moved out of a route and into a component under `lib/`,
// and because the component itself never imports the auth store (D-03).
//
// `lib/components/leave/` sits outside `lint:ui-classes`' scope (D-15 —
// apps/web/scripts/lint-ui-classes.mjs only scans `lib/components/ui/` and
// `lib/components/layout/`). Per CLAUDE.md § UI Consistency Rules, THIS mounted test file is the
// substitute safeguard for that gap, not an afterthought.
//
// Mounting pulls in `$api/client`, which imports `$stores/auth`, which imports SvelteKit's
// `$app/environment` — and `apps/web/vitest.config.ts` registers no `$app/*` alias. Mocking
// "$app/environment" directly does not help: Vite's import-analysis plugin fails to resolve the
// bare specifier before Vitest's mock registry gets a chance to intercept it. Mocking
// "$stores/auth" instead (a real, alias-resolvable path) replaces the whole module before its own
// `$app/environment` import is ever transformed — precedent, quoted verbatim there:
// apps/web/src/lib/components/layout/__tests__/version-line.test.ts:29-39,
// apps/web/src/lib/components/layout/__tests__/WhatsNewPanel.test.ts:26.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock("$api/client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeaveReviewDialog from "../LeaveReviewDialog.svelte";
import { showsBurlgSection7Notice, type LeaveReviewRequest } from "$lib/leave/leave-review";
import { LEAVE_TYPES, NEUTRAL_CHIP_LABEL, SICK_CODES } from "$lib/leave/team-calendar-visibility";

const ALL_CODES = LEAVE_TYPES.map((t) => t.code);

function baseRequest(overrides: Partial<LeaveReviewRequest> = {}): LeaveReviewRequest {
  return {
    id: "req-1",
    employeeId: "emp-1",
    typeCode: "VACATION",
    employee: { firstName: "Alex", lastName: "Muster" },
    startDate: "2026-09-01",
    endDate: "2026-09-05",
    days: 5,
    halfDay: false,
    status: "PENDING",
    note: null,
    attestPresent: false,
    attestValidFrom: null,
    attestValidTo: null,
    ...overrides,
  };
}

function renderDialog(
  overrides: Partial<LeaveReviewRequest> = {},
  currentEmployeeId = "manager-1",
) {
  const onReviewed = vi.fn();
  renderWithTheme(LeaveReviewDialog, {
    open: true,
    request: baseRequest(overrides),
    currentEmployeeId,
    onReviewed,
  });
  return { onReviewed };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  // Default: no overlap, no collisions — the happy path for every test that does not override
  // this. checkAppointmentCollisions() and the overlap fetch both go through the same `api.get`
  // mock, so the implementation dispatches on the path.
  apiGet.mockImplementation((path: string) => {
    if (typeof path === "string" && path.startsWith("/integrations/phorest/")) {
      return Promise.resolve({ total: 0, collisions: [], deepLink: null });
    }
    return Promise.resolve([]);
  });
  apiPatch.mockResolvedValue(undefined);
});

describe("LeaveReviewDialog", () => {
  // ── Test 0 — anti-vacuity gate, before any "X is absent" assertion below is trusted ─────────
  it("Test 0: a standard mount renders the dialog root and its summary", () => {
    renderDialog();
    expect(screen.getByTestId("leave-approval-modal")).toBeTruthy();
    expect(screen.getByTestId("leave-approval-modal-summary")).toBeTruthy();
  });

  // ── Attest section — gated on SICK_CODES only, table-driven over the full vocabulary ─────────
  describe("Attest section appears for SICK_CODES only", () => {
    it("covers the full ten-code vocabulary", () => {
      expect(ALL_CODES.length).toBe(10);
    });

    it.each(ALL_CODES)("%s", (code) => {
      renderDialog({ typeCode: code });
      const expected = SICK_CODES.includes(code);
      if (expected) {
        expect(screen.getByTestId("attest-fields")).toBeTruthy();
      } else {
        expect(screen.queryByTestId("attest-fields")).toBeNull();
      }
    });
  });

  // ── BUrlG § 7 notice — gated on showsBurlgSection7Notice(), table-driven ─────────────────────
  describe("BUrlG § 7 notice appears for VACATION and SPECIAL only", () => {
    it("covers the full ten-code vocabulary", () => {
      expect(ALL_CODES.length).toBe(10);
    });

    it.each(ALL_CODES)("%s", (code) => {
      renderDialog({ typeCode: code });
      const expected = showsBurlgSection7Notice(code);
      const notice = screen.queryByText("BUrlG § 7:");
      if (expected) {
        expect(notice).toBeTruthy();
      } else {
        expect(notice).toBeNull();
      }
    });
  });

  // ── Self-approval guard (D-03: driven by the currentEmployeeId prop, not the auth store) ────
  it("self-approval: self-block note is shown, decision buttons are absent", () => {
    renderDialog({ employeeId: "manager-1" }, "manager-1");
    expect(screen.getByTestId("leave-approval-modal-self-block")).toBeTruthy();
    expect(screen.queryByTestId("leave-approval-modal-approve")).toBeNull();
    expect(screen.queryByTestId("leave-approval-modal-reject")).toBeNull();
  });

  // ── Already-decided footer (D-04's /inbox-only branch, Issue #255) ───────────────────────────
  it("status APPROVED: footer shows the already-decided note, no decision buttons", () => {
    renderDialog({ status: "APPROVED" });
    expect(screen.getByText("Antrag bereits entschieden.")).toBeTruthy();
    expect(screen.queryByTestId("leave-approval-modal-approve")).toBeNull();
    expect(screen.queryByTestId("leave-approval-modal-reject")).toBeNull();
  });

  // ── The review mutation, and its Attest follow-up on sick types only (D-01/D-02) ────────────
  it("approve on a SICK request calls PATCH /review then PATCH /attest, in that order, and calls onReviewed once", async () => {
    const { onReviewed } = renderDialog({ typeCode: "SICK" });
    await fireEvent.click(screen.getByTestId("leave-approval-modal-approve"));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledTimes(2);
    expect(apiPatch.mock.calls[0][0]).toMatch(/\/review$/);
    expect(apiPatch.mock.calls[1][0]).toMatch(/\/attest$/);
    expect(apiPatch.mock.calls[1][1]).toMatchObject({
      attestPresent: false,
      attestValidFrom: null,
      attestValidTo: null,
    });
  });

  it("approve on a VACATION request calls PATCH /review only, never /attest", async () => {
    const { onReviewed } = renderDialog({ typeCode: "VACATION" });
    await fireEvent.click(screen.getByTestId("leave-approval-modal-approve"));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch.mock.calls[0][0]).toMatch(/\/review$/);
  });

  // Pins the pre-existing, deliberately-untouched D-02 behaviour (Phase 104-10, comment carried
  // verbatim into runReview()): the Attest follow-up fires for SICK_CODES regardless of whether
  // the decision is APPROVED or REJECTED — it is a display toggle on legacy data, not a § 9
  // credit trigger. Skipping the collision pre-check on REJECTED is also implicitly covered here:
  // if it fired, the mock's default collision response would not change the outcome, but the
  // call-count assertion below still pins that /attest is the SECOND and ONLY other PATCH call.
  it("reject on a SICK request still calls PATCH /attest — the deliberately-untouched toggle (D-02)", async () => {
    const { onReviewed } = renderDialog({ typeCode: "SICK" });
    await fireEvent.click(screen.getByTestId("leave-approval-modal-reject"));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledTimes(2);
    expect(apiPatch.mock.calls[0][1]).toMatchObject({ status: "REJECTED" });
    expect(apiPatch.mock.calls[1][0]).toMatch(/\/attest$/);
  });

  // ── Cancellation-review labelling (D-06's leave-cancel-approval-modal-* testid family) ───────
  it("status CANCELLATION_REQUESTED: buttons are labelled for cancellation and carry the leave-cancel-approval-modal-* testids", () => {
    renderDialog({ status: "CANCELLATION_REQUESTED" });
    const reject = screen.getByTestId("leave-cancel-approval-modal-reject");
    const approve = screen.getByTestId("leave-cancel-approval-modal-approve");
    expect(reject.textContent?.trim()).toBe("Stornierung ablehnen");
    expect(approve.textContent?.trim()).toBe("Stornierung genehmigen");
  });

  // ── Overlap masking (Phase 262, D-01) — a null typeName is a masked row, never a data error ──
  it("a masked overlap row (typeName null) renders NEUTRAL_CHIP_LABEL in a .chip, never a raw control value", async () => {
    apiGet.mockImplementation((path: string) => {
      if (typeof path === "string" && path.startsWith("/leave/overlap")) {
        return Promise.resolve([
          {
            id: "ov-1",
            employeeName: "Sam Kollege",
            typeCode: null,
            typeName: null,
            startDate: "2026-09-02",
            endDate: "2026-09-03",
            status: "APPROVED",
          },
        ]);
      }
      return Promise.resolve({ total: 0, collisions: [], deepLink: null });
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText("Sam Kollege")).toBeTruthy());
    const chip = document.querySelector(".overlap-row .chip");
    expect(chip?.textContent).toBe(NEUTRAL_CHIP_LABEL);
  });

  // ── Error text — D-04's exception favouring /inbox: the German API message, not HTTP text ───
  it("an API error carrying data.error renders the German API message, not the HTTP status text", async () => {
    apiPatch.mockRejectedValueOnce({
      data: { error: "Serverseitige deutsche Meldung" },
      message: "Bad Request",
    });
    renderDialog({ typeCode: "VACATION" });
    await fireEvent.click(screen.getByTestId("leave-approval-modal-approve"));
    await waitFor(() => expect(screen.getByText("Serverseitige deutsche Meldung")).toBeTruthy());
    expect(screen.queryByText("Bad Request")).toBeNull();
  });
});
