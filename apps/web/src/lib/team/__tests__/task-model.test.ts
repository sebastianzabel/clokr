// Issue #853 (D-853-06, D-853-18) - the pure model of Team › Aufgaben: kinds, rows, order and counts.
import { describe, expect, it } from "vitest";
import {
  BREAK_NOTICE_TYPES,
  TASK_KINDS,
  TASK_KIND_VALUES,
  filterByKind,
  availableTaskKinds,
  breakFindingHref,
  fmtTaskDate,
  rowsForView,
  sortTasks,
  taskCounts,
  taskKindLabel,
  taskRowsFrom,
  type LeaveTaskSource,
  type NoticeTaskSource,
  type OpenTaskSource,
  type RetroTaskSource,
  type Section9TaskSource,
} from "../task-model";

const leaveDays = (r: LeaveTaskSource) => `${r.days} Tage`;

function leave(over: Partial<LeaveTaskSource> & { id: string }): LeaveTaskSource {
  return {
    typeCode: "VACATION",
    status: "PENDING",
    employee: { firstName: "Mia", lastName: "Muster" },
    startDate: "2026-12-14",
    endDate: "2026-12-18",
    days: 4,
    halfDay: false,
    createdAt: "2026-11-02T08:00:00.000Z",
    ...over,
  };
}

function retro(over: Partial<RetroTaskSource> & { id: string }): RetroTaskSource {
  return {
    status: "PENDING",
    employee: { firstName: "Cem", lastName: "Konflikt" },
    targetDate: "2026-10-30",
    startTime: "09:30",
    endTime: "18:15",
    entryAgeInDays: 4,
    createdAt: "2026-11-03T08:00:00.000Z",
    ...over,
  };
}

describe("TASK_KINDS", () => {
  it("lists the six kinds with their German labels in display order", () => {
    expect(TASK_KINDS.map((k) => [k.kind, k.label])).toEqual([
      ["urlaub", "Urlaub"],
      ["nachtrag", "Nachtrag"],
      ["paragraf9", "Krank im Urlaub"],
      ["pausenbefund", "Pausenbefund"],
      ["ausstempeln", "Ausstempeln fehlt"],
      ["zeitkorrektur", "Zeitkorrektur"],
    ]);
    expect(TASK_KIND_VALUES).toHaveLength(6);
    expect(taskKindLabel("paragraf9")).toBe("Krank im Urlaub");
  });
});

describe("taskRowsFrom - leave", () => {
  it("maps a leave request to a row with the person as title and the period and days as subtitle", () => {
    const [row] = taskRowsFrom({ leave: [leave({ id: "a" })] }, { leaveDays });
    expect(row).toEqual({
      key: "urlaub:a",
      kind: "urlaub",
      sourceId: "a",
      personName: "Mia Muster",
      title: "Mia Muster",
      subtitle: "14.12.2026 – 18.12.2026 · 4 Tage",
      createdAt: "2026-11-02T08:00:00.000Z",
      status: "PENDING",
      decided: false,
      typeCode: "VACATION",
    });
  });

  it("takes the day figure from the caller's function, never its own", () => {
    const [row] = taskRowsFrom(
      { leave: [leave({ id: "a", days: 0.5, halfDay: true })] },
      { leaveDays: (r) => (r.halfDay ? "ein halber Tag" : "x") },
    );
    expect(row.subtitle.endsWith("ein halber Tag")).toBe(true);
  });

  it("keeps a cancellation request as an open urlaub row", () => {
    const [row] = taskRowsFrom(
      { leave: [leave({ id: "c", status: "CANCELLATION_REQUESTED" })] },
      { leaveDays },
    );
    expect(row.status).toBe("CANCELLATION_REQUESTED");
    expect(row.decided).toBe(false);
    expect(row.kind).toBe("urlaub");
  });

  it("marks APPROVED and REJECTED as decided and drops statuses that are neither open nor decided", () => {
    const rows = taskRowsFrom(
      {
        leave: [
          leave({ id: "1", status: "APPROVED" }),
          leave({ id: "2", status: "REJECTED" }),
          leave({ id: "3", status: "CANCELLED" }),
        ],
      },
      { leaveDays },
    );
    expect(rows.map((r) => [r.sourceId, r.decided])).toEqual([
      ["1", true],
      ["2", true],
    ]);
  });
});

