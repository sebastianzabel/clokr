// Unit tests for .github/scripts/build-push-reconcile.mjs (Issue #509).
//
// The reconcile dispatches Build & Push on main for a tip that has no Build & Push run, because a
// push made with GITHUB_TOKEN (the Dependabot auto-merge) starts no workflow. All fixtures below
// are built from the measured first-parent history of main (API data, 2026-10-05 .. 2026-10-08);
// nothing here touches the network or the filesystem.
//
// Run via `pnpm test:scripts` at repo root (see vitest.config.mjs).
import { describe, expect, it } from "vitest";
import {
  BUILD_PUSH_PATH,
  BUILD_PUSH_WORKFLOW_FILE,
  CONFIRM_INTERVAL_MS,
  CONFIRM_TIMEOUT_MS,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_LOOKBACK,
  DISPATCH_REF,
  DISPATCH_SKEW_MS,
  MAX_LOOKBACK,
  classifyCommits,
  decideDispatch,
  decideReconcile,
  findDispatchedRun,
  firstParentChain,
  formatOutputs,
  newestRun,
  parseDispatchResponse,
  parseReconcileArgs,
  renderReport,
  sha7,
  waitForDispatchedRun,
} from "../../.github/scripts/build-push-reconcile.mjs";
import { evaluateBuildPushRuns } from "../../.github/scripts/release-gate.mjs";
import {
  assertReplayableRun,
  selectNewestCompletedRun,
} from "../../.github/scripts/main-red-alarm.mjs";

// ── measured fixtures ────────────────────────────────────────────────────────

const TIP_TODAY = "2fb558b40fc95c6db234f0eb95d9963e54f8fb10";
const TIP_TODAY_PARENT = "73838040451da22e704c6484b2448eab0f2278e7";
const C_7C60 = "7c6018e9011a7e74655ff6005cdf3b97926066f5";
const C_F1FB = "f1fbb71f333b35bea47b228873de90a476d6952e"; // #491, no run
const C_D86F = "d86fe9ebab5879ec48c760a19e9fb2f1ee14047b";
const C_FD6F = "fd6f2858c6ff836b00f4a585e8cca9b49859f424";
const C_9EF3 = "9ef3ac97e2a1d6bbf3d70e9e49ae98be202d7ab9";
const C_5C5B = "5c5b3e200849c874908c94de431a8a2d14c902bd";
const C_E768 = "e7684ced2e97672d5ad0de5f275eae256a973cd7"; // #486, no run
const C_A2BD = "a2bd9c06616afd04b202352e07c3cddff68b46a7"; // #485, no run
const C_9735 = "973553f084d057d9d8fbe08a1213d28da875dab4";
const C_9735_PARENT = "0000000000000000000000000000000000000001"; // outside the fetched slice

/** One item of `GET repos/<repo>/commits` in the API shape. */
function commit(sha, date, login, parent, committerName = "web-flow") {
  return {
    sha,
    commit: { committer: { name: committerName, date }, author: { name: login ?? "Some Name" } },
    author: login ? { login } : null,
    parents: parent ? [{ sha: parent }] : [],
  };
}

const SLICE = [
  commit(C_7C60, "2026-10-06T12:31:23Z", "sebastianzabel", C_F1FB),
  commit(C_F1FB, "2026-10-05T11:06:56Z", "dependabot[bot]", C_D86F),
  commit(C_D86F, "2026-10-05T08:42:16Z", "sebastianzabel", C_FD6F),
  commit(C_FD6F, "2026-10-05T08:24:17Z", "sebastianzabel", C_9EF3),
  commit(C_9EF3, "2026-10-05T08:15:53Z", "sebastianzabel", C_5C5B),
  commit(C_5C5B, "2026-10-05T07:40:16Z", "sebastianzabel", C_E768),
  commit(C_E768, "2026-10-05T05:18:15Z", "dependabot[bot]", C_A2BD),
  commit(C_A2BD, "2026-10-05T04:44:05Z", "dependabot[bot]", C_9735),
  commit(C_9735, "2026-10-03T10:06:02Z", "sebastianzabel", C_9735_PARENT),
];

