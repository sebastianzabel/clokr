// Issue #942 — Mein Tag showed „Noch nicht eingestempelt“ while an own entry of an earlier day was
// still open (Zeiten: „läuft seit 00:27 · Ausstempeln fehlt“). The pure part is tested here; the
// page wiring is pinned against the page sources (no route page is mounted in this workspace, see
// dashboard-clock-card.test.ts for the precedent).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  openEarlierEntry,
  openEarlierEntryText,
  endEntryHref,
  entryToEndFromParam,
  entryDay,
  OPEN_ENTRY_WINDOW_DAYS,
  type OpenEntryCandidate,
} from "../open-earlier-entry";

const row = (over: Partial<OpenEntryCandidate>): OpenEntryCandidate => ({
  id: "e1",
  date: "2026-11-09T00:00:00.000Z",
  startTime: new Date(2026, 10, 9, 0, 27).toISOString(),
  endTime: null,
  isLocked: false,
  activityKind: "UNSPECIFIED",
  ...over,
});

const TODAY = "2026-11-14";

describe("openEarlierEntry", () => {
  it("finds the open entry of Mo 9.11. (the reported case)", () => {
    expect(openEarlierEntry([row({})], TODAY)).toEqual({
      id: "e1",
      day: "2026-11-09",
      startTime: row({}).startTime,
      count: 1,
    });
  });

  it("ignores closed, locked and travel rows and today's own running entry", () => {
    const rows = [
      row({ id: "closed", endTime: new Date(2026, 10, 9, 8).toISOString() }),
      row({ id: "locked", isLocked: true }),
      row({ id: "travel", activityKind: "TRAVEL" }),
      row({
        id: "today",
        date: "2026-11-14T00:00:00.000Z",
        startTime: new Date(2026, 10, 14, 8).toISOString(),
      }),
    ];
    expect(openEarlierEntry(rows, TODAY)).toBeNull();
  });

  it("picks the oldest open entry and counts all of them", () => {
    const rows = [
      row({ id: "newer", date: "2026-11-12T00:00:00.000Z" }),
      row({ id: "older", date: "2026-11-05T00:00:00.000Z" }),
    ];
    const hit = openEarlierEntry(rows, TODAY);
    expect(hit?.id).toBe("older");
    expect(hit?.count).toBe(2);
  });

  it("reads the calendar day from the date column, not the UTC part of the start", () => {
    expect(
      entryDay({ date: "2026-11-09T00:00:00.000Z", startTime: "2026-11-08T23:27:00.000Z" }),
    ).toBe("2026-11-09");
  });
});

describe("openEarlierEntryText", () => {
  it("names the day and the start, in du-form", () => {
    const entry = openEarlierEntry([row({})], TODAY)!;
    const text = openEarlierEntryText(entry, TODAY);
    expect(text.title).toBe("Dein Eintrag vom Mo, 9.11. ist noch offen – seit 00:27.");
    expect(text.detail).toContain("Trag sein Ende ein");
    // older than yesterday: the resolver looks back one day only, so clocking in starts a new entry
    expect(text.detail).toContain("Einstempeln beginnt heute einen neuen Eintrag");
  });

  it("promises nothing about Einstempeln for yesterday's entry (tenant-bound cross-day rule)", () => {
    const entry = openEarlierEntry([row({ date: "2026-11-13T00:00:00.000Z" })], TODAY)!;
    expect(openEarlierEntryText(entry, TODAY).detail).not.toContain("Einstempeln");
  });

  it("mentions further open entries", () => {
    const entry = openEarlierEntry(
      [row({ id: "a" }), row({ id: "b", date: "2026-11-10T00:00:00.000Z" })],
      TODAY,
    )!;
    expect(openEarlierEntryText(entry, TODAY).detail).toContain("2 Einträge früherer Tage");
  });
});

describe("the Zeiten link", () => {
  it("links the day and the entry", () => {
    expect(endEntryHref({ id: "e1", day: "2026-11-09" })).toBe(
      "/ich/zeiten?date=2026-11-09&end=e1",
    );
  });

  it("resolves only an open, unlocked, loaded row", () => {
    const rows = [row({}), row({ id: "closed", endTime: "2026-11-09T08:00:00.000Z" })];
    expect(entryToEndFromParam(rows, "e1")?.id).toBe("e1");
    expect(entryToEndFromParam(rows, "closed")).toBeNull();
    expect(entryToEndFromParam(rows, "unknown")).toBeNull();
    expect(entryToEndFromParam([row({ isLocked: true })], "e1")).toBeNull();
    expect(entryToEndFromParam(rows, null)).toBeNull();
  });

  it("looks back as far as the team's open-clock-out tasks", () => {
    expect(OPEN_ENTRY_WINDOW_DAYS).toBe(62);
  });
});

function readSource(url: URL, fallback: string): string {
  try {
    return readFileSync(fileURLToPath(url), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), fallback), "utf8");
  }
}

describe("wiring", () => {
  const MEIN_TAG = readSource(
    new URL("../../../routes/(app)/dashboard/+page.svelte", import.meta.url),
    "src/routes/(app)/dashboard/+page.svelte",
  );
  const ZEITEN = readSource(
    new URL("../../../routes/(app)/time-entries/+page.svelte", import.meta.url),
    "src/routes/(app)/time-entries/+page.svelte",
  );

  it("Mein Tag reads the open-entry window and renders the hint with the Zeiten link", () => {
    expect(MEIN_TAG).toContain("/time-entries?from=${openWindowStart}&to=${yesterday}");
    expect(MEIN_TAG).toContain("openEarlierEntry(recentR.value, today)");
    expect(MEIN_TAG).toContain('data-testid="mein-tag-open-earlier"');
    expect(MEIN_TAG).toContain("href={endEntryHref(openEarlier)}");
  });

  it("today's clock state still derives from today's rows only", () => {
    expect(MEIN_TAG).toContain("let day = $derived(resolveDayState(todayEntries));");
  });

  it("Zeiten opens the existing edit dialog for the linked entry", () => {
    expect(ZEITEN).toContain(
      "entryToEndFromParam(entries, $page.url.searchParams.get(END_ENTRY_PARAM))",
    );
    expect(ZEITEN).toContain("if (endTarget) openEdit(endTarget);");
  });
});
