// Unit tests for .github/scripts/sprint-hygiene.mjs (Issue #712): list building and the
// Ready "Liegezeit" computation. Pure inline fixtures; no network.
import { describe, expect, it } from "vitest";
import {
  daysBetween,
  doneWithoutSprint,
  earlierChecklists,
  inboxCount,
  normalizeItem,
  parseHygieneArgs,
  readyCards,
  readySince,
  renderHygiene,
  withoutMilestone,
} from "../../.github/scripts/sprint-hygiene.mjs";

const NOW = Date.parse("2026-10-26T06:00:00Z");
const d = (s) => Date.parse(s);

const sprint = (title, start) => ({ title, start: d(start), end: d(start) + 14 * 86_400_000 });

function item(o) {
  return {
    number: 1,
    title: "t",
    open: true,
    closedAt: null,
    milestone: null,
    status: null,
    iteration: null,
    readySince: null,
    ...o,
  };
}

describe("readySince / daysBetween", () => {
  it("takes the latest move into Ready, whatever the event order", () => {
    const events = [
      { status: "Ready", createdAt: "2026-10-20T00:00:00Z" },
      { status: "Backlog", createdAt: "2026-10-21T00:00:00Z" },
      { status: "Ready", createdAt: "2026-10-10T00:00:00Z" },
    ];
    expect(readySince(events)).toBe(d("2026-10-20T00:00:00Z"));
  });
  it("is null without a Ready event", () => {
    expect(readySince([{ status: "Inbox", createdAt: "2026-10-01T00:00:00Z" }])).toBeNull();
    expect(readySince(undefined)).toBeNull();
  });
  it("counts whole days and never goes negative", () => {
    expect(daysBetween(d("2026-10-12T12:00:00Z"), NOW)).toBe(13);
    expect(daysBetween(NOW + 1000, NOW)).toBe(0);
  });
});

describe("readyCards", () => {
  it("computes Liegezeit in days, flags more than a sprint, sorts longest first", () => {
    const cards = readyCards(
      [
        item({ number: 1, status: "Ready", readySince: d("2026-10-24T06:00:00Z") }),
        item({ number: 2, status: "Ready", readySince: d("2026-10-05T06:00:00Z") }),
        item({ number: 3, status: "Ready", readySince: d("2026-10-12T06:00:00Z") }),
        item({ number: 4, status: "Backlog" }),
        item({ number: 5, status: "Ready", open: false }),
      ],
      NOW,
    );
    expect(cards.map((c) => [c.number, c.days, c.overdue])).toEqual([
      [2, 21, true],
      [3, 14, false], // exactly one sprint is still inside the limit
      [1, 2, false],
    ]);
  });
  it("marks an expired sprint and keeps unknown Ready dates", () => {
    const [c] = readyCards(
      [item({ status: "Ready", iteration: sprint("KW 42–43", "2026-10-12") })],
      NOW,
    );
    expect(c.inExpiredSprint).toBe(true);
    expect(c.days).toBeNull();
    expect(c.overdue).toBe(false);
  });
});

describe("doneWithoutSprint", () => {
  const it1 = sprint("KW 44–45", "2026-10-26");
  it("flags no sprint and a sprint that does not hold the close date, ignores old and open", () => {
    const found = doneWithoutSprint(
      [
        item({ number: 1, open: false, closedAt: d("2026-10-20T00:00:00Z") }),
        item({ number: 2, open: false, closedAt: d("2026-10-20T00:00:00Z"), iteration: it1 }),
        item({ number: 3, open: false, closedAt: d("2026-10-27T00:00:00Z"), iteration: it1 }),
        item({ number: 4, open: false, closedAt: d("2026-07-01T00:00:00Z") }),
        item({ number: 5, open: true }),
      ],
      NOW,
    );
    expect(found.map((i) => i.number)).toEqual([1, 2]);
  });
});