describe("taskRowsFrom - retro", () => {
  it("maps a Zeitnachtrag with the proposed times and the entry age", () => {
    const [row] = taskRowsFrom({ retro: [retro({ id: "r1" })] }, { leaveDays });
    expect(row.kind).toBe("nachtrag");
    expect(row.key).toBe("nachtrag:r1");
    expect(row.title).toBe("Cem Konflikt");
    expect(row.subtitle).toBe("Eintrag vom 30.10.2026 · 09:30–18:15 · Alter: 4 Tage");
    expect(row.typeCode).toBeNull();
    expect(row.decided).toBe(false);
  });

  it("leaves the times out when none were proposed and shows a question mark for an unknown age", () => {
    const [row] = taskRowsFrom(
      { retro: [retro({ id: "r2", startTime: null, endTime: null, entryAgeInDays: undefined })] },
      { leaveDays },
    );
    expect(row.subtitle).toBe("Eintrag vom 30.10.2026 · Alter: ? Tage");
  });

  it("treats APPROVED, REJECTED and USED as decided", () => {
    const rows = taskRowsFrom(
      {
        retro: ["APPROVED", "REJECTED", "USED", "PENDING"].map((status, i) =>
          retro({ id: `r${i}`, status }),
        ),
      },
      { leaveDays },
    );
    expect(
      rows
        .filter((r) => r.decided)
        .map((r) => r.status)
        .sort(),
    ).toEqual(["APPROVED", "REJECTED", "USED"]);
  });
});

describe("taskRowsFrom - empty and mixed sources", () => {
  it("returns no rows for no sources and for empty lists", () => {
    expect(taskRowsFrom({}, { leaveDays })).toEqual([]);
    expect(taskRowsFrom({ leave: [], retro: [] }, { leaveDays })).toEqual([]);
  });

  it("puts leave and retro rows into one list, oldest first", () => {
    const rows = taskRowsFrom(
      {
        leave: [
          leave({ id: "late", createdAt: "2026-11-05T08:00:00.000Z" }),
          leave({ id: "early", createdAt: "2026-11-01T08:00:00.000Z" }),
        ],
        retro: [retro({ id: "mid", createdAt: "2026-11-03T08:00:00.000Z" })],
      },
      { leaveDays },
    );
    expect(rows.map((r) => r.key)).toEqual(["urlaub:early", "nachtrag:mid", "urlaub:late"]);
  });
});

describe("sortTasks", () => {
  const a = taskRowsFrom(
    { leave: [leave({ id: "a", createdAt: "2026-11-01T00:00:00Z" })] },
    { leaveDays },
  )[0];
  const b = taskRowsFrom(
    { leave: [leave({ id: "b", createdAt: "2026-11-02T00:00:00Z" })] },
    { leaveDays },
  )[0];
  const b2 = { ...b, key: "urlaub:a2" };

  it("sorts oldest first by default and newest first on request, without touching the input", () => {
    const input = [b, a];
    expect(sortTasks(input).map((r) => r.key)).toEqual(["urlaub:a", "urlaub:b"]);
    expect(sortTasks(input, "newest").map((r) => r.key)).toEqual(["urlaub:b", "urlaub:a"]);
    expect(input.map((r) => r.key)).toEqual(["urlaub:b", "urlaub:a"]);
  });

  it("breaks a tie on the timestamp by key, so the order is stable", () => {
    expect(sortTasks([b, b2]).map((r) => r.key)).toEqual(["urlaub:a2", "urlaub:b"]);
  });
});