const TIP_COMMIT = commit(TIP_TODAY, "2026-10-08T11:19:48Z", "sebastianzabel", TIP_TODAY_PARENT);

/** One item of `workflow_runs`, defaulting to a completed push run of build-push.yml on main. */
function run(id, runNumber, headSha, overrides = {}) {
  return {
    id,
    run_number: runNumber,
    run_attempt: 1,
    event: "push",
    head_branch: "main",
    head_sha: headSha,
    status: "completed",
    conclusion: "failure",
    path: BUILD_PUSH_PATH,
    html_url: `https://github.com/sebastianzabel/clokr/actions/runs/${id}`,
    created_at: "2026-10-05T08:00:00Z",
    ...overrides,
  };
}

const RUN_TIP = run(37769323260, 241, TIP_TODAY, { conclusion: "success" });

/** Runs of the slice keyed by head_sha; the three Dependabot commits have none. */
const SLICE_RUNS = new Map([
  [C_7C60, [run(37463857690, 231, C_7C60)]],
  [C_F1FB, []],
  [C_D86F, [run(37285284468, 230, C_D86F)]],
  [C_FD6F, [run(37283419073, 229, C_FD6F)]],
  [C_9EF3, [run(37282555548, 228, C_9EF3)]],
  [C_5C5B, [run(37279044467, 227, C_5C5B)]],
  [C_E768, []],
  [C_A2BD, []],
  [C_9735, [run(37115274408, 226, C_9735)]],
]);

function classifiedSlice(from = 0) {
  return classifyCommits(firstParentChain(SLICE.slice(from)), SLICE_RUNS);
}

// ── constants ────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("pin the workflow, the dispatch ref and the limits", () => {
    expect(BUILD_PUSH_WORKFLOW_FILE).toBe("build-push.yml");
    expect(BUILD_PUSH_PATH).toBe(".github/workflows/build-push.yml");
    expect(DISPATCH_REF).toBe("main");
    expect(DEFAULT_LOOKBACK).toBe(20);
    expect(MAX_LOOKBACK).toBe(100);
    expect(DEFAULT_GRACE_MINUTES).toBe(5);
  });

  it("sha7 abbreviates", () => {
    expect(sha7(C_F1FB)).toBe("f1fbb71");
  });
});

// ── firstParentChain ─────────────────────────────────────────────────────────

describe("firstParentChain", () => {
  it("returns the nine measured commits newest first with sha, date and author", () => {
    const chain = firstParentChain(SLICE);
    expect(chain.map((entry) => entry.sha)).toEqual([
      C_7C60,
      C_F1FB,
      C_D86F,
      C_FD6F,
      C_9EF3,
      C_5C5B,
      C_E768,
      C_A2BD,
      C_9735,
    ]);
    expect(chain[1]).toEqual({
      sha: C_F1FB,
      committedAt: "2026-10-05T11:06:56Z",
      author: "dependabot[bot]",
    });
  });

  it("falls back to the commit author name when the account is unknown", () => {
    const chain = firstParentChain([commit(C_7C60, "2026-10-06T12:31:23Z", null, null)]);
    expect(chain[0].author).toBe("Some Name");
  });

  it("stops at the first parent that is not in the input", () => {
    const chain = firstParentChain([TIP_COMMIT, ...SLICE]);
    expect(chain.map((entry) => entry.sha)).toEqual([TIP_TODAY]);
  });

  it("follows the first parent of a merge commit only", () => {
    const side = "1111111111111111111111111111111111111111";
    const base = "2222222222222222222222222222222222222222";
    const merge = {
      ...commit(C_7C60, "2026-10-06T12:31:23Z", "sebastianzabel", null),
      parents: [{ sha: base }, { sha: side }],
    };
    const sideCommit = commit(side, "2026-10-06T10:00:00Z", "sebastianzabel", base);
    const baseCommit = commit(base, "2026-10-06T09:00:00Z", "sebastianzabel", null);
    const chain = firstParentChain([merge, sideCommit, baseCommit]);
    expect(chain.map((entry) => entry.sha)).toEqual([C_7C60, base]);
  });

  it("returns an empty chain for an empty or missing input", () => {
    expect(firstParentChain([])).toEqual([]);
    expect(firstParentChain(undefined)).toEqual([]);
  });

  it("terminates on a malformed cycle", () => {
    const a = commit(C_7C60, "2026-10-06T12:31:23Z", "x", C_F1FB);
    const b = commit(C_F1FB, "2026-10-05T11:06:56Z", "x", C_7C60);
    expect(firstParentChain([a, b]).map((entry) => entry.sha)).toEqual([C_7C60, C_F1FB]);
  });
});

