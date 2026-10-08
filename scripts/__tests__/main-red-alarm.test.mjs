// Unit tests for .github/scripts/main-red-alarm.mjs (Issue #507).
//
// The alarm keeps exactly one open issue "main ist rot" in sync with the newest completed
// Build & Push run on main. All tests use inline fixtures built from measured real runs and
// jobs (2026-10-08); nothing here touches the network or the filesystem.
//
// Run via `pnpm test:scripts` at repo root (see vitest.config.mjs).
import { describe, expect, it } from "vitest";
import {
  ALARM_LABEL,
  ALARM_TITLE,
  BUILD_PUSH_PATH,
  BUILD_PUSH_WORKFLOW_FILE,
  RED_CONCLUSIONS,
  assertReplayableRun,
  decideAlarmAction,
  failedJobsOf,
  findOpenAlarmIssue,
  parseAlarmArgs,
  renderCloseText,
  renderFailureText,
  runMarker,
  selectNewestCompletedRun,
} from "../../.github/scripts/main-red-alarm.mjs";

function run(overrides) {
  return {
    id: 1,
    run_number: 1,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: "7383804aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    path: BUILD_PUSH_PATH,
    html_url: "https://github.com/sebastianzabel/clokr/actions/runs/1",
    ...overrides,
  };
}

const RED = run({
  id: 37741813653,
  run_number: 238,
  conclusion: "failure",
  head_sha: "461778b0000000000000000000000000000000aa",
  html_url: "https://github.com/sebastianzabel/clokr/actions/runs/37741813653",
});
const GREEN = run({
  id: 37748536384,
  run_number: 240,
  conclusion: "success",
  head_sha: "73838040451da22e704c6484b2448eab0f2278e7",
  html_url: "https://github.com/sebastianzabel/clokr/actions/runs/37748536384",
});

const JOBS = [
  {
    name: "build-push (clokr-api, ./apps/api/Dockerfile, .)",
    conclusion: "failure",
    html_url: "https://github.com/sebastianzabel/clokr/actions/runs/37741813653/job/1",
    steps: [
      { name: "Build and push", conclusion: "success" },
      { name: "Scan container image with Trivy", conclusion: "failure" },
      { name: "Upload Trivy SARIF", conclusion: "skipped" },
    ],
  },
  {
    name: "build-push (clokr-web, ./apps/web/Dockerfile, .)",
    conclusion: "success",
    html_url: "https://github.com/sebastianzabel/clokr/actions/runs/37741813653/job/2",
    steps: [{ name: "Build and push", conclusion: "success" }],
  },
];

const OPEN_ISSUE = {
  number: 508,
  title: ALARM_TITLE,
  state: "open",
  labels: [{ name: ALARM_LABEL }],
  html_url: "https://github.com/sebastianzabel/clokr/issues/508",
  body: "",
};

describe("constants", () => {
  it("pins title, label, workflow file and red conclusions", () => {
    expect(ALARM_TITLE).toBe("main ist rot");
    expect(ALARM_LABEL).toBe("bug");
    expect(BUILD_PUSH_WORKFLOW_FILE).toBe("build-push.yml");
    expect(BUILD_PUSH_PATH).toBe(".github/workflows/build-push.yml");
    expect([...RED_CONCLUSIONS].sort()).toEqual(["failure", "startup_failure", "timed_out"]);
  });
});

describe("runMarker", () => {
  it("renders the per-run-attempt marker", () => {
    expect(runMarker({ id: 37741813653, run_attempt: 1 })).toBe(
      "<!-- main-red-alarm:run=37741813653:attempt=1 -->",
    );
  });

  it("defaults the attempt to 1", () => {
    expect(runMarker({ id: 5 })).toBe("<!-- main-red-alarm:run=5:attempt=1 -->");
  });
});