describe("taskCounts, rowsForView, filterByKind", () => {
  const rows = taskRowsFrom(
    {
      leave: [
        leave({ id: "o1" }),
        leave({ id: "o2", createdAt: "2026-11-04T00:00:00Z" }),
        leave({ id: "d1", status: "APPROVED", createdAt: "2026-10-01T00:00:00Z" }),
        leave({ id: "d2", status: "REJECTED", createdAt: "2026-10-05T00:00:00Z" }),
      ],
      retro: [retro({ id: "r1" }), retro({ id: "rd", status: "APPROVED" })],
    },
    { leaveDays },
  );

  it("counts per kind and reports 0 for the kinds without rows", () => {
    const open = rowsForView(rows, "offen");
    expect(taskCounts(open)).toEqual({
      urlaub: 2,
      nachtrag: 1,
      paragraf9: 0,
      pausenbefund: 0,
      ausstempeln: 0,
      zeitkorrektur: 0,
    });
  });

  it("the open view lists the open rows oldest first, the decided view the decided ones newest first", () => {
    expect(rowsForView(rows, "offen").map((r) => r.sourceId)).toEqual(["o1", "r1", "o2"]);
    expect(rowsForView(rows, "entschieden").map((r) => r.sourceId)).toEqual(["rd", "d2", "d1"]);
  });

  it("filters by one kind or returns all", () => {
    const open = rowsForView(rows, "offen");
    expect(filterByKind(open, "nachtrag").map((r) => r.sourceId)).toEqual(["r1"]);
    expect(filterByKind(open, "alle")).toHaveLength(3);
    expect(filterByKind(open, "paragraf9")).toEqual([]);
  });
});

describe("fmtTaskDate", () => {
  it("formats an ISO day and leaves anything else alone", () => {
    expect(fmtTaskDate("2026-01-05")).toBe("05.01.2026");
    expect(fmtTaskDate("")).toBe("");
    expect(fmtTaskDate("heute")).toBe("heute");
  });
});

// ── Plan 10: § 9, Pausenbefund, open tasks ───────────────────────────────────

function section9(over: Partial<Section9TaskSource> & { id: string }): Section9TaskSource {
  return {
    employeeName: "Ina Beispiel",
    status: "AU_PENDING",
    overlapStart: "2026-11-03",
    overlapEnd: "2026-11-05",
    reason: null,
    sickRequest: { startDate: "2026-11-03", endDate: "2026-11-06" },
    vacationRequest: { startDate: "2026-11-02", endDate: "2026-11-13" },
    ...over,
  };
}

function notice(over: Partial<NoticeTaskSource> & { id: string }): NoticeTaskSource {
  return {
    type: "BREAK_PLACEMENT_VIOLATION",
    title: "Pausenbefund",
    message: "Am 10.11.2026 liegt keine Pause von mindestens 15 Minuten vor.",
    link: "/team/time-entries?employeeId=7c9e6679-7425-40de-944b-e07fc1f90ae7&date=2026-11-10",
    createdAt: "2026-11-11T09:00:00.000Z",
    dismissedAt: null,
    ...over,
  };
}

function openTask(over: Partial<OpenTaskSource> & { id: string }): OpenTaskSource {
  return {
    type: "ausstempeln",
    personName: "Tom Offen",
    day: "2026-11-10",
    startTime: "08:05",
    label: "Ausstempeln fehlt",
    link: "/team/zeiten?employeeId=7c9e6679-7425-40de-944b-e07fc1f90ae7&date=2026-11-10",
    ...over,
  };
}

