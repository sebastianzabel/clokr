// Unit tests for .github/scripts/release-gate.mjs (Issue #507).
//
// The gate decides whether release.yml's `promote` job may start: the newest Build & Push run
// of the tagged commit must be `success`. Everything here runs against inline fixtures shaped
// like real `workflow_runs` rows and a fake clock (the injected `sleep` advances `now`), so no
// real timer, network or filesystem is touched.
//
// Run via `pnpm test:scripts` at repo root (see vitest.config.mjs).
import { describe, expect, it, vi } from "vitest";
import {
  BUILD_PUSH_WORKFLOW_FILE,
  TAG_PATTERN,
  evaluateBuildPushRuns,
  formatOutcome,
  parseGateArgs,
  waitForGreenBuild,
} from "../../.github/scripts/release-gate.mjs";

const SHA_V1150 = "d796cf64e0c1f5a2b3c4d5e6f708192a3b4c5d6e";
const SHA_V1130 = "57070ccf0123456789abcdef0123456789abcdef";

function run(overrides) {
  return {
    id: 1,
    run_number: 1,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: SHA_V1130,
    path: ".github/workflows/build-push.yml",
    html_url: "https://github.com/sebastianzabel/clokr/actions/runs/1",
    ...overrides,
  };
}

// Measured real rows (2026-10-08).
const GREEN_V1130 = run({
  id: 36645865343,
  run_number: 200,
  conclusion: "success",
  head_sha: SHA_V1130,
  html_url: "https://github.com/sebastianzabel/clokr/actions/runs/36645865343",
});
const RED_V1150 = run({
  id: 37606026405,
  run_number: 236,
  conclusion: "failure",
  head_sha: SHA_V1150,
  html_url: "https://github.com/sebastianzabel/clokr/actions/runs/37606026405",
});

describe("evaluateBuildPushRuns", () => {
  it("reports an empty list as missing", () => {
    expect(evaluateBuildPushRuns([]).state).toBe("missing");
  });

  it("reports a completed success run as success and carries the run", () => {
    const result = evaluateBuildPushRuns([GREEN_V1130]);
    expect(result.state).toBe("success");
    expect(result.run.id).toBe(36645865343);
  });

  it("reports a completed failure run as failed", () => {
    const result = evaluateBuildPushRuns([RED_V1150]);
    expect(result.state).toBe("failed");
    expect(result.run.run_number).toBe(236);
  });

  it.each([
    "cancelled",
    "timed_out",
    "startup_failure",
    "action_required",
    "neutral",
    "skipped",
    "stale",
  ])("fails closed on conclusion %s", (conclusion) => {
    expect(evaluateBuildPushRuns([run({ conclusion })]).state).toBe("failed");
  });

  it("fails closed on a completed run without any conclusion", () => {
    expect(evaluateBuildPushRuns([run({ conclusion: null })]).state).toBe("failed");
  });

  it.each(["queued", "in_progress", "waiting", "requested", "pending"])(
    "reports status %s as pending",
    (status) => {
      expect(evaluateBuildPushRuns([run({ status, conclusion: null })]).state).toBe("pending");
    },
  );

  it("lets the newest run win regardless of array order", () => {
    const green235 = run({ id: 235, run_number: 235, conclusion: "success" });
    const red236 = run({ id: 236, run_number: 236, conclusion: "failure" });
    const green237 = run({ id: 237, run_number: 237, conclusion: "success" });
    expect(evaluateBuildPushRuns([green235, red236]).state).toBe("failed");
    expect(evaluateBuildPushRuns([red236, green235]).state).toBe("failed");
    expect(evaluateBuildPushRuns([red236, green237]).state).toBe("success");
    expect(evaluateBuildPushRuns([green237, red236]).state).toBe("success");
  });

  it("breaks run_number ties by the higher id", () => {
    const low = run({ id: 10, run_number: 5, conclusion: "success" });
    const high = run({ id: 11, run_number: 5, conclusion: "failure" });
    expect(evaluateBuildPushRuns([low, high]).state).toBe("failed");
    expect(evaluateBuildPushRuns([high, low]).state).toBe("failed");
    const highGreen = run({ id: 12, run_number: 5, conclusion: "success" });
    expect(evaluateBuildPushRuns([high, highGreen]).state).toBe("success");
  });

  it("does not filter by branch or event", () => {
    const maintenance = run({ head_branch: "release/1.9.x", event: "push", conclusion: "success" });
    expect(evaluateBuildPushRuns([maintenance]).state).toBe("success");
  });
});

// Fake clock: sleep advances now; no real timer is ever started.
function fakeClock() {
  const state = { t: 0, sleeps: [] };
  return {
    state,
    now: () => state.t,
    sleep: vi.fn(async (ms) => {
      state.sleeps.push(ms);
      state.t += ms;
    }),
  };
}

