// Phase 112 (GitHub issue #115) — the panel is BOTH the missing explanation and the mobile
// access path to the confirm modal. These tests pin the prose (it must name § 4 ArbZG and the
// automatic entry) and the day-button contract the page wires openEdit() to.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import UnconfirmedBreakPanel from "../UnconfirmedBreakPanel.svelte";

const day = (entryId: string, date: string, label: string) => ({ entryId, date, label });

describe("UnconfirmedBreakPanel", () => {
  it("Test 1: renders nothing at all when there is no unconfirmed day", () => {
    renderWithTheme(UnconfirmedBreakPanel, { days: [], onOpen: vi.fn() });
    expect(screen.queryByTestId("unconfirmed-breaks-panel")).toBeNull();
  });

  it("Test 2: renders one button per unconfirmed day", () => {
    renderWithTheme(UnconfirmedBreakPanel, {
      days: [
        day("e1", "2026-08-05", "05.08.2026"),
        day("e2", "2026-08-06", "06.08.2026"),
        day("e3", "2026-08-07", "07.08.2026"),
      ],
      onOpen: vi.fn(),
    });
    expect(screen.getByTestId("unconfirmed-breaks-panel")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("Test 3: the prose explains the automatic entry and cites § 4 ArbZG", () => {
    const { container } = renderWithTheme(UnconfirmedBreakPanel, {
      days: [day("e1", "2026-08-05", "05.08.2026")],
      onOpen: vi.fn(),
    });
    const text = container.textContent ?? "";
    expect(text).toContain("automatisch");
    expect(text).toContain("§ 4 ArbZG");
    expect(text).toContain("durchgearbeitet");
  });

  it("Test 4: each day button carries its German label", () => {
    renderWithTheme(UnconfirmedBreakPanel, {
      days: [day("e1", "2026-08-05", "05.08.2026")],
      onOpen: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "05.08.2026" })).toBeTruthy();
  });

  it("Test 5: clicking a day button calls onOpen once with that entry id", async () => {
    const onOpen = vi.fn();
    renderWithTheme(UnconfirmedBreakPanel, {
      days: [day("e1", "2026-08-05", "05.08.2026"), day("e2", "2026-08-06", "06.08.2026")],
      onOpen,
    });
    await fireEvent.click(screen.getByRole("button", { name: "05.08.2026" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("e1");
  });

  it("Test 6: the heading uses singular for one day and plural for several", () => {
    const { container, unmount } = renderWithTheme(UnconfirmedBreakPanel, {
      days: [day("e1", "2026-08-05", "05.08.2026")],
      onOpen: vi.fn(),
    });
    expect(container.textContent).toContain("1 Tag: Pause bestätigen");
    unmount();

    const two = renderWithTheme(UnconfirmedBreakPanel, {
      days: [day("e1", "2026-08-05", "05.08.2026"), day("e2", "2026-08-06", "06.08.2026")],
      onOpen: vi.fn(),
    });
    expect(two.container.textContent).toContain("2 Tage: Pause bestätigen");
  });

  it("Test 7: each button is addressable by day without knowing the entry uuid", () => {
    renderWithTheme(UnconfirmedBreakPanel, {
      days: [day("e1", "2026-08-05", "05.08.2026")],
      onOpen: vi.fn(),
    });
    expect(screen.getByTestId("unconfirmed-break-day-2026-08-05")).toBeTruthy();
  });

  it("Test 8: the panel is announced as a status region", () => {
    renderWithTheme(UnconfirmedBreakPanel, {
      days: [day("e1", "2026-08-05", "05.08.2026")],
      onOpen: vi.fn(),
    });
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