describe("taskRowsFrom - § 9", () => {
  it("maps an AU_PENDING case to a paragraf9 row with both periods in the subtitle", () => {
    const [row] = taskRowsFrom({ section9: [section9({ id: "s1" })] }, { leaveDays });
    expect(row).toMatchObject({
      key: "paragraf9:s1",
      kind: "paragraf9",
      sourceId: "s1",
      title: "Ina Beispiel",
      subtitle: "Urlaub 02.11.2026–13.11.2026 · Krank 03.11.2026–06.11.2026",
      status: "AU_PENDING",
      decided: false,
      typeCode: null,
    });
  });

  it("keeps a REJECTED case open (it can be reopened) and shows its reason; CONFIRMED is no row", () => {
    const rows = taskRowsFrom(
      {
        section9: [
          section9({ id: "r", status: "REJECTED", reason: "AU fehlt" }),
          section9({ id: "c", status: "CONFIRMED" }),
          section9({ id: "x", status: "SUPERSEDED" }),
        ],
      },
      { leaveDays },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("AU_REJECTED");
    expect(rows[0]?.subtitle).toContain("„AU fehlt“");
    expect(rows[0]?.decided).toBe(false);
  });
});

describe("taskRowsFrom - Pausenbefund (the caller's own break notices)", () => {
  it("keeps only the two break notice types that are not dismissed", () => {
    expect(BREAK_NOTICE_TYPES).toEqual([
      "BREAK_CROSS_SALON_VIOLATION",
      "BREAK_PLACEMENT_VIOLATION",
    ]);
    const rows = taskRowsFrom(
      {
        notices: [
          notice({ id: "a" }),
          notice({ id: "b", type: "BREAK_CROSS_SALON_VIOLATION" }),
          notice({ id: "c", type: "LEAVE_APPROVED" }),
          notice({ id: "d", dismissedAt: "2026-11-11T10:00:00.000Z" }),
        ],
      },
      { leaveDays },
    );
    expect(rows.map((r) => r.sourceId).sort()).toEqual(["a", "b"]);
    expect(rows.every((r) => r.kind === "pausenbefund")).toBe(true);
  });

  it("takes title and message as the server worded them and links to Zeiten with the query kept", () => {
    const [row] = taskRowsFrom({ notices: [notice({ id: "a" })] }, { leaveDays });
    expect(row?.title).toBe("Pausenbefund");
    expect(row?.subtitle).toBe("Am 10.11.2026 liegt keine Pause von mindestens 15 Minuten vor.");
    expect(row?.href).toBe(
      "/team/zeiten?employeeId=7c9e6679-7425-40de-944b-e07fc1f90ae7&date=2026-11-10",
    );
  });

  it("a notice with an unsafe or missing link is a row without a link", () => {
    const rows = taskRowsFrom(
      {
        notices: [
          notice({ id: "a", link: "https://evil.example/x" }),
          notice({ id: "b", link: "javascript:alert(1)" }),
          notice({ id: "c", link: null }),
        ],
      },
      { leaveDays },
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.href === null)).toBe(true);
  });
});

describe("breakFindingHref", () => {
  it("maps a legacy route path to its new URL and keeps the query", () => {
    expect(breakFindingHref("/team/time-entries?employeeId=e1&date=2026-11-10")).toBe(
      "/team/zeiten?employeeId=e1&date=2026-11-10",
    );
  });

  it("leaves a new URL as it is", () => {
    expect(breakFindingHref("/team/zeiten?employeeId=e1&date=2026-11-10")).toBe(
      "/team/zeiten?employeeId=e1&date=2026-11-10",
    );
  });

  it("refuses a foreign origin, a protocol-relative URL, javascript: and empty input", () => {
    expect(breakFindingHref("https://evil.example/team/zeiten")).toBeNull();
    expect(breakFindingHref("//evil.example/x")).toBeNull();
    expect(breakFindingHref("javascript:alert(1)")).toBeNull();
    expect(breakFindingHref("/team/../admin")).toBeNull();
    expect(breakFindingHref("")).toBeNull();
    expect(breakFindingHref(null)).toBeNull();
    expect(breakFindingHref(undefined)).toBeNull();
  });
});

