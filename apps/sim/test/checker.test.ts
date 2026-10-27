import { describe, expect, it } from "vitest";
import type { DayLog, Intent, Progress } from "../src/bots/context";
import { emptyProgress } from "../src/bots/context";
import { compareLiveFigures, saldoConsistency } from "../src/checker/invariants-api";
import { compareChecksums, checksumMap } from "../src/checker/invariants-db";
import { isIntended, noServerErrors, tenantIsolationProbes } from "../src/checker/invariants-rules";
import { draftIssue, draftIssues, fileIssues, type Gh } from "../src/checker/issues";
import { judgePerf, monthsBack, periodLimitMs, type TrendLine } from "../src/checker/perf";
import { runInvariants } from "../src/checker/run";
import type { CheckContext, Invariant } from "../src/checker/types";
import { ApiClient, type HttpFetch } from "../src/http";
import { invitationTokenFrom } from "../src/mail";

const live = (balanceHours: number, confirmedMinutes: number, openMonthMinutes: number) => ({
  balanceHours,
  confirmedMinutes,
  openMonthMinutes,
});

describe("saldo.consistent (comparison)", () => {
  it("is green when carry plus open months equals the live saldo on every surface", () => {
    expect(
      compareLiveFigures({
        ledger: live(2.5, 60, 90),
        leaveSurface: live(2.5, 60, 90),
        overview: live(2.5, 60, 90),
        periodClosingMinutes: 150,
      }),
    ).toEqual([]);
  });

  it("is red when the chain does not add up", () => {
    expect(
      compareLiveFigures({
        ledger: live(2.5, 60, 100),
        leaveSurface: null,
        overview: null,
        periodClosingMinutes: null,
      }),
    ).toHaveLength(1);
  });

  it("is red when another surface shows another number, and when the period report drifts", () => {
    const base = { ledger: live(2.5, 60, 90), leaveSurface: null, overview: null };
    expect(
      compareLiveFigures({ ...base, leaveSurface: live(2.0, 60, 60), periodClosingMinutes: null }),
    ).toHaveLength(1);
    expect(
      compareLiveFigures({ ...base, overview: live(2.5, 0, 150), periodClosingMinutes: null }),
    ).toHaveLength(1);
    expect(compareLiveFigures({ ...base, periodClosingMinutes: 140 })).toHaveLength(1);
  });
});

function jsonFetch(routes: Record<string, unknown>): HttpFetch {
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404 });
  };
}

function ctxWith(overrides: Partial<CheckContext>): CheckContext {
  return {
    db: { query: async () => ({ rows: [] }) },
    api: new ApiClient("http://sim.invalid", jsonFetch({})),
    adminToken: "t",
    state: {
      plan: {
        seed: "s",
        epoch: "2026-11-02",
        tenants: [
          {
            key: "chain",
            name: "n",
            slug: "s",
            adminEmail: "a",
            salons: [],
            persons: [{ key: "c0001" } as never],
          },
        ],
      },
      provisionedAt: "",
      tenants: {
        chain: {
          tenantId: "t",
          adminEmail: "",
          adminPassword: "",
          salonIds: [],
          terminalKey: null,
          presenceKey: null,
          persons: {
            c0001: {
              employeeId: "e1",
              userId: "u",
              created: true,
              exited: false,
              anonymized: false,
            },
          },
        },
      },
    },
    progress: emptyProgress(),
    dayLogs: [],
    seed: "s",
    today: "2026-11-10",
    since: new Date(0),
    checksums: { entries: {}, snapshots: {} },
    ...overrides,
  };
}

