// Issue #597 (Phase 851): the calendar subscription shows its secret link only right after it was
// created, says that a link exists afterwards, and ends it only after a second, explicit click.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";

const issueMock = vi.fn();
const revokeMock = vi.fn();
vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});
vi.mock("$lib/me/calendar-feed", async (orig) => {
  const real = await orig<typeof import("$lib/me/calendar-feed")>();
  return {
    ...real,
    issueCalendarFeed: () => issueMock(),
    revokeCalendarFeed: () => revokeMock(),
  };
});
vi.mock("$stores/toast", () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));

import CalendarFeedDialog from "../CalendarFeedDialog.svelte";

afterEach(() => {
  cleanup();
  issueMock.mockReset();
  revokeMock.mockReset();
});

const none = { active: false, createdAt: null, rotatedAt: null, lastUsedAt: null };
const active = {
  active: true,
  createdAt: "2026-11-01T08:00:00Z",
  rotatedAt: null,
  lastUsedAt: null,
};

describe("CalendarFeedDialog", () => {
  it("shows the link once, right after creating it", async () => {
    const onChange = vi.fn();
    issueMock.mockResolvedValueOnce({
      ...active,
      url: "https://app.example/api/v1/calendar-feed/dienstplan.ics?token=t",
      webcalUrl: "webcal://app.example/api/v1/calendar-feed/dienstplan.ics?token=t",
    });
    renderWithTheme(CalendarFeedDialog, { open: true, feed: none, onChange });
    expect(screen.queryByTestId("calendar-feed-url")).toBeNull();
    await fireEvent.click(screen.getByTestId("calendar-feed-issue"));
    const url = (await screen.findByTestId("calendar-feed-url")) as HTMLInputElement;
    expect(url.value).toContain("dienstplan.ics");
    expect(onChange).toHaveBeenCalledWith(active);
  });

  it("says an existing subscription exists without any link", () => {
    renderWithTheme(CalendarFeedDialog, { open: true, feed: active, onChange: () => {} });
    expect(screen.getByTestId("calendar-feed-status").textContent).toContain(
      "Noch nicht von einem Kalender abgerufen",
    );
    expect(screen.queryByTestId("calendar-feed-url")).toBeNull();
  });

  it("ends the subscription only after the explicit confirmation", async () => {
    const onChange = vi.fn();
    revokeMock.mockResolvedValueOnce(undefined);
    renderWithTheme(CalendarFeedDialog, { open: true, feed: active, onChange });
    await fireEvent.click(screen.getByRole("button", { name: "Abo beenden" }));
    expect(revokeMock).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId("calendar-feed-revoke-confirm"));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(none);
  });
});
