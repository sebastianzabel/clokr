import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDayPreviewRequest,
  createDayPreviewRunner,
  type DayPreviewRequest,
  type DayPreviewResponse,
} from "../day-break-preview";
import type { DayCheckWarning } from "../day-break-violation";

// Issue #511 D-18: the entry form asks the server kernel which findings the proposed entry would
// produce. These tests pin the request the form sends and the two guarantees the runner gives the
// page: one request per pause in typing (T-511-40) and never an outdated answer on screen
// (T-511-41).

const EMPLOYEE = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";

function warning(code: string): DayCheckWarning {
  return { code, severity: "warning", message: `Text ${code}` };
}

function request(startISO = "2026-03-10T08:00:00.000Z"): DayPreviewRequest {
  const body = buildDayPreviewRequest({
    employeeId: EMPLOYEE,
    date: "2026-03-10",
    entryId: undefined,
    startISO,
    endISO: "2026-03-10T16:00:00.000Z",
    breaks: [],
  });
  if (!body) throw new Error("fixture request must be valid");
  return body;
}

describe("buildDayPreviewRequest", () => {
  it("carries exactly what the save would send", () => {
    const breaks = [{ startTime: "2026-03-10T11:00:00.000Z", endTime: "2026-03-10T11:30:00.000Z" }];
    const body = buildDayPreviewRequest({
      employeeId: EMPLOYEE,
      date: "2026-03-10",
      entryId: ENTRY,
      startISO: "2026-03-10T08:00:00.000Z",
      endISO: "2026-03-10T17:00:00.000Z",
      breaks,
      breakMinutes: 30,
    });
    expect(body).toEqual({
      employeeId: EMPLOYEE,
      date: "2026-03-10",
      entryId: ENTRY,
      startTime: "2026-03-10T08:00:00.000Z",
      endTime: "2026-03-10T17:00:00.000Z",
      breaks,
      breakMinutes: 30,
    });
  });

  it("omits the entry id for a new entry and defaults the legacy minutes to none", () => {
    const body = request();
    expect("entryId" in body).toBe(false);
    expect(body.breakMinutes).toBeUndefined();
    expect(body.breaks).toEqual([]);
  });

  it("is null while the entry has no end", () => {
    expect(
      buildDayPreviewRequest({
        employeeId: EMPLOYEE,
        date: "2026-03-10",
        startISO: "2026-03-10T08:00:00.000Z",
        endISO: null,
        breaks: [],
      }),
    ).toBeNull();
  });

  it("is null when the end is not after the start", () => {
    for (const endISO of ["2026-03-10T08:00:00.000Z", "2026-03-10T07:00:00.000Z"]) {
      expect(
        buildDayPreviewRequest({
          employeeId: EMPLOYEE,
          date: "2026-03-10",
          startISO: "2026-03-10T08:00:00.000Z",
          endISO,
          breaks: [],
        }),
      ).toBeNull();
    }
  });
});

