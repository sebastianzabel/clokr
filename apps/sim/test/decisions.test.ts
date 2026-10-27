import { describe, expect, it } from "vitest";
import type { LeaveRecord } from "../src/bots/context";
import {
  beyondRetroWindow,
  cancellableLeave,
  forgetsToBook,
  nachtragDue,
  pickReviewer,
  planShiftEdits,
  planUnlocks,
  statusAfterReview,
  type ListedShift,
  type PendingNachtrag,
} from "../src/bots/decisions";
import { isDeliberateUnlock } from "../src/checker/invariants-db";
import { rngFor } from "../src/rng";

const leave = (over: Partial<LeaveRecord>): LeaveRecord => ({
  id: "l1",
  start: "2026-12-07",
  end: "2026-12-09",
  type: "VACATION",
  status: "APPROVED",
  ...over,
});

describe("cancellableLeave", () => {
  const open = () => false;
  it("takes a future requested or granted vacation", () => {
    expect(cancellableLeave([leave({})], "2026-11-20", open)?.id).toBe("l1");
    expect(cancellableLeave([leave({ status: "PENDING" })], "2026-11-20", open)?.id).toBe("l1");
  });
  it("ignores sick leave, running leave, finished states and closed months", () => {
    expect(cancellableLeave([leave({ type: "SICK" })], "2026-11-20", open)).toBeNull();
    expect(cancellableLeave([leave({ type: "SICK_CHILD" })], "2026-11-20", open)).toBeNull();
    expect(cancellableLeave([leave({})], "2026-12-07", open)).toBeNull();
    for (const status of ["CANCELLATION_REQUESTED", "CANCELLED", "REJECTED"] as const) {
      expect(cancellableLeave([leave({ status })], "2026-11-20", open)).toBeNull();
    }
    expect(cancellableLeave([leave({})], "2026-11-20", (m) => m === "2026-12")).toBeNull();
  });
});

describe("pickReviewer (four eyes)", () => {
  const people = [
    { userId: "u1", employeeId: "e1" },
    { userId: "u2", employeeId: "e2" },
    { userId: "u3", employeeId: "e3" },
  ];
  it("skips the filer and, for a cancellation, the original approver", () => {
    expect(pickReviewer(people, { employeeIds: ["e1"] })?.userId).toBe("u2");
    expect(pickReviewer(people, { employeeIds: ["e1"], userIds: ["u2"] })?.userId).toBe("u3");
  });
  it("answers null when nobody else may decide", () => {
    expect(pickReviewer([people[0]], { employeeIds: ["e1"] })).toBeNull();
    expect(pickReviewer(people.slice(0, 2), { employeeIds: ["e1"], userIds: ["u2"] })).toBeNull();
  });
});

describe("statusAfterReview", () => {
  it("turns an approved cancellation into CANCELLED and a rejected one back into APPROVED", () => {
    expect(statusAfterReview("CANCELLATION_REQUESTED", "APPROVED")).toBe("CANCELLED");
    expect(statusAfterReview("CANCELLATION_REQUESTED", "REJECTED")).toBe("APPROVED");
    expect(statusAfterReview("PENDING", "APPROVED")).toBe("APPROVED");
    expect(statusAfterReview("PENDING", "REJECTED")).toBe("REJECTED");
  });
});

describe("Zeitnachtrag timing", () => {
  it("is needed only strictly beyond the ten day window", () => {
    expect(beyondRetroWindow("2026-11-10", "2026-11-20")).toBe(false);
    expect(beyondRetroWindow("2026-11-09", "2026-11-20")).toBe(true);
  });
  it("is due per person once the window is over", () => {
    const mk = (person: string, day: string): PendingNachtrag => ({
      person,
      day,
      start: "09:00",
      end: "17:00",
      breaks: [],
      intent: null,
      salonIndex: 0,
    });
    const pending = [mk("a", "2026-11-01"), mk("a", "2026-11-15"), mk("b", "2026-11-01")];
    expect(nachtragDue(pending, "a", "2026-11-20")).toEqual([pending[0]]);
  });
  it("is forgotten on the web channel only, and deterministically", () => {
    const hits = (channel: string) =>
      Array.from({ length: 400 }, (_, i) =>
        forgetsToBook(rngFor("s", "f", String(i)), channel),
      ).filter(Boolean).length;
    expect(hits("NFC")).toBe(0);
    expect(hits("WIFI")).toBe(0);
    expect(hits("WEB")).toBeGreaterThan(0);
    expect(hits("WEB")).toBe(hits("WEB"));
  });
});

describe("planShiftEdits", () => {
  const shifts: ListedShift[] = Array.from({ length: 200 }, (_, i) => ({
    id: `s${i}`,
    employeeId: `e${i}`,
    date: "2026-11-30",
    startTime: "09:00",
    endTime: "17:00",
  }));
  it("is seeded, bounded and keeps moves within a day", () => {
    const a = planShiftEdits(shifts, rngFor("s", "x"), 12, 0.2);
    const b = planShiftEdits(shifts, rngFor("s", "x"), 12, 0.2);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(12);
    for (const edit of a) {
      if (edit.kind === "MOVE") {
        expect(["09:30", "08:30"]).toContain(edit.startTime);
        expect(["17:30", "16:30"]).toContain(edit.endTime);
      }
    }
    expect(a.some((e) => e.kind === "MOVE")).toBe(true);
  });
});

describe("unlocks", () => {
  it("picks at most the cap of candidates", () => {
    const keys = Array.from({ length: 300 }, (_, i) => `p${i}`);
    expect(planUnlocks(keys, rngFor("s", "u"), 2, 0.5)).toHaveLength(2);
    expect(planUnlocks([], rngFor("s", "u"))).toEqual([]);
  });
  it("explains a changed closed month only for a deliberately unlocked person and month", () => {
    const unlocks = [{ employeeId: "emp-1", month: "2026-10" }];
    expect(isDeliberateUnlock(unlocks, "closed-changed:snapshots:t/emp-1/2026-10")).toBe(true);
    expect(isDeliberateUnlock(unlocks, "closed-gone:entries:t/emp-1/2026-10")).toBe(true);
    expect(isDeliberateUnlock(unlocks, "closed-changed:entries:t/emp-1/2026-09")).toBe(false);
    expect(isDeliberateUnlock(unlocks, "closed-changed:entries:t/emp-2/2026-10")).toBe(false);
  });
});