// ── newestRun / classifyCommits ──────────────────────────────────────────────

describe("newestRun", () => {
  it("picks the highest run_number, ties broken by the higher id", () => {
    const a = run(1, 5, C_7C60);
    const b = run(2, 6, C_7C60);
    const c = run(3, 6, C_7C60);
    expect(newestRun([a, b, c])).toBe(c);
    expect(newestRun([c, b, a])).toBe(c);
    expect(newestRun([])).toBeNull();
  });
});

describe("classifyCommits", () => {
  it("marks exactly the three Dependabot commits as missing", () => {
    const classified = classifiedSlice();
    expect(classified.filter((entry) => entry.missing).map((entry) => entry.sha)).toEqual([
      C_F1FB,
      C_E768,
      C_A2BD,
    ]);
  });

  it("names the nearest newer commit with a run as coveredBy", () => {
    const bySha = Object.fromEntries(classifiedSlice().map((entry) => [entry.sha, entry]));
    expect(bySha[C_F1FB].coveredBy).toBe(C_7C60);
    expect(bySha[C_E768].coveredBy).toBe(C_5C5B);
    expect(bySha[C_A2BD].coveredBy).toBe(C_5C5B);
    expect(bySha[C_7C60].coveredBy).toBeNull();
  });

  it("gives a missing commit without a newer run no coveredBy", () => {
    const classified = classifiedSlice(6); // e7684ced is the tip of this slice
    expect(classified[0].sha).toBe(C_E768);
    expect(classified[0].missing).toBe(true);
    expect(classified[1].sha).toBe(C_A2BD);
    expect(classified[1].coveredBy).toBeNull();
  });

  it("does not count a run of another workflow", () => {
    const runs = new Map([[C_F1FB, [run(9, 1, C_F1FB, { path: ".github/workflows/ci.yml" })]]]);
    const classified = classifyCommits(firstParentChain([SLICE[1]]), runs);
    expect(classified[0].missing).toBe(true);
    expect(classified[0].run).toBeNull();
  });

  it("keeps the newest run as the entry's run", () => {
    const runs = {
      [C_F1FB]: [run(10, 7, C_F1FB), run(11, 8, C_F1FB, { conclusion: "success" })],
    };
    const classified = classifyCommits(firstParentChain([SLICE[1]]), runs);
    expect(classified[0].missing).toBe(false);
    expect(classified[0].run.id).toBe(11);
  });

  it("accepts a plain object as well as a Map and treats an absent key as no run", () => {
    const classified = classifyCommits(firstParentChain([SLICE[1]]), {});
    expect(classified[0].missing).toBe(true);
  });
});

// ── decideReconcile ──────────────────────────────────────────────────────────