describe("saldo.consistent (end to end on a fake API)", () => {
  const routes = (periodClosing: number | null) => ({
    "/api/v1/dashboard/overtime-overview": { employees: [{ id: "e1", ...live(1, 30, 30) }] },
    "/api/v1/reports/period": {
      rows: [{ employeeId: "e1", closingBalanceMinutes: periodClosing }],
    },
    "/api/v1/overtime/e1": live(1, 30, 30),
    "/api/v1/leave/overtime-balance": { balanceVisible: true, ...live(1, 30, 30) },
  });

  it("is green and examines the sample when every surface agrees", async () => {
    const ctx = ctxWith({ api: new ApiClient("http://sim.invalid", jsonFetch(routes(60))) });
    const result = await saldoConsistency.run(ctx);
    expect(result.examined).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("is red when the period report disagrees", async () => {
    const ctx = ctxWith({ api: new ApiClient("http://sim.invalid", jsonFetch(routes(75))) });
    const result = await saldoConsistency.run(ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain("e1");
  });
});

describe("months.closed-unchanged (comparison)", () => {
  const row = (month: string, hash: string) => ({ tenant: "t", employee: "e", month, hash });
  it("is green for an identical baseline and for new closed months", () => {
    const before = checksumMap([row("2026-09", "a")]);
    expect(
      compareChecksums("entries", before, checksumMap([row("2026-09", "a"), row("2026-10", "b")])),
    ).toEqual([]);
  });
  it("is red when a closed month changed or disappeared", () => {
    const before = checksumMap([row("2026-09", "a"), row("2026-10", "b")]);
    const findings = compareChecksums("snapshots", before, checksumMap([row("2026-09", "x")]));
    expect(findings.map((f) => f.key.split(":")[0]).sort()).toEqual([
      "closed-changed",
      "closed-gone",
    ]);
  });
});

describe("arbzg intent matching", () => {
  const intent = (date: string): Intent => ({
    date,
    tenant: "chain",
    person: "c0001",
    kind: "LONG_DAY",
  });
  it("explains a finding on the intended day and the day after (an open entry spans midnight)", () => {
    expect(isIntended([intent("2026-11-03")], "c0001", "2026-11-03")).toBe(true);
    expect(isIntended([intent("2026-11-03")], "c0001", "2026-11-04")).toBe(true);
  });
  it("does not explain another person or a later day", () => {
    expect(isIntended([intent("2026-11-03")], "c0002", "2026-11-03")).toBe(false);
    expect(isIntended([intent("2026-11-03")], "c0001", "2026-11-06")).toBe(false);
  });
});

const dayLog = (over: Partial<DayLog>): DayLog => ({
  date: "2026-11-03",
  startedAt: "",
  finishedAt: "",
  actions: { "entry.web": { ok: 3, refused: 0, error: 0, totalMs: 9, maxMs: 4 } },
  anomalies: [],
  isolation: [],
  intents: [],
  ...over,
});

describe("tenant.isolation and api.no-server-errors", () => {
  it("isolation: green when foreign and unknown ids are answered identically", async () => {
    const ctx = ctxWith({
      dayLogs: [
        dayLog({
          isolation: [
            {
              probe: "GET /employees/:id",
              foreignStatus: 404,
              unknownStatus: 404,
              identical: true,
            },
          ],
        }),
      ],
    });
    const r = await tenantIsolationProbes.run(ctx);
    expect(r.examined).toBe(1);
    expect(r.findings).toEqual([]);
  });
  it("isolation: red when a foreign id is answered differently or not with 404", async () => {
    const ctx = ctxWith({
      dayLogs: [
        dayLog({
          isolation: [
            {
              probe: "GET /employees/:id",
              foreignStatus: 403,
              unknownStatus: 404,
              identical: false,
            },
            { probe: "GET /salons/:id", foreignStatus: 200, unknownStatus: 200, identical: true },
          ],
        }),
      ],
    });
    expect((await tenantIsolationProbes.run(ctx)).findings).toHaveLength(2);
  });
  it("server errors: green without anomalies, red with one", async () => {
    expect((await noServerErrors.run(ctxWith({ dayLogs: [dayLog({})] }))).findings).toEqual([]);
    const red = await noServerErrors.run(
      ctxWith({ dayLogs: [dayLog({ anomalies: [{ action: "entry.web", status: 500 }] })] }),
    );
    expect(red.findings).toHaveLength(1);
  });
});

describe("runInvariants", () => {
  const boom: Invariant = {
    id: "x.boom",
    title: "t",
    run: async () => {
      throw new Error("db down");
    },
  };
  const empty: Invariant = {
    id: "x.empty",
    title: "t",
    run: async () => ({ id: "x.empty", title: "t", examined: 0, findings: [] }),
  };
  const mayBe: Invariant = { ...empty, id: "x.maybe", mayBeEmpty: true };

  it("reports a throwing check as an error, never as a pass", async () => {
    const [report] = await runInvariants([boom], ctxWith({}));
    expect(report.status).toBe("error");
  });

  it("turns a check that looked at nothing into a finding once days were simulated", async () => {
    const progress: Progress = { ...emptyProgress(), daysSimulated: ["2026-11-02", "2026-11-03"] };
    const reports = await runInvariants([empty, mayBe], ctxWith({ progress }));
    expect(reports[0].status).toBe("fail");
    expect(reports[0].findings[0].key).toBe("vacuous:x.empty");
    expect(reports[1].status).toBe("pass");
  });

  it("does not complain about emptiness before anything was simulated", async () => {
    expect((await runInvariants([empty], ctxWith({})))[0].status).toBe("pass");
  });
});

describe("performance thresholds and trend", () => {
  const line = (
    metrics: Record<string, number>,
    persons = 300,
    date = "2026-11-10",
  ): TrendLine => ({ date, takenAt: "", persons, metrics });

  it("scales the period limit with the work, capped at the 15 s of #688/#696", () => {
    expect(periodLimitMs(300, 12)).toBe(15_000);
    expect(periodLimitMs(300, 1)).toBe(2_000);
    expect(periodLimitMs(1000, 12)).toBe(15_000);
    expect(periodLimitMs(15, 12)).toBe(2_000);
  });

  it("is green inside the limits and red above them", () => {
    expect(judgePerf(line({ period_12m_ms: 14_000, dashboard_ms: 900 }), [])).toEqual([]);
    const over = judgePerf(line({ period_12m_ms: 16_000 }), []);
    expect(over.map((f) => f.key)).toEqual(["perf:period_12m_ms:limit"]);
    const hard = judgePerf(line({ period_12m_ms: 31_000 }), []).map((f) => f.key);
    expect(hard).toContain("perf:period_12m_ms:hard");
  });

  it("flags a non-200 answer and a doubling against the median of earlier runs", () => {
    expect(judgePerf(line({ dashboard_ms: -500 }), []).map((f) => f.key)).toEqual([
      "perf:dashboard_ms:status",
    ]);
    const history = [1200, 1300, 1250, 1280].map((v, i) =>
      line({ period_1m_ms: v }, 300, `2026-11-0${i + 1}`),
    );
    expect(judgePerf(line({ period_1m_ms: 3_300 }), history).map((f) => f.key)).toContain(
      "perf:period_1m_ms:trend",
    );
    // Above 1 s and above the limit of nothing: a rise below twice the median is not a trend finding.
    expect(judgePerf(line({ period_1m_ms: 1_900 }), history)).toEqual([]);
    expect(judgePerf(line({ period_1m_ms: 1_400 }), history)).toEqual([]);
  });

  it("builds the month windows", () => {
    expect(monthsBack("2026-11-10", 1)).toEqual({ from: "2026-11", to: "2026-11" });
    expect(monthsBack("2026-02-10", 12)).toEqual({ from: "2025-03", to: "2026-02" });
  });
});

describe("issue filing", () => {
  const finding = {
    invariant: "entries.no-overlap",
    key: "overlap:a:b",
    message: "Entries a and b of one person overlap.",
  };

  it("drafts ids-only issues and refuses text that looks like personal data", () => {
    const draft = draftIssue(finding, { date: "2026-11-10", seed: "s" });
    expect(draft.body).toContain("sim-key: overlap:a:b");
    expect(() =>
      draftIssue({ ...finding, message: "mail x@y.de" }, { date: "d", seed: "s" }),
    ).toThrow();
    expect(() =>
      draftIssue({ ...finding, message: "Alpha Bot-C0001" }, { date: "d", seed: "s" }),
    ).toThrow();
  });

  it("files one issue per cause class, not one per row", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({
      invariant: "arbzg.only-intended",
      key: `arbzg:missing-break:${id}:2026-11-03`,
      group: "arbzg:missing-break",
      message: `Employee ${id} has an unplanned finding.`,
    }));
    const drafts = draftIssues([...rows, finding], { date: "d", seed: "s" });
    expect(drafts.map((d) => d.key).sort()).toEqual(["arbzg:missing-break", "overlap:a:b"]);
    const grouped = drafts.find((d) => d.key === "arbzg:missing-break")!;
    expect(grouped.body).toContain("7 occurrences");
    expect(grouped.body).toContain("Employee e has");
    expect(grouped.body).not.toContain("Employee f has"); // the sample is bounded
    expect(grouped.body).toContain("sim-key: arbzg:missing-break");
  });

  it("is a dry run by default: nothing is created", async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return { code: 0, stdout: "[]" };
    };
    const out = await fileIssues([draftIssue(finding, { date: "d", seed: "s" })], {
      repo: "o/r",
      create: false,
      gh,
    });
    expect(out[0].action).toBe("would-create");
    expect(calls.some((c) => c[0] === "label" || (c[0] === "issue" && c[1] === "create"))).toBe(
      false,
    );
  });

  it("creates with the label, and does not file a second issue for an open one", async () => {
    const calls: string[][] = [];
    let open: { number: number; body: string }[] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list")
        return { code: 0, stdout: JSON.stringify(open) };
      if (args[0] === "issue" && args[1] === "create")
        open = [{ number: 7, body: args[args.indexOf("--body") + 1] }];
      return { code: 0, stdout: "" };
    };
    const draft = draftIssue(finding, { date: "d", seed: "s" });
    expect((await fileIssues([draft], { repo: "o/r", create: true, gh }))[0].action).toBe(
      "created",
    );
    expect((await fileIssues([draft], { repo: "o/r", create: true, gh }))[0]).toMatchObject({
      action: "exists",
      number: 7,
    });
    const created = calls.filter((c) => c[0] === "issue" && c[1] === "create");
    expect(created).toHaveLength(1);
    expect(created[0]).toContain("simulation");
  });
});

describe("invitation mail", () => {
  it("extracts the token from the link", () => {
    expect(invitationTokenFrom('<a href="http://x/invitation?token=abc_DEF-123">')).toBe(
      "abc_DEF-123",
    );
    expect(invitationTokenFrom("no link")).toBeNull();
  });
});
