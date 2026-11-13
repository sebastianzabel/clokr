// Issue #853 (D-853-09, AC-2) - Ablehnen is impossible without a reason, for every decision type of
// Aufgaben. Leave (incl. cancellation) is pinned by the LeaveReviewDialog suite; this file pins the
// other two: the Zeitnachtrag (RetroReviewBody, mounted) and the § 9 rejection (ReasonDialog, mounted,
// plus the source pin that the page opens exactly that dialog for it).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import RetroReviewBody from "../RetroReviewBody.svelte";
import ReasonDialog from "$components/ui/ReasonDialog.svelte";
import inboxSource from "../../../../../routes/(app)/inbox/+page.svelte?raw";

afterEach(() => cleanup());

function retroProps(over: Record<string, unknown> = {}) {
  return {
    open: true,
    personName: "Mia Muster",
    dayLabel: "30.10.2026",
    proposedLabel: "09:30–18:15",
    entryAgeInDays: 4,
    employeeReason: "Vergessen einzustempeln",
    ageWarning: null,
    editableTimes: true,
    startTime: "09:30",
    endTime: "18:15",
    breakMinutes: 30,
    reviewNote: "",
    pending: true,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

describe("Zeitnachtrag - Ablehnen needs a reason (RetroReviewBody)", () => {
  it("the reject button is disabled while the reason is empty, and says why", () => {
    renderWithTheme(RetroReviewBody, retroProps());
    const reject = screen.getByTestId("retro-review-reject") as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    expect(screen.getByText("Bitte nenne einen Grund.")).toBeTruthy();
  });

  it("the reject button stays disabled for a reason of whitespace only", async () => {
    const onReject = vi.fn();
    renderWithTheme(RetroReviewBody, retroProps({ reviewNote: "   ", onReject }));
    const reject = screen.getByTestId("retro-review-reject") as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    // `click()` honours `disabled` like a real click (a synthetic dispatched event does not).
    reject.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(onReject).not.toHaveBeenCalled();
  });

  it("typing a reason enables the reject button, which then calls back", async () => {
    const onReject = vi.fn();
    renderWithTheme(RetroReviewBody, retroProps({ onReject }));
    const reject = screen.getByTestId("retro-review-reject") as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    await fireEvent.input(screen.getByTestId("retro-review-note"), {
      target: { value: "Zeit stimmt nicht" },
    });
    await waitFor(() => expect(reject.disabled).toBe(false));
    expect(screen.queryByText("Bitte nenne einen Grund.")).toBeNull();
    await fireEvent.click(reject);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("approving needs no reason (it is optional there)", async () => {
    const onApprove = vi.fn();
    renderWithTheme(RetroReviewBody, retroProps({ onApprove }));
    const approve = screen.getByTestId("retro-review-approve") as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    await fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("shows the facts as a definition list, not as KPI tiles", () => {
    const { baseElement } = renderWithTheme(RetroReviewBody, retroProps());
    const facts = baseElement.querySelector('[data-testid="retro-review-facts"]')!;
    expect(facts.tagName).toBe("DL");
    const terms = Array.from(facts.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(terms).toEqual(
      expect.arrayContaining(["Person", "Tag", "Beantragte Zeiten", "Grund der Person"]),
    );
    expect(baseElement.querySelector(".mini-stat, .kpi")).toBeNull();
  });

  it("an own request cannot be decided and shows neither button", () => {
    renderWithTheme(RetroReviewBody, retroProps({ selfApproval: true }));
    expect(screen.queryByTestId("retro-review-reject")).toBeNull();
    expect(screen.queryByTestId("retro-review-approve")).toBeNull();
    expect(screen.getByText("Eigene Anträge können nicht selbst genehmigt werden.")).toBeTruthy();
  });
});

describe("§ 9 - Ablehnen needs a reason (ReasonDialog)", () => {
  it("a blank or whitespace reason never reaches the rejection and keeps the dialog open", async () => {
    const onConfirm = vi.fn();
    renderWithTheme(ReasonDialog, {
      open: true,
      title: "AU ablehnen",
      confirmLabel: "Ablehnen",
      danger: true,
      onConfirm,
    });
    await fireEvent.click(screen.getByRole("button", { name: "Ablehnen" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("erforderlich"));
    await fireEvent.input(screen.getByLabelText(/Begründung/), { target: { value: "   " } });
    await fireEvent.click(screen.getByRole("button", { name: "Ablehnen" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("a typed reason is passed on trimmed", async () => {
    const onConfirm = vi.fn();
    renderWithTheme(ReasonDialog, {
      open: true,
      title: "AU ablehnen",
      confirmLabel: "Ablehnen",
      danger: true,
      onConfirm,
    });
    await fireEvent.input(screen.getByLabelText(/Begründung/), {
      target: { value: "  AU liegt nicht vor  " },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Ablehnen" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("AU liegt nicht vor"));
  });

  it("the page rejects a § 9 case only through that dialog, and the Zeitnachtrag through the body", () => {
    // The route itself cannot be mounted ($app/*); the call sites are pinned by source instead.
    const flat = inboxSource.replace(/\s+/g, " ");
    expect(flat).toContain("<ReasonDialog");
    expect(flat).toContain("onConfirm={confirmSection9Reject}");
    expect(flat).toContain("`/leave/section9/${section9RejectCase.id}/reject`");
    expect(flat).toContain("<RetroReviewBody");
    expect(flat).toContain('onReject={() => submitRetroReview("REJECTED")}');
    // The submit handler refuses an empty reason a second time, whatever the button state.
    expect(flat).toContain('status === "REJECTED" && !retroReviewNote.trim()');
  });
});