describe("decideReconcile", () => {
  it("does nothing today: the tip has run 37769323260", () => {
    const classified = classifyCommits(firstParentChain([TIP_COMMIT]), {
      [TIP_TODAY]: [RUN_TIP],
    });
    const decision = decideReconcile({
      classified,
      nowMs: Date.parse("2026-10-08T12:00:00Z"),
      graceMinutes: 5,
    });
    expect(decision.action).toBe("noop");
    expect(decision.reason).toContain("37769323260");
  });

  it.each([
    ["queued", { status: "queued", conclusion: null }],
    ["in progress", { status: "in_progress", conclusion: null }],
    ["cancelled", { status: "completed", conclusion: "cancelled" }],
    ["failed", { status: "completed", conclusion: "failure" }],
  ])("is idempotent: a tip with a %s run is never dispatched again", (_label, state) => {
    const classified = classifyCommits(firstParentChain([TIP_COMMIT]), {
      [TIP_TODAY]: [run(37769323260, 241, TIP_TODAY, state)],
    });
    const decision = decideReconcile({
      classified,
      nowMs: Date.parse("2026-10-09T12:00:00Z"),
      graceMinutes: 5,
    });
    expect(decision.action).toBe("noop");
  });

  describe("seen red: main as it stood after the #491 merge", () => {
    const classified = () => classifiedSlice(1); // f1fbb71f is the tip, no run

    it("dispatches once the grace period is over", () => {
      const decision = decideReconcile({
        classified: classified(),
        nowMs: Date.parse("2026-10-05T11:12:00Z"),
        graceMinutes: 5,
      });
      expect(decision.action).toBe("dispatch");
      expect(decision.sha).toBe(C_F1FB);
    });

    it("waits while the commit is younger than the grace period", () => {
      const decision = decideReconcile({
        classified: classified(),
        nowMs: Date.parse("2026-10-05T11:09:00Z"),
        graceMinutes: 5,
      });
      expect(decision.action).toBe("wait");
    });

    it("dispatches at exactly the grace age", () => {
      const decision = decideReconcile({
        classified: classified(),
        nowMs: Date.parse("2026-10-05T11:11:56Z"),
        graceMinutes: 5,
      });
      expect(decision.action).toBe("dispatch");
    });

    it("dispatches immediately with a grace of 0", () => {
      const decision = decideReconcile({
        classified: classified(),
        nowMs: Date.parse("2026-10-05T11:07:00Z"),
        graceMinutes: 0,
      });
      expect(decision.action).toBe("dispatch");
    });
  });

  it("dispatches e7684ced and lists a2bd9c06 as missing without a covering run", () => {
    const classified = classifiedSlice(6);
    const decision = decideReconcile({
      classified,
      nowMs: Date.parse("2026-10-05T05:30:00Z"),
      graceMinutes: 5,
    });
    expect(decision.action).toBe("dispatch");
    expect(decision.sha).toBe(C_E768);
    const a2bd = classified.find((entry) => entry.sha === C_A2BD);
    expect(a2bd.missing).toBe(true);
    expect(a2bd.coveredBy).toBeNull();
  });

  it("throws for an empty chain", () => {
    expect(() => decideReconcile({ classified: [], nowMs: 0, graceMinutes: 5 })).toThrow(
      "Keine Commits auf main gefunden.",
    );
  });

  it("throws for an unreadable committer date of a tip without a run", () => {
    const classified = classifyCommits([{ sha: C_F1FB, committedAt: "gestern", author: "x" }], {});
    expect(() => decideReconcile({ classified, nowMs: Date.now(), graceMinutes: 5 })).toThrow(
      /unlesbar/,
    );
  });

  it("waits, never dispatches, for a committer date in the future", () => {
    const classified = classifiedSlice(1);
    const decision = decideReconcile({
      classified,
      nowMs: Date.parse("2026-10-05T10:00:00Z"),
      graceMinutes: 5,
    });
    expect(decision.action).toBe("wait");
  });
});

// ── renderReport ─────────────────────────────────────────────────────────────

