// Issue #602 (Phase 851) - one switch per switchable e-mail group, saved at once as the whole list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";

const fetchPreferences = vi.fn();
const savePreferences = vi.fn();
vi.mock("$api/preferences", () => ({
  fetchPreferences: () => fetchPreferences(),
  savePreferences: (p: unknown) => savePreferences(p),
}));
vi.mock("$stores/toast", () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));

import EmailNotificationSettings from "../EmailNotificationSettings.svelte";

beforeEach(() => {
  fetchPreferences.mockResolvedValue({ emailOptOut: ["emailOnMissingEntries"] });
  savePreferences.mockImplementation(async (p: { emailOptOut: string[] }) => ({
    emailOptOut: p.emailOptOut,
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EmailNotificationSettings", () => {
  it("shows four switches; a switched-off group reads off", async () => {
    renderWithTheme(EmailNotificationSettings, {});
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(4));
    expect(screen.getByLabelText(/Fehlende Zeiten und Pausen/)).not.toBeChecked();
    expect(screen.getByLabelText(/Antrag entschieden/)).toBeChecked();
  });

  it("switching a group off saves the whole list once", async () => {
    renderWithTheme(EmailNotificationSettings, {});
    const sw = await screen.findByLabelText(/Antrag entschieden/);
    await fireEvent.click(sw);
    await waitFor(() => expect(savePreferences).toHaveBeenCalledTimes(1));
    expect(savePreferences).toHaveBeenCalledWith({
      emailOptOut: ["emailOnMissingEntries", "emailOnLeaveDecision"],
    });
  });
});