describe("decideAlarmAction", () => {
  it("creates an issue for a red run when none is open", () => {
    expect(decideAlarmAction({ run: RED, openIssue: null, reportedTexts: [] }).action).toBe(
      "create",
    );
  });

  it("comments on the open issue for a red run it has not reported yet", () => {
    const decision = decideAlarmAction({
      run: RED,
      openIssue: OPEN_ISSUE,
      reportedTexts: ["something else"],
    });
    expect(decision.action).toBe("comment");
    expect(decision.reason).toMatch(/[a-zäöü]/);
  });

  it("does nothing when the run is already reported (marker in body or comment)", () => {
    const decision = decideAlarmAction({
      run: RED,
      openIssue: OPEN_ISSUE,
      reportedTexts: ["intro", `text\n${runMarker(RED)}`],
    });
    expect(decision.action).toBe("noop");
  });

  it("comments again for a new attempt of an already reported run", () => {
    const reported = [runMarker({ id: RED.id, run_attempt: 1 })];
    const decision = decideAlarmAction({
      run: { ...RED, run_attempt: 2 },
      openIssue: OPEN_ISSUE,
      reportedTexts: reported,
    });
    expect(decision.action).toBe("comment");
  });

  it.each(["timed_out", "startup_failure"])("treats %s like failure", (conclusion) => {
    expect(
      decideAlarmAction({ run: { ...RED, conclusion }, openIssue: null, reportedTexts: [] }).action,
    ).toBe("create");
  });

  it("closes the open issue on a green run", () => {
    expect(decideAlarmAction({ run: GREEN, openIssue: OPEN_ISSUE, reportedTexts: [] }).action).toBe(
      "close",
    );
  });

  it("does nothing on a green run without an open issue", () => {
    expect(decideAlarmAction({ run: GREEN, openIssue: null, reportedTexts: [] }).action).toBe(
      "noop",
    );
  });

  it.each(["cancelled", "skipped", "neutral", "action_required", "stale"])(
    "leaves the issue untouched on conclusion %s",
    (conclusion) => {
      const decision = decideAlarmAction({
        run: { ...GREEN, conclusion },
        openIssue: OPEN_ISSUE,
        reportedTexts: [],
      });
      expect(decision.action).toBe("noop");
    },
  );

  it("does nothing without a run", () => {
    expect(decideAlarmAction({ run: null, openIssue: OPEN_ISSUE, reportedTexts: [] }).action).toBe(
      "noop",
    );
  });

  it("does nothing for a run that is not completed", () => {
    const pending = run({ status: "in_progress", conclusion: null });
    expect(decideAlarmAction({ run: pending, openIssue: null, reportedTexts: [] }).action).toBe(
      "noop",
    );
  });
});

describe("findOpenAlarmIssue", () => {
  const issue = (overrides) => ({ ...OPEN_ISSUE, ...overrides });

  it("matches the exact title with label bug", () => {
    expect(findOpenAlarmIssue([issue({ number: 7 })]).number).toBe(7);
  });

  it("ignores pull requests", () => {
    expect(findOpenAlarmIssue([issue({ pull_request: { url: "x" } })])).toBeNull();
  });

  it("ignores titles that merely start with the alarm title", () => {
    expect(
      findOpenAlarmIssue([issue({ title: "main ist rot: team-calendar-visibility.ts rot" })]),
    ).toBeNull();
  });

  it("ignores issues without the bug label", () => {
    expect(findOpenAlarmIssue([issue({ labels: [{ name: "chore" }] })])).toBeNull();
  });

  it("ignores closed issues", () => {
    expect(findOpenAlarmIssue([issue({ state: "closed" })])).toBeNull();
  });

  it("picks the lowest number when two match", () => {
    expect(
      findOpenAlarmIssue([issue({ number: 30 }), issue({ number: 12 }), issue({ number: 99 })])
        .number,
    ).toBe(12);
  });

  it("returns null for an empty list", () => {
    expect(findOpenAlarmIssue([])).toBeNull();
  });
});

describe("selectNewestCompletedRun", () => {
  it("picks the highest run_number among completed main runs of build-push.yml", () => {
    const inProgress = run({ id: 9, run_number: 241, status: "in_progress", conclusion: null });
    const older = run({ id: 3, run_number: 238, conclusion: "failure" });
    const newer = run({ id: 4, run_number: 240, conclusion: "success" });
    expect(selectNewestCompletedRun([older, inProgress, newer]).id).toBe(4);
    expect(selectNewestCompletedRun([newer, inProgress, older]).id).toBe(4);
  });

  it("ignores other branches and other workflows", () => {
    const wrongBranch = run({ id: 8, run_number: 300, head_branch: "release/1.9.x" });
    const wrongPath = run({ id: 7, run_number: 299, path: ".github/workflows/ci.yml" });
    const good = run({ id: 6, run_number: 10 });
    expect(selectNewestCompletedRun([wrongBranch, wrongPath, good]).id).toBe(6);
  });

  it("breaks run_number ties by the higher id", () => {
    const a = run({ id: 20, run_number: 5 });
    const b = run({ id: 21, run_number: 5 });
    expect(selectNewestCompletedRun([a, b]).id).toBe(21);
  });

  it("returns null when nothing qualifies", () => {
    expect(selectNewestCompletedRun([])).toBeNull();
    expect(selectNewestCompletedRun([run({ status: "queued", conclusion: null })])).toBeNull();
  });
});