describe("renderReport", () => {
  it("lists one OHNE LAUF line per missing commit and the summary line", () => {
    const lines = renderReport(classifiedSlice()).split("\n");
    expect(lines[0]).toBe("Geprüft: 9 Commits auf main (erster Elternteil), neuester zuerst.");
    expect(lines.filter((line) => line.includes("OHNE LAUF"))).toHaveLength(3);
    const f1fb = lines.find((line) => line.startsWith("- f1fbb71 "));
    expect(f1fb).toContain("dependabot[bot]");
    expect(f1fb).toContain("OHNE LAUF");
    expect(f1fb).toContain("Inhalt gebaut im Lauf von 7c6018e");
    expect(lines.find((line) => line.startsWith("- 7c6018e "))).toContain(
      "Lauf 37463857690 (completed/failure)",
    );
    expect(lines.at(-1)).toBe("Ohne Build & Push Lauf: f1fbb71, e7684ce, a2bd9c0");
  });

  it("says so when a missing commit has no newer run yet", () => {
    const lines = renderReport(classifiedSlice(6)).split("\n");
    const a2bd = lines.find((line) => line.startsWith("- a2bd9c0 "));
    expect(a2bd).toContain("noch kein Lauf eines Nachfolgers");
    const tip = lines.find((line) => line.startsWith("- e7684ce "));
    expect(tip).toContain("OHNE LAUF");
    expect(tip).not.toContain("Nachfolgers");
  });

  it("ends with 'keine' when nothing is missing", () => {
    const classified = classifyCommits(firstParentChain([TIP_COMMIT]), {
      [TIP_TODAY]: [RUN_TIP],
    });
    expect(renderReport(classified).split("\n").at(-1)).toBe("Ohne Build & Push Lauf: keine");
  });
});

// ── parseReconcileArgs ───────────────────────────────────────────────────────

describe("parseReconcileArgs", () => {
  it("applies the defaults", () => {
    expect(parseReconcileArgs([], {})).toEqual({
      mode: "decide",
      dryRun: false,
      lookback: 20,
      graceMinutes: 5,
      tip: undefined,
    });
  });

  it("accepts the lookback bounds 1 and 100", () => {
    expect(parseReconcileArgs(["--lookback", "1"], {}).lookback).toBe(1);
    expect(parseReconcileArgs(["--lookback", "100"], {}).lookback).toBe(100);
  });

  it.each(["0", "101", "x", "5;rm", "1.5", ""])("rejects the lookback %j", (value) => {
    expect(() => parseReconcileArgs(["--lookback", value], {})).toThrow(
      "Ungültiger Wert für --lookback",
    );
  });

  it("accepts a grace of 0 and a fraction, rejects negative and non-numeric values", () => {
    expect(parseReconcileArgs(["--grace-minutes", "0"], {}).graceMinutes).toBe(0);
    expect(parseReconcileArgs(["--grace-minutes", "2.5"], {}).graceMinutes).toBe(2.5);
    expect(() => parseReconcileArgs(["--grace-minutes=-1"], {})).toThrow(
      "Ungültiger Wert für --grace-minutes",
    );
    expect(() => parseReconcileArgs(["--grace-minutes", "abc"], {})).toThrow(
      "Ungültiger Wert für --grace-minutes",
    );
  });

  it("accepts a replay tip together with --dry-run", () => {
    const args = parseReconcileArgs(["--tip", C_F1FB, "--dry-run"], {});
    expect(args.tip).toBe(C_F1FB);
    expect(args.dryRun).toBe(true);
  });

  it("rejects an uppercase or abbreviated tip", () => {
    expect(() => parseReconcileArgs(["--tip", C_F1FB.toUpperCase(), "--dry-run"], {})).toThrow(
      "Ungültige SHA",
    );
    expect(() => parseReconcileArgs(["--tip", "f1fbb71", "--dry-run"], {})).toThrow(
      "Ungültige SHA",
    );
  });

  it("rejects --tip without --dry-run: a dispatch always targets the real tip of main", () => {
    expect(() => parseReconcileArgs(["--tip", C_F1FB], {})).toThrow("--dry-run");
  });

  it("rejects an unknown option", () => {
    expect(() => parseReconcileArgs(["--force"], {})).toThrow("Ungültiger Aufruf");
  });
});

// ── formatOutputs ────────────────────────────────────────────────────────────