describe("taskRowsFrom - open tasks (the reach-scoped open-tasks read)", () => {
  it("maps an ausstempeln task to a row with person, day, start time, the server's label and the link", () => {
    const [row] = taskRowsFrom(
      { openTasks: { types: ["ausstempeln"], tasks: [openTask({ id: "t1" })] } },
      { leaveDays },
    );
    expect(row).toMatchObject({
      key: "ausstempeln:t1",
      kind: "ausstempeln",
      title: "Tom Offen",
      subtitle: "10.11.2026 · seit 08:05",
      label: "Ausstempeln fehlt",
      decided: false,
    });
    expect(row?.href).toBe(
      "/team/zeiten?employeeId=7c9e6679-7425-40de-944b-e07fc1f90ae7&date=2026-11-10",
    );
  });

  it("drops a zeitkorrektur task when the answer's types does not list it (D-853-23)", () => {
    const rows = taskRowsFrom(
      {
        openTasks: {
          types: ["ausstempeln"],
          tasks: [openTask({ id: "t1" }), openTask({ id: "k1", type: "zeitkorrektur" })],
        },
      },
      { leaveDays },
    );
    expect(rows.map((r) => r.kind)).toEqual(["ausstempeln"]);
  });

  it("maps a zeitkorrektur task when the answer lists the type", () => {
    const rows = taskRowsFrom(
      {
        openTasks: {
          types: ["ausstempeln", "zeitkorrektur"],
          tasks: [openTask({ id: "k1", type: "zeitkorrektur", label: "Zeitkorrektur" })],
        },
      },
      { leaveDays },
    );
    expect(rows.map((r) => r.kind)).toEqual(["zeitkorrektur"]);
  });

  it("ignores an unknown type and treats null / absent as an empty source", () => {
    expect(
      taskRowsFrom(
        { openTasks: { types: ["neu"], tasks: [openTask({ id: "z", type: "neu" })] } },
        { leaveDays },
      ),
    ).toEqual([]);
    expect(taskRowsFrom({ openTasks: null }, { leaveDays })).toEqual([]);
  });

  it("sorts all kinds into one list, oldest first", () => {
    const rows = taskRowsFrom(
      {
        leave: [leave({ id: "l", createdAt: "2026-11-05T08:00:00.000Z" })],
        section9: [section9({ id: "s", overlapStart: "2026-11-03" })],
        openTasks: { types: ["ausstempeln"], tasks: [openTask({ id: "t", day: "2026-11-10" })] },
      },
      { leaveDays },
    );
    expect(rows.map((r) => r.kind)).toEqual(["paragraf9", "urlaub", "ausstempeln"]);
  });
});

describe("availableTaskKinds", () => {
  const base = {
    leave: false,
    retro: false,
    section9: false,
    breakNoticeCount: 0,
    openTaskTypes: [] as string[],
  };

  it("offers a kind only to a caller who can decide or see it, in display order", () => {
    expect(availableTaskKinds(base)).toEqual([]);
    expect(
      availableTaskKinds({
        leave: true,
        retro: true,
        section9: true,
        breakNoticeCount: 2,
        openTaskTypes: ["ausstempeln"],
      }),
    ).toEqual(["urlaub", "nachtrag", "paragraf9", "pausenbefund", "ausstempeln"]);
  });

  it("offers Pausenbefund only with rows and Zeitkorrektur only when the answer lists it", () => {
    expect(availableTaskKinds({ ...base, leave: true })).toEqual(["urlaub"]);
    expect(availableTaskKinds({ ...base, breakNoticeCount: 1 })).toEqual(["pausenbefund"]);
    expect(availableTaskKinds({ ...base, openTaskTypes: ["ausstempeln"] })).toEqual([
      "ausstempeln",
    ]);
    expect(
      availableTaskKinds({ ...base, openTaskTypes: ["ausstempeln", "zeitkorrektur"] }),
    ).toEqual(["ausstempeln", "zeitkorrektur"]);
  });
});

// Issue #853-19 - the one context line under the title (prototype „Aufgaben“).
describe("taskRowsFrom - context line (#853-19)", () => {
  it("a Zeitnachtrag carries the person's reason in quotes, trimmed", () => {
    const [row] = taskRowsFrom(
      { retro: [retro({ id: "n", reason: "  Kasse hat beim Ausstempeln gehakt " })] },
      { leaveDays },
    );
    expect(row.context).toBe("„Kasse hat beim Ausstempeln gehakt“");
  });

  it("a Zeitnachtrag without a reason has no context line (never an empty pair of quotes)", () => {
    const rows = taskRowsFrom(
      {
        retro: [
          retro({ id: "a", reason: null }),
          retro({ id: "b", reason: "   " }),
          retro({ id: "c" }),
        ],
      },
      { leaveDays },
    );
    expect(rows.map((r) => r.context)).toEqual([null, null, null]);
  });

  it("a leave row has no context in the pure model: the page reads it within the caller's permissions", () => {
    const [row] = taskRowsFrom({ leave: [leave({ id: "a" })] }, { leaveDays });
    expect(row.context).toBeUndefined();
  });
});