describe("assertReplayableRun", () => {
  it("accepts a completed main run of build-push.yml", () => {
    expect(() => assertReplayableRun(RED)).not.toThrow();
  });

  it("rejects a run from a release branch", () => {
    expect(() => assertReplayableRun({ ...RED, head_branch: "release/1.9.x" })).toThrow(/main/);
  });

  it("rejects a run of another workflow", () => {
    expect(() => assertReplayableRun({ ...RED, path: ".github/workflows/ci.yml" })).toThrow(
      /Build & Push/,
    );
  });

  it("rejects a run that is not completed", () => {
    expect(() => assertReplayableRun({ ...RED, status: "in_progress" })).toThrow(/abgeschlossen/);
  });
});

describe("failedJobsOf", () => {
  it("keeps only failed jobs with their failing step names", () => {
    const failed = failedJobsOf(JOBS);
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe("build-push (clokr-api, ./apps/api/Dockerfile, .)");
    expect(failed[0].steps).toEqual(["Scan container image with Trivy"]);
    expect(failed[0].html_url).toContain("/job/1");
  });

  it("treats timed_out jobs as failed and tolerates missing steps", () => {
    const failed = failedJobsOf([{ name: "j", conclusion: "timed_out", html_url: "u" }]);
    expect(failed).toEqual([{ name: "j", html_url: "u", steps: [] }]);
  });
});

describe("renderFailureText", () => {
  it("renders the create body with run, sha, failed job, failing step and marker", () => {
    const text = renderFailureText(RED, failedJobsOf(JOBS), "create");
    expect(text).toContain(RED.html_url);
    expect(text).toContain("461778b");
    expect(text).toContain("build-push (clokr-api, ./apps/api/Dockerfile, .)");
    expect(text).toContain("Scan container image with Trivy");
    expect(text).not.toContain("clokr-web");
    expect(text).toContain("docs/release-process.md");
    expect(text.trimEnd().endsWith(runMarker(RED))).toBe(true);
  });

  it("opens differently for a comment and still ends with the marker", () => {
    const create = renderFailureText(RED, failedJobsOf(JOBS), "create");
    const comment = renderFailureText(RED, failedJobsOf(JOBS), "comment");
    expect(comment.split("\n")[0]).not.toBe(create.split("\n")[0]);
    expect(comment).toMatch(/Erneut fehlgeschlagen/);
    expect(comment.trimEnd().endsWith(runMarker(RED))).toBe(true);
  });

  it("says when no job details are available", () => {
    expect(renderFailureText(RED, [], "create")).toContain("keine Job-Details verfügbar");
  });

  it("mentions the attempt only when it is above 1", () => {
    expect(renderFailureText(RED, [], "create")).not.toMatch(/Versuch/);
    expect(renderFailureText({ ...RED, run_attempt: 2 }, [], "create")).toMatch(/Versuch 2/);
  });
});

describe("renderCloseText", () => {
  it("links the green run and says main is green again", () => {
    const text = renderCloseText(GREEN);
    expect(text).toContain(GREEN.html_url);
    expect(text).toContain("wieder grün");
    expect(text).toContain("7383804");
  });
});

describe("parseAlarmArgs", () => {
  it("defaults to a live reconcile", () => {
    expect(parseAlarmArgs([])).toEqual({ runId: undefined, dryRun: false });
  });

  it("accepts a numeric run id and --dry-run", () => {
    expect(parseAlarmArgs(["--run-id", "37741813653", "--dry-run"])).toEqual({
      runId: "37741813653",
      dryRun: true,
    });
  });

  it("rejects non-numeric run ids with a German error", () => {
    expect(() => parseAlarmArgs(["--run-id", "abc"])).toThrow(/Lauf-ID/);
    expect(() => parseAlarmArgs(["--run-id", "1;rm"])).toThrow(/Lauf-ID/);
    expect(() => parseAlarmArgs(["--run-id", ""])).toThrow(/Lauf-ID/);
  });

  it("rejects unknown options in German", () => {
    expect(() => parseAlarmArgs(["--bogus"])).toThrow(/Aufruf/);
  });
});