const MIN = 60_000;
const DEFAULTS = { timeoutMs: 45 * MIN, intervalMs: 30_000, missingGraceMs: 5 * MIN };

describe("waitForGreenBuild", () => {
  it("passes on the first poll without sleeping", async () => {
    const clock = fakeClock();
    const fetchRuns = vi.fn(async () => [GREEN_V1130]);
    const result = await waitForGreenBuild({
      ...DEFAULTS,
      fetchRuns,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("success");
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("fails on red at once and never waits", async () => {
    const clock = fakeClock();
    const fetchRuns = vi.fn(async () => [RED_V1150]);
    const result = await waitForGreenBuild({
      ...DEFAULTS,
      fetchRuns,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.run.id).toBe(37606026405);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("waits while pending and passes once the run turns green", async () => {
    const clock = fakeClock();
    const pending = run({ status: "in_progress", conclusion: null });
    const answers = [[pending], [pending], [GREEN_V1130]];
    const fetchRuns = vi.fn(async () => answers.shift());
    const result = await waitForGreenBuild({
      ...DEFAULTS,
      fetchRuns,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ok).toBe(true);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.state.sleeps).toEqual([30_000, 30_000]);
  });

  it("fails immediately when a pending run turns red", async () => {
    const clock = fakeClock();
    const pending = run({ status: "in_progress", conclusion: null });
    const answers = [[pending], [RED_V1150]];
    const fetchRuns = vi.fn(async () => answers.shift());
    const result = await waitForGreenBuild({
      ...DEFAULTS,
      fetchRuns,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.outcome).toBe("failed");
    expect(clock.sleep).toHaveBeenCalledTimes(1);
  });

  it("times out when the run stays pending", async () => {
    const clock = fakeClock();
    const pending = run({ status: "queued", conclusion: null });
    const fetchRuns = vi.fn(async () => [pending]);
    const result = await waitForGreenBuild({
      ...DEFAULTS,
      fetchRuns,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("timeout");
    expect(result.run.status).toBe("queued");
    expect(clock.state.t).toBeGreaterThanOrEqual(DEFAULTS.timeoutMs);
    expect(clock.state.t).toBeLessThanOrEqual(DEFAULTS.timeoutMs + DEFAULTS.intervalMs);
  });

  it("reports missing after the grace period, well before the timeout", async () => {
    const clock = fakeClock();
    const fetchRuns = vi.fn(async () => []);
    const result = await waitForGreenBuild({
      ...DEFAULTS,
      fetchRuns,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("missing");
    expect(clock.state.t).toBeGreaterThanOrEqual(DEFAULTS.missingGraceMs);
    expect(clock.state.t).toBeLessThan(DEFAULTS.timeoutMs);
  });

  it("accepts a run that registers late: missing, pending, success", async () => {
    const clock = fakeClock();
    const pending = run({ status: "in_progress", conclusion: null });
    const answers = [[], [pending], [GREEN_V1130]];
    const fetchRuns = vi.fn(async () => answers.shift());
    const result = await waitForGreenBuild({
      ...DEFAULTS,
      fetchRuns,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ok).toBe(true);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it("rejects when the API call fails instead of passing", async () => {
    const clock = fakeClock();
    const fetchRuns = vi.fn(async () => {
      throw new Error("gh: HTTP 502");
    });
    await expect(
      waitForGreenBuild({ ...DEFAULTS, fetchRuns, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow("HTTP 502");
  });
});

describe("TAG_PATTERN", () => {
  it("matches the regex source of release.yml's promote meta step", () => {
    // Kept as a literal copy: the workflow check below pins the same text in release.yml.
    expect(TAG_PATTERN.source).toBe("^v[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9.]+)?$");
  });

  it("accepts release tags and rejects everything else", () => {
    expect(TAG_PATTERN.test("v1.15.0")).toBe(true);
    expect(TAG_PATTERN.test("v1.15.0-rc.1")).toBe(true);
    expect(TAG_PATTERN.test("main")).toBe(false);
    expect(TAG_PATTERN.test("v1.15")).toBe(false);
  });
});

describe("BUILD_PUSH_WORKFLOW_FILE", () => {
  it("names the workflow file the gate queries", () => {
    expect(BUILD_PUSH_WORKFLOW_FILE).toBe("build-push.yml");
  });
});

describe("parseGateArgs", () => {
  it("applies the defaults 45 / 30 / 5 for --tag", () => {
    expect(parseGateArgs(["--tag", "v1.15.0"])).toEqual({
      tag: "v1.15.0",
      sha: undefined,
      timeoutMinutes: 45,
      intervalSeconds: 30,
      missingGraceMinutes: 5,
    });
  });

  it("accepts a 40-char lowercase hex --sha", () => {
    const parsed = parseGateArgs(["--sha", SHA_V1150]);
    expect(parsed.sha).toBe(SHA_V1150);
    expect(parsed.tag).toBeUndefined();
  });

  it("accepts overridden numbers", () => {
    const parsed = parseGateArgs([
      "--tag",
      "v1.13.0",
      "--timeout-minutes",
      "1",
      "--interval-seconds",
      "2",
      "--missing-grace-minutes",
      "0",
    ]);
    expect(parsed.timeoutMinutes).toBe(1);
    expect(parsed.intervalSeconds).toBe(2);
    expect(parsed.missingGraceMinutes).toBe(0);
  });

  it.each(["main", "v1.15", "v1.15.0;rm -rf /", ""])(
    "rejects tag %j with a German error",
    (tag) => {
      expect(() => parseGateArgs(["--tag", tag])).toThrow(/Tag|Release/);
    },
  );

  it("rejects both --tag and --sha", () => {
    expect(() => parseGateArgs(["--tag", "v1.15.0", "--sha", SHA_V1150])).toThrow(
      /entweder|nur eines|genau/i,
    );
  });

  it("rejects neither --tag nor --sha", () => {
    expect(() => parseGateArgs([])).toThrow(/--tag|--sha/);
  });

  it("rejects uppercase and short shas", () => {
    expect(() => parseGateArgs(["--sha", SHA_V1150.toUpperCase()])).toThrow(/SHA/);
    expect(() => parseGateArgs(["--sha", "d796cf6"])).toThrow(/SHA/);
  });

  it("rejects a negative timeout, a negative grace and a zero interval", () => {
    // `--flag=-1` reaches the numeric validation; the space-separated form is refused by the
    // argument parser itself (ambiguous leading dash) and must also fail.
    expect(() => parseGateArgs(["--tag", "v1.15.0", "--timeout-minutes=-1"])).toThrow(/Minuten/);
    expect(() => parseGateArgs(["--tag", "v1.15.0", "--missing-grace-minutes=-1"])).toThrow(
      /Minuten/,
    );
    expect(() => parseGateArgs(["--tag", "v1.15.0", "--interval-seconds=0"])).toThrow(/Sekunden/);
    expect(() => parseGateArgs(["--tag", "v1.15.0", "--timeout-minutes", "-1"])).toThrow(/Aufruf/);
  });

  it("rejects non-numeric numbers and unknown flags in German", () => {
    expect(() => parseGateArgs(["--tag", "v1.15.0", "--timeout-minutes", "abc"])).toThrow(
      /Minuten/,
    );
    expect(() => parseGateArgs(["--tag", "v1.15.0", "--bogus"])).toThrow(/Aufruf|Option/);
  });
});

describe("formatOutcome", () => {
  const ctx = { tag: "v1.15.0", sha: SHA_V1150 };

  it("titles the four outcomes exactly", () => {
    expect(formatOutcome({ ok: true, outcome: "success", run: GREEN_V1130 }, ctx).title).toBe(
      "Release-Gate: Build & Push grün",
    );
    expect(formatOutcome({ ok: false, outcome: "failed", run: RED_V1150 }, ctx).title).toBe(
      "Release-Gate: Build & Push rot",
    );
    expect(formatOutcome({ ok: false, outcome: "missing" }, ctx).title).toBe(
      "Release-Gate: Build & Push fehlt",
    );
    const pending = run({ status: "in_progress", conclusion: null });
    expect(formatOutcome({ ok: false, outcome: "timeout", run: pending }, ctx).title).toBe(
      "Release-Gate: Zeitüberschreitung",
    );
  });

  it("names run id, url and short sha in the rot message on a single line", () => {
    const { message } = formatOutcome({ ok: false, outcome: "failed", run: RED_V1150 }, ctx);
    expect(message).toContain("37606026405");
    expect(message).toContain(RED_V1150.html_url);
    expect(message).toContain("d796cf6");
    expect(message).toContain("gh run rerun 37606026405 --failed");
    expect(message).toContain("gh workflow run release.yml --ref main -f tag=v1.15.0");
    expect(message).not.toMatch(/\n/);
  });

  it("keeps every message on a single line", () => {
    const pending = run({ status: "in_progress", conclusion: null, id: 77 });
    for (const result of [
      { ok: true, outcome: "success", run: GREEN_V1130 },
      { ok: false, outcome: "missing" },
      { ok: false, outcome: "timeout", run: pending },
    ]) {
      expect(formatOutcome(result, ctx).message).not.toMatch(/\n/);
    }
  });

  it("names the pending run in the timeout message and tells to re-dispatch", () => {
    const pending = run({ status: "in_progress", conclusion: null, id: 77 });
    const { message } = formatOutcome({ ok: false, outcome: "timeout", run: pending }, ctx);
    expect(message).toContain("77");
    expect(message).toContain("gh workflow run release.yml --ref main -f tag=v1.15.0");
  });
});