describe("inbox, milestone and checklist lists", () => {
  it("counts Inbox and status-less open cards", () => {
    expect(
      inboxCount([
        item({ status: "Inbox" }),
        item({ status: null }),
        item({ status: "Inbox", open: false }),
        item({ status: "Ready" }),
      ]),
    ).toBe(2);
  });
  it("lists milestone-less issues unless deliberately Backlog or a sprint checklist", () => {
    const repo = [
      { number: 1, title: "a", milestone: null, labels: [] },
      { number: 2, title: "b", milestone: null, labels: [] },
      { number: 3, title: "c", milestone: { title: "v1" }, labels: [] },
      { number: 4, title: "d", milestone: null, labels: [{ name: "sprint" }] },
      { number: 5, title: "e", milestone: null, labels: [] },
    ];
    const board = [item({ number: 2, status: "Backlog" }), item({ number: 5, status: "Inbox" })];
    expect(withoutMilestone(repo, board).map((i) => i.number)).toEqual([1, 5]);
  });
  it("excludes the checklist being created", () => {
    const s = [
      { number: 9, title: "Sprint-Wechsel KW 44" },
      { number: 7, title: "Sprint-Wechsel KW 42" },
    ];
    expect(earlierChecklists(s, "Sprint-Wechsel KW 44").map((x) => x.number)).toEqual([7]);
  });
});

describe("normalizeItem", () => {
  it("flattens a node and skips drafts and checklist issues", () => {
    const n = normalizeItem({
      status: { name: "Ready" },
      iteration: { title: "KW 44–45", startDate: "2026-10-26", duration: 14 },
      content: {
        number: 9,
        title: "x",
        state: "OPEN",
        closedAt: null,
        milestone: { title: "v1.17.0" },
        timelineItems: { nodes: [{ status: "Ready", createdAt: "2026-10-20T00:00:00Z" }] },
      },
    });
    expect(n).toMatchObject({ number: 9, open: true, status: "Ready", milestone: "v1.17.0" });
    expect(n.readySince).toBe(d("2026-10-20T00:00:00Z"));
    expect(n.iteration.end).toBe(d("2026-11-09"));
    expect(normalizeItem({ content: {} })).toBeNull();
    expect(normalizeItem({ content: { number: 3, title: "Sprint-Wechsel KW 40" } })).toBeNull();
  });
});

describe("renderHygiene", () => {
  it("prints Liegezeit in days and the over-a-sprint marker and decision", () => {
    const md = renderHygiene({
      items: [
        item({ number: 2, title: "alt", status: "Ready", readySince: d("2026-10-05T06:00:00Z") }),
      ],
      board: true,
      repoIssues: [],
      sprintIssues: [],
      excludeTitle: "",
      now: NOW,
    });
    expect(md).toContain("#2 alt — Ready seit 21 Tg. ⚠ länger als ein Sprint");
    expect(md).toContain("diesen Sprint / zurück ins Backlog");
    expect(md).toContain("**Inbox:** 0 offene Karten");
  });
  it("degrades to the repository sections when the board is unreadable", () => {
    const md = renderHygiene({
      items: [],
      board: false,
      repoIssues: [{ number: 8, title: "z", milestone: null, labels: [] }],
      sprintIssues: [{ number: 3, title: "Sprint-Wechsel KW 40" }],
      excludeTitle: "",
      now: NOW,
    });
    expect(md).toContain("Board nicht lesbar");
    expect(md).toContain("#3 Sprint-Wechsel KW 40");
    expect(md).toContain("#8 z");
    expect(md).not.toContain("Inbox:");
  });
});

describe("parseHygieneArgs", () => {
  it("reads flags with defaults", () => {
    expect(parseHygieneArgs(["--dry-run"])).toMatchObject({ dryRun: true, project: 1 });
    expect(parseHygieneArgs(["--exclude-title", "T"]).excludeTitle).toBe("T");
  });
});