describe("formatOutputs", () => {
  it("renders the GITHUB_OUTPUT lines", () => {
    expect(formatOutputs({ dispatch: true, sha: C_F1FB })).toBe(`dispatch=true\nsha=${C_F1FB}\n`);
    expect(formatOutputs({ dispatch: false })).toBe("dispatch=false\nsha=\n");
  });
});

// ── a dispatched run is an ordinary Build & Push run for gate and alarm ──────

describe("dispatched run seen by the release gate and the main-red alarm", () => {
  const dispatched = run(37800000001, 242, C_F1FB, {
    event: "workflow_dispatch",
    conclusion: "success",
  });

  it("counts as success for the release gate", () => {
    expect(evaluateBuildPushRuns([dispatched]).state).toBe("success");
  });

  it("is the newest completed run for the alarm and can be replayed", () => {
    const newest = selectNewestCompletedRun([RUN_TIP, dispatched]);
    expect(newest.id).toBe(dispatched.id);
    expect(() => assertReplayableRun(dispatched)).not.toThrow();
  });
});

// ── dispatch path ────────────────────────────────────────────────────────────

describe("decideDispatch", () => {
  it("skips when main moved on and names the new tip", () => {
    const decision = decideDispatch({
      expectedSha: C_F1FB,
      mainTipSha: TIP_TODAY,
      runsForExpected: [],
    });
    expect(decision.action).toBe("skip");
    expect(decision.reason).toContain("main steht inzwischen auf");
    expect(decision.reason).toContain(sha7(TIP_TODAY));
  });

  it("skips when a Build & Push run appeared in the meantime and names it", () => {
    const decision = decideDispatch({
      expectedSha: TIP_TODAY,
      mainTipSha: TIP_TODAY,
      runsForExpected: [RUN_TIP],
    });
    expect(decision.action).toBe("skip");
    expect(decision.reason).toContain("37769323260");
  });

  it("dispatches while the expected commit is still the tip and has no run", () => {
    const decision = decideDispatch({
      expectedSha: TIP_TODAY,
      mainTipSha: TIP_TODAY,
      runsForExpected: [],
    });
    expect(decision.action).toBe("dispatch");
  });

  it("ignores a run of another workflow", () => {
    const decision = decideDispatch({
      expectedSha: TIP_TODAY,
      mainTipSha: TIP_TODAY,
      runsForExpected: [run(9, 1, TIP_TODAY, { path: ".github/workflows/ci.yml" })],
    });
    expect(decision.action).toBe("dispatch");
  });
});

describe("parseDispatchResponse", () => {
  it("returns the run id of a 200 answer", () => {
    expect(
      parseDispatchResponse('{"workflow_run_id":37800000001,"run_url":"u","html_url":"h"}'),
    ).toBe(37800000001);
  });

  it.each([
    ["an empty body (204)", ""],
    ["whitespace", "  \n"],
    ["text that is not JSON", "not json"],
    ["a string id", '{"workflow_run_id":"12"}'],
    ["a zero id", '{"workflow_run_id":0}'],
  ])("returns null for %s", (_label, raw) => {
    expect(parseDispatchResponse(raw)).toBeNull();
  });
});

describe("findDispatchedRun", () => {
  const SINCE = Date.parse("2026-10-08T12:00:00Z");
  const dispatched = (id, runNumber, overrides = {}) =>
    run(id, runNumber, TIP_TODAY, {
      event: "workflow_dispatch",
      status: "queued",
      conclusion: null,
      created_at: "2026-10-08T12:00:05Z",
      ...overrides,
    });

  it("returns the newest matching dispatched run", () => {
    const found = findDispatchedRun([dispatched(1, 242), dispatched(2, 243)], { sinceMs: SINCE });
    expect(found.id).toBe(2);
  });

  it("ignores push runs, other branches, other workflows and stale runs", () => {
    const runs = [
      run(10, 250, TIP_TODAY, { created_at: "2026-10-08T12:00:05Z" }),
      dispatched(11, 251, { head_branch: "release/1.9.x" }),
      dispatched(12, 252, { path: ".github/workflows/ci.yml" }),
      dispatched(13, 253, { created_at: "2026-10-08T11:58:00Z" }),
    ];
    expect(findDispatchedRun(runs, { sinceMs: SINCE })).toBeNull();
  });

  it("accepts a run created up to 60 seconds before the dispatch (clock skew)", () => {
    const found = findDispatchedRun([dispatched(1, 242, { created_at: "2026-10-08T11:59:30Z" })], {
      sinceMs: SINCE,
    });
    expect(found.id).toBe(1);
  });

  it("returns null for an empty list", () => {
    expect(findDispatchedRun([], { sinceMs: SINCE })).toBeNull();
  });
});

