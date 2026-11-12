// Issue #853 (D-853-06, D-853-18) - the pure model of Team › Aufgaben: kinds, rows, order and counts.
import { describe, expect, it } from "vitest";
import {
  TASK_KINDS,
  TASK_KIND_VALUES,
  filterByKind,
  fmtTaskDate,
  rowsForView,
  sortTasks,
  taskCounts,
  taskKindLabel,
  taskRowsFrom,
  type LeaveTaskSource,
  type RetroTaskSource,
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
      ["paragraf9", "§ 9"],
      ["pausenbefund", "Pausenbefund"],
      ["ausstempeln", "Ausstempeln fehlt"],
      ["zeitkorrektur", "Zeitkorrektur"],
    ]);
    expect(TASK_KIND_VALUES).toHaveLength(6);
    expect(taskKindLabel("paragraf9")).toBe("§ 9");
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
