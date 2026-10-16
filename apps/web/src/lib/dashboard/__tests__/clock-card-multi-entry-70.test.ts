// Issue #70 (Phase 70b-06, D-02/D-07/D-11/D-12) — the clock card for several entries a day.
//
// No test in `apps/web` mounts a route page (see dashboard-clock-card.test.ts), so this file proves the
// card the way the card is built: the view model the page derives (pure functions of the server's
// answer and today's rows) is fed into the components the page mounts — ClockSalonSelect,
// ClockOtherSalon, TodayEntriesList — and the page SOURCE is read for the gates that keep every new
// element away from single-salon tenants (D-12). The web decides nothing: every salon, offer and
// name below comes from a hand-written server answer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// clock-salon.ts imports the API client (and through it the auth store, which reads localStorage at
// import); the pure functions under test never call it.
vi.mock("$api/client", () => ({ api: { get: vi.fn() }, ApiError: class extends Error {} }));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

import { fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "../../../__tests__/test-utils";
import ClockSalonSelect from "$lib/components/dashboard/ClockSalonSelect.svelte";
import ClockOtherSalon from "$lib/components/dashboard/ClockOtherSalon.svelte";
import TodayEntriesList from "$lib/components/dashboard/TodayEntriesList.svelte";
import {
  clockInBody,
  clockSalonView,
  fixedSalonNoteLabel,
  otherSalonBlocked,
  otherSalonOptions,
  type ClockSalonChoice,
} from "../clock-salon";
import { dayTotals, entryCountLabel, resolveDayState, type ClockDayEntry } from "../day-state";

const SALON_A = { id: "salon-a", name: "Salon A" };
const SALON_B = { id: "salon-b", name: "Salon B" };

function localHhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** An entry whose start/end are local wall-clock times of 2026-08-28, so labels hold in any time zone. */
function row(
  id: string,
  from: string,
  to: string | null,
  salon: { id: string; name: string },
): ClockDayEntry {
  const at = (hhmm: string) => new Date(`2026-08-28T${hhmm}:00`).toISOString();
  return {
    id,
    startTime: at(from),
    endTime: to ? at(to) : null,
    breakMinutes: 0,
    workingMinutes: to
      ? Math.round((new Date(at(to)).getTime() - new Date(at(from)).getTime()) / 60000)
      : null,
    salonId: salon.id,
    salonName: salon.name,
  };
}

/** The server's answer on a FINISHED multi-salon day: the salon a re-clock continues + the others. */
const FINISHED_OFFER: ClockSalonChoice = {
  offerChoice: true,
  preselectedSalonId: SALON_B.id,
  salons: [SALON_B],
  fixedSalon: SALON_A,
};
const RUNNING_IN_B: ClockSalonChoice = {
  offerChoice: false,
  preselectedSalonId: null,
  salons: [],
  fixedSalon: SALON_B,
};
/** A single-salon tenant's answer: nothing is ever named or offered. */
const SINGLE_SALON: ClockSalonChoice = {
  offerChoice: false,
  preselectedSalonId: null,
  salons: [],
  fixedSalon: null,
};

describe("the finished-day second-salon action (D-02/D-11)", () => {
  const view = clockSalonView(FINISHED_OFFER, "finished");

  it("tracer: a multi-salon finished day offers „In anderem Salon einstempeln“; activating it shows the offered salons and „Einstempeln“", async () => {
    const onstart = vi.fn();
    const onselect = vi.fn();
    renderWithTheme(ClockOtherSalon, {
      salons: otherSalonOptions(view),
      value: SALON_B.id,
      blocked: otherSalonBlocked(view, SALON_B.id),
      onselect,
      onstart,
    });
    const action = screen.getByRole("button", { name: "In anderem Salon einstempeln" });
    expect(screen.queryByRole("combobox")).toBeNull();
    await fireEvent.click(action);
    const select = screen.getByRole("combobox", { name: "Salon" }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent?.trim())).toEqual(["Salon B"]);
    expect(select.value).toBe(SALON_B.id);
    await fireEvent.click(screen.getByRole("button", { name: "Einstempeln" }));
    expect(onstart).toHaveBeenCalledTimes(1);
  });

  it("„Einstempeln“ stays disabled until an offered salon is chosen, and „Abbrechen“ folds the control away", async () => {
    renderWithTheme(ClockOtherSalon, {
      salons: otherSalonOptions(view),
      value: null,
      blocked: otherSalonBlocked(view, null),
      onselect: vi.fn(),
      onstart: vi.fn(),
    });
    await fireEvent.click(screen.getByRole("button", { name: "In anderem Salon einstempeln" }));
    expect(
      (screen.getByRole("button", { name: "Einstempeln" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "In anderem Salon einstempeln" })).toBeTruthy();
  });

  it("the request carries exactly the chosen offered salon, while „Erneut einstempeln“ carries none", () => {
    expect(clockInBody(view, SALON_B.id, "otherSalon")).toEqual({
      source: "MOBILE",
      salonId: SALON_B.id,
    });
    expect(clockInBody(view, SALON_B.id, "reopen")).toEqual({ source: "MOBILE" });
  });

  it("nothing is offered, so nothing is rendered, without an offer (running day, single-salon tenant)", () => {
    for (const [choice, kind] of [
      [RUNNING_IN_B, "running"],
      [SINGLE_SALON, "finished"],
      [SINGLE_SALON, "running"],
    ] as const) {
      const { container, unmount } = renderWithTheme(ClockOtherSalon, {
        salons: otherSalonOptions(clockSalonView(choice, kind)),
        value: null,
        onselect: vi.fn(),
        onstart: vi.fn(),
      });
      expect(container.textContent?.trim()).toBe("");
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });
});

describe("the salon note of the card (D-11)", () => {
  it("a running day says „Eingestempelt in Salon B“", () => {
    const day = resolveDayState([
      row("e1", "07:00", "11:00", SALON_A),
      row("e2", "11:30", null, SALON_B),
    ]);
    renderWithTheme(ClockSalonSelect, {
      view: clockSalonView(RUNNING_IN_B, day.kind),
      value: null,
      onselect: vi.fn(),
      noteLabel: fixedSalonNoteLabel(day.kind, 2),
    });
    expect(screen.getByText("Eingestempelt in Salon B")).toBeTruthy();
  });

  it("a finished day with one entry still says „Heute erfasst in …“, with several „Zuletzt erfasst in …“", () => {
    const one = renderWithTheme(ClockSalonSelect, {
      view: clockSalonView(FINISHED_OFFER, "finished"),
      value: null,
      onselect: vi.fn(),
      noteLabel: fixedSalonNoteLabel("finished", 1),
    });
    expect(screen.getByText("Heute erfasst in Salon A")).toBeTruthy();
    one.unmount();
    renderWithTheme(ClockSalonSelect, {
      view: clockSalonView(FINISHED_OFFER, "finished"),
      value: null,
      onselect: vi.fn(),
      noteLabel: fixedSalonNoteLabel("finished", 2),
    });
    expect(screen.getByText("Zuletzt erfasst in Salon A")).toBeTruthy();
  });

  it("without a note label the component renders the #87 wording (existing callers are unchanged)", () => {
    renderWithTheme(ClockSalonSelect, {
      view: { kind: "fixed", salon: SALON_A },
      value: null,
      onselect: vi.fn(),
    });
    expect(screen.getByText("Heute erfasst in Salon A")).toBeTruthy();
  });
});

describe("today's entries on the card (D-07)", () => {
  const ROWS = [row("e2", "11:30", null, SALON_B), row("e1", "07:00", "11:00", SALON_A)];

  it("two rows are counted „2 Einträge heute“ and listed in start order with their salon names", () => {
    expect(entryCountLabel(ROWS.length)).toBe("2 Einträge heute");
    renderWithTheme(TodayEntriesList, { entries: ROWS });
    const items = screen.getAllByRole("listitem").map((li) => li.textContent?.trim());
    expect(items).toEqual([
      `${localHhmm(ROWS[1]!.startTime)}–${localHhmm(ROWS[1]!.endTime!)} · Salon A`,
      `seit ${localHhmm(ROWS[0]!.startTime)} · Salon B`,
    ]);
    expect(screen.getByRole("list", { name: "Einträge von heute" })).toBeTruthy();
  });

  it("the day sums span earliest start to latest end; a running row leaves the end open", () => {
    const closed = [row("e1", "07:00", "11:00", SALON_A), row("e2", "11:30", "15:00", SALON_B)];
    const totals = dayTotals(closed, new Date("2026-08-28T18:00:00"));
    expect(localHhmm(totals.startTime!)).toBe("07:00");
    expect(localHhmm(totals.endTime!)).toBe("15:00");
    expect(totals.workingMinutes).toBe(240 + 210);
    expect(dayTotals(ROWS, new Date("2026-08-28T12:00:00")).endTime).toBeNull();
  });

  it("a row without a salon name is listed by its time range alone", () => {
    renderWithTheme(TodayEntriesList, {
      entries: [{ ...row("e1", "07:00", "11:00", SALON_A), salonName: undefined }],
    });
    expect(screen.getByRole("listitem").textContent?.trim()).toBe(
      `${localHhmm(row("e1", "07:00", "11:00", SALON_A).startTime)}–${localHhmm(row("e1", "07:00", "11:00", SALON_A).endTime!)}`,
    );
  });
});

describe("single-salon tenants and one-entry days see the card they knew (D-12)", () => {
  it("a single-salon tenant with one finished entry: no note, no action, no count, no list", () => {
    const rows = [row("e1", "08:00", "12:00", SALON_A)];
    const day = resolveDayState(rows);
    const view = clockSalonView(SINGLE_SALON, day.kind);
    expect(view).toEqual({ kind: "none" });
    expect(otherSalonOptions(view)).toEqual([]);
    expect(entryCountLabel(rows.length)).toBeNull();
    // The two components the page mounts for this day render no text at all.
    const select = renderWithTheme(ClockSalonSelect, { view, value: null, onselect: vi.fn() });
    expect(select.container.textContent?.trim()).toBe("");
    select.unmount();
    const other = renderWithTheme(ClockOtherSalon, {
      salons: otherSalonOptions(view),
      value: null,
      onselect: vi.fn(),
      onstart: vi.fn(),
    });
    expect(other.container.textContent?.trim()).toBe("");
  });

  it("a one-entry day of a multi-salon tenant keeps the #87 note and shows no count", () => {
    expect(entryCountLabel(1)).toBeNull();
    expect(fixedSalonNoteLabel("finished", 1)).toBe("Heute erfasst in");
  });
});

describe("the page wires every new element behind the server's answer (source gates)", () => {
  const PAGE_URL = new URL("../../../routes/(app)/dashboard/+page.svelte", import.meta.url);
  let PAGE: string;
  try {
    PAGE = readFileSync(fileURLToPath(PAGE_URL), "utf8");
  } catch {
    PAGE = readFileSync(resolve(process.cwd(), "src/routes/(app)/dashboard/+page.svelte"), "utf8");
  }

  it("the entry list and the count exist only when the clock-salon answer named a salon and two rows exist", () => {
    expect(PAGE).toMatch(
      /showEntryList = \$derived\(clockSalon\?\.fixedSalon != null && todayEntries\.length >= 2\)/,
    );
    expect(PAGE).toContain("{#if showEntryList}");
    expect(PAGE).toMatch(/entryCount = \$derived\(showEntryList \? entryCountLabel\(/);
  });

  it("the other-salon action sits inside the unlocked finished-day branch and posts the otherSalon action", () => {
    expect(PAGE).toContain("<ClockOtherSalon");
    const branch = PAGE.slice(PAGE.indexOf("{#if canReopenFinishedDay(day) && reopenGapLabel}"));
    expect(branch.indexOf("<ClockOtherSalon")).toBeGreaterThan(-1);
    expect(branch.indexOf("<ClockOtherSalon")).toBeLessThan(branch.indexOf("{:else}"));
    expect(PAGE).toContain('performClockIn("otherSalon")');
    // The idle start and the confirmed REOPEN both use the default action; a finished day's view is
    // `fixed`, which attaches no salon to it.
    expect(PAGE.match(/await performClockIn\(\);/g)).toHaveLength(2);
  });

  it("the reopen path is unchanged: its Rückfrage is still the only way into „Erneut einstempeln“", () => {
    expect(PAGE).toContain('confirmLabel="Erneut einstempeln"');
    expect(PAGE).toContain("onclick={openReopenDialog}");
  });
});