describe("waitForDispatchedRun", () => {
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    };
  }

  it("finds the run on the third attempt", async () => {
    const { now, sleep } = clock();
    let calls = 0;
    const result = await waitForDispatchedRun({
      fetchRuns: async () => {
        calls += 1;
        return calls < 3
          ? []
          : [
              run(7, 242, TIP_TODAY, {
                event: "workflow_dispatch",
                created_at: "2026-10-08T12:00:05Z",
              }),
            ];
      },
      sleep,
      now,
      sinceMs: Date.parse("2026-10-08T12:00:00Z"),
    });
    expect(result.attempts).toBe(3);
    expect(result.run.id).toBe(7);
  });

  it("gives up after the timeout with 19 attempts", async () => {
    const { now, sleep } = clock();
    const result = await waitForDispatchedRun({
      fetchRuns: async () => [],
      sleep,
      now,
      sinceMs: 0,
    });
    expect(result.run).toBeNull();
    expect(result.attempts).toBe(19);
    expect(CONFIRM_TIMEOUT_MS).toBe(180000);
    expect(CONFIRM_INTERVAL_MS).toBe(10000);
    expect(DISPATCH_SKEW_MS).toBe(60000);
  });

  it("lets an API error propagate instead of reporting success", async () => {
    const { now, sleep } = clock();
    await expect(
      waitForDispatchedRun({
        fetchRuns: async () => {
          throw new Error("API down");
        },
        sleep,
        now,
        sinceMs: 0,
      }),
    ).rejects.toThrow("API down");
  });
});

describe("parseReconcileArgs --dispatch", () => {
  it("selects dispatch mode for a valid sha", () => {
    const args = parseReconcileArgs(["--dispatch", TIP_TODAY], { GITHUB_ACTIONS: "true" });
    expect(args.mode).toBe("dispatch");
    expect(args.sha).toBe(TIP_TODAY);
    expect(args.dryRun).toBe(false);
  });

  it("rejects an invalid sha", () => {
    expect(() => parseReconcileArgs(["--dispatch", "x;y", "--dry-run"], {})).toThrow(
      "Ungültige SHA",
    );
  });

  it("rejects --dispatch combined with --tip or --lookback", () => {
    expect(() =>
      parseReconcileArgs(["--dispatch", TIP_TODAY, "--tip", C_F1FB, "--dry-run"], {}),
    ).toThrow("Ungültiger Aufruf");
    expect(() =>
      parseReconcileArgs(["--dispatch", TIP_TODAY, "--lookback", "5", "--dry-run"], {}),
    ).toThrow("Ungültiger Aufruf");
  });

  it("refuses to write outside GitHub Actions", () => {
    expect(() => parseReconcileArgs(["--dispatch", TIP_TODAY], {})).toThrow(
      "nur innerhalb des Workflows",
    );
    expect(() =>
      parseReconcileArgs(["--dispatch", TIP_TODAY], { GITHUB_ACTIONS: "false" }),
    ).toThrow("nur innerhalb des Workflows");
  });

  it("accepts a dry run anywhere and a real run inside GitHub Actions", () => {
    expect(parseReconcileArgs(["--dispatch", TIP_TODAY, "--dry-run"], {}).dryRun).toBe(true);
    expect(parseReconcileArgs(["--dispatch", TIP_TODAY], { GITHUB_ACTIONS: "true" }).mode).toBe(
      "dispatch",
    );
  });
});