describe("createDayPreviewRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues one request for two calls inside the delay, with the latest body", async () => {
    const post = vi.fn(async (): Promise<DayPreviewResponse> => ({
      warnings: [warning("BREAK_TOO_SHORT")],
      autoBreakApplied: null,
    }));
    const runner = createDayPreviewRunner(post, 300);
    const onResult = vi.fn();

    runner.request(request("2026-03-10T07:00:00.000Z"), onResult);
    vi.advanceTimersByTime(100);
    runner.request(request("2026-03-10T08:00:00.000Z"), onResult);
    await vi.advanceTimersByTimeAsync(300);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/day-breaks/preview",
      expect.objectContaining({ startTime: "2026-03-10T08:00:00.000Z" }),
    );
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith([warning("BREAK_TOO_SHORT")], null);
  });

  it("passes the automatic break the save would place on to the caller", async () => {
    const autoBreak = {
      start: "2026-03-10T11:00:00.000Z",
      end: "2026-03-10T11:30:00.000Z",
      minutes: 30,
    };
    const runner = createDayPreviewRunner(
      async () => ({ warnings: [], autoBreakApplied: autoBreak }),
      10,
    );
    const onResult = vi.fn();
    runner.request(request(), onResult);
    await vi.advanceTimersByTimeAsync(10);
    expect(onResult).toHaveBeenCalledWith([], autoBreak);
  });

  it("drops the answer of an older request that resolves after a newer one", async () => {
    const resolvers: Array<(r: DayPreviewResponse) => void> = [];
    const post = vi.fn(
      () =>
        new Promise<DayPreviewResponse>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const runner = createDayPreviewRunner(post, 50);
    const onResult = vi.fn();

    runner.request(request("2026-03-10T07:00:00.000Z"), onResult);
    await vi.advanceTimersByTimeAsync(50);
    runner.request(request("2026-03-10T08:00:00.000Z"), onResult);
    await vi.advanceTimersByTimeAsync(50);
    expect(post).toHaveBeenCalledTimes(2);

    // The newer answer arrives first, the older one afterwards.
    resolvers[1]({ warnings: [warning("NEWER")], autoBreakApplied: null });
    await vi.advanceTimersByTimeAsync(0);
    resolvers[0]({ warnings: [warning("OLDER")], autoBreakApplied: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith([warning("NEWER")], null);
  });

  it("drops the failure of an outdated request as well", async () => {
    const settle: Array<{
      resolve: (r: DayPreviewResponse) => void;
      reject: (e: unknown) => void;
    }> = [];
    const post = vi.fn(
      () =>
        new Promise<DayPreviewResponse>((resolve, reject) => {
          settle.push({ resolve, reject });
        }),
    );
    const runner = createDayPreviewRunner(post, 50);
    const onResult = vi.fn();

    runner.request(request("2026-03-10T07:00:00.000Z"), onResult);
    await vi.advanceTimersByTimeAsync(50);
    runner.request(request("2026-03-10T08:00:00.000Z"), onResult);
    await vi.advanceTimersByTimeAsync(50);

    settle[1].resolve({ warnings: [warning("NEWER")], autoBreakApplied: null });
    await vi.advanceTimersByTimeAsync(0);
    settle[0].reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith([warning("NEWER")], null);
  });

  it("answers a rejected request with no findings", async () => {
    const runner = createDayPreviewRunner(async () => {
      throw new Error("offline");
    }, 10);
    const onResult = vi.fn();
    runner.request(request(), onResult);
    await vi.advanceTimersByTimeAsync(10);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith([], null);
  });

  it("clears at once on a null body, cancels the pending call and ignores an in-flight answer", async () => {
    let resolveFirst: (r: DayPreviewResponse) => void = () => {};
    const post = vi.fn(
      () =>
        new Promise<DayPreviewResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const runner = createDayPreviewRunner(post, 50);
    const onResult = vi.fn();

    // Pending call cancelled before it fired.
    runner.request(request(), onResult);
    runner.request(null, onResult);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenLastCalledWith([], null);
    await vi.advanceTimersByTimeAsync(100);
    expect(post).not.toHaveBeenCalled();

    // In-flight call outdated by a null body.
    onResult.mockClear();
    runner.request(request(), onResult);
    await vi.advanceTimersByTimeAsync(50);
    runner.request(null, onResult);
    resolveFirst({ warnings: [warning("LATE")], autoBreakApplied: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenLastCalledWith([], null);
  });

  it("dispose() stops everything: no pending call fires, no in-flight answer arrives", async () => {
    let resolveFirst: (r: DayPreviewResponse) => void = () => {};
    const post = vi.fn(
      () =>
        new Promise<DayPreviewResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const runner = createDayPreviewRunner(post, 50);
    const onResult = vi.fn();

    runner.request(request(), onResult);
    runner.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(post).not.toHaveBeenCalled();

    runner.request(request(), onResult);
    await vi.advanceTimersByTimeAsync(50);
    runner.dispose();
    resolveFirst({ warnings: [warning("LATE")], autoBreakApplied: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).not.toHaveBeenCalled();
  });
});
