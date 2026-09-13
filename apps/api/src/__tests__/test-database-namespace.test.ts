/**
 * Phase 132 — the namespace derivation, proven against a REAL git repository with REAL linked
 * worktrees, and the namespace-aware name construction proven byte-for-byte against the names CI
 * uses today (acceptance criterion 6).
 *
 * DB-free: imports only pure functions from src/utils/test-database.ts. It does create a throwaway
 * git repository under os.tmpdir() and removes it again, because the one thing that must not be
 * mocked here is git's own answer — 132-RESEARCH.md reproduced empirically that `--git-dir` and
 * `--git-common-dir` disagree in FORM (absolute vs relative) from a subdirectory of the main tree,
 * and a mock would have encoded the wrong expectation. The fixture is `git init` + one empty
 * commit, then `git worktree add` twice (two linked worktrees, two branches) — this is what makes
 * the "two worktrees derive two different namespaces" assertion below an empirical proof, not an
 * assumption.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TEST_DATABASE_NAME_PATTERN,
  TEST_DATABASE_MARKER,
  TEST_DATABASE_WORKER_COUNT,
  TEST_NAMESPACE_ENV_VAR,
  parseTestDatabaseName,
  isTestDatabaseName,
  isWorkerDatabaseName,
  isValidTestNamespace,
  templateDatabaseName,
  workerDatabaseName,
  workerDatabaseNames,
  namespacedDatabaseUrl,
  buildMarkerComment,
  markerProvenancePath,
  deriveTestNamespace,
  resolveTestNamespace,
} from "../utils/test-database";

describe("name construction (D-03/D-06 — acceptance criterion 6)", () => {
  it("TEST_DATABASE_NAME_PATTERN accepts the main-tree and CI-unchanged names", () => {
    expect(TEST_DATABASE_NAME_PATTERN.test("clokr_test")).toBe(true);
    expect(TEST_DATABASE_NAME_PATTERN.test("clokr_test_1")).toBe(true);
  });

  it("TEST_DATABASE_NAME_PATTERN accepts a namespaced template and a namespaced worker", () => {
    expect(TEST_DATABASE_NAME_PATTERN.test("clokr_test_a1b2c3d4")).toBe(true);
    expect(TEST_DATABASE_NAME_PATTERN.test("clokr_test_a1b2c3d4_3")).toBe(true);
  });

  it("rejects every near-miss, including the D-06 anchoring proof and the new hex-shape misses", () => {
    const rejected = [
      "clokr_test_kopie_von_prod", // D-06: neither 8 hex chars nor a bare integer
      "clokr_test_a1b2c3d", // 7 hex chars
      "clokr_test_a1b2c3d45", // 9 hex chars
      "clokr_test_A1B2C3D4", // uppercase — D-03 fixes lowercase hex
      "clokr_test_g1b2c3d4", // "g" is not hex
      "myclokr_test", // anchoring proof: not a substring match
    ];
    for (const name of rejected) {
      expect(TEST_DATABASE_NAME_PATTERN.test(name), `expected "${name}" to be rejected`).toBe(
        false,
      );
    }
  });

  it("parseTestDatabaseName structurally decomposes every shape", () => {
    expect(parseTestDatabaseName("clokr_test_a1b2c3d4_3")).toEqual({
      namespace: "a1b2c3d4",
      workerIndex: 3,
    });
    expect(parseTestDatabaseName("clokr_test_2")).toEqual({ namespace: "", workerIndex: 2 });
    expect(parseTestDatabaseName("clokr_test_a1b2c3d4")).toEqual({
      namespace: "a1b2c3d4",
      workerIndex: null,
    });
    expect(parseTestDatabaseName("clokr")).toBeNull();
  });

  it("isWorkerDatabaseName is structural: a namespaced TEMPLATE is not a worker", () => {
    expect(isWorkerDatabaseName("clokr_test_a1b2c3d4")).toBe(false);
    expect(isWorkerDatabaseName("clokr_test")).toBe(false);
    expect(isWorkerDatabaseName("clokr_test_a1b2c3d4_1")).toBe(true);
  });

  it("isTestDatabaseName agrees with the pattern for every case above", () => {
    expect(isTestDatabaseName("clokr_test")).toBe(true);
    expect(isTestDatabaseName("clokr_test_a1b2c3d4")).toBe(true);
    expect(isTestDatabaseName("clokr_test_kopie_von_prod")).toBe(false);
  });

  it("isValidTestNamespace accepts only the empty string or exactly 8 lowercase hex chars", () => {
    expect(isValidTestNamespace("")).toBe(true);
    expect(isValidTestNamespace("a1b2c3d4")).toBe(true);
    expect(isValidTestNamespace("a1b2c3d")).toBe(false);
    expect(isValidTestNamespace("A1B2C3D4")).toBe(false);
    expect(isValidTestNamespace("nope")).toBe(false);
  });

  // Written as literals on purpose — deriving them from TEST_DATABASE_NAME and
  // TEST_DATABASE_WORKER_COUNT would make the assertion follow any future change instead of
  // pinning what CI provisions today (acceptance criterion 6).
  it("the main-tree names are pinned as literals — CI must never see these change", () => {
    expect(templateDatabaseName("")).toBe("clokr_test");
    expect(workerDatabaseNames("")).toEqual([
      "clokr_test_1",
      "clokr_test_2",
      "clokr_test_3",
      "clokr_test_4",
    ]);
  });

  it("templateDatabaseName/workerDatabaseName construct namespaced names", () => {
    expect(templateDatabaseName("a1b2c3d4")).toBe("clokr_test_a1b2c3d4");
    expect(workerDatabaseName(2, "")).toBe("clokr_test_2");
    expect(workerDatabaseName(2, "a1b2c3d4")).toBe("clokr_test_a1b2c3d4_2");
  });

  it("templateDatabaseName/workerDatabaseName throw on an invalid namespace", () => {
    expect(() => templateDatabaseName("nope")).toThrow();
    expect(() => workerDatabaseName(1, "nope")).toThrow();
  });

  it("workerDatabaseNames(ns) returns TEST_DATABASE_WORKER_COUNT namespaced names in order", () => {
    const names = workerDatabaseNames("a1b2c3d4");
    expect(names).toHaveLength(TEST_DATABASE_WORKER_COUNT);
    expect(names).toEqual([
      "clokr_test_a1b2c3d4_1",
      "clokr_test_a1b2c3d4_2",
      "clokr_test_a1b2c3d4_3",
      "clokr_test_a1b2c3d4_4",
    ]);
  });

  it("namespacedDatabaseUrl with an empty namespace is byte-identical to the input", () => {
    const u1 = "postgresql://clokr:password@localhost:5432/clokr_test";
    expect(namespacedDatabaseUrl(new URL(u1), "").toString()).toBe(new URL(u1).toString());
    const u2 = "postgresql://clokr:password@localhost:5432/clokr_test_3";
    expect(namespacedDatabaseUrl(new URL(u2), "").toString()).toBe(new URL(u2).toString());
  });

  it("namespacedDatabaseUrl rewrites only the database name, preserving the worker index", () => {
    const url = new URL("postgresql://u:p@h:5432/clokr_test");
    expect(namespacedDatabaseUrl(url, "a1b2c3d4").pathname).toBe("/clokr_test_a1b2c3d4");

    const workerUrl = new URL("postgresql://u:p@h:5432/clokr_test_3");
    expect(namespacedDatabaseUrl(workerUrl, "a1b2c3d4").pathname).toBe("/clokr_test_a1b2c3d4_3");
  });

  it("namespacedDatabaseUrl is idempotent for an already-namespaced URL", () => {
    const url = new URL("postgresql://u:p@h:5432/clokr_test_a1b2c3d4");
    expect(namespacedDatabaseUrl(url, "a1b2c3d4").pathname).toBe("/clokr_test_a1b2c3d4");
  });

  it("namespacedDatabaseUrl throws for a database name outside the namespace", () => {
    const url = new URL("postgresql://u:p@h:5432/clokr");
    expect(() => namespacedDatabaseUrl(url, "a1b2c3d4")).toThrow();
  });
});

describe("marker provenance (D-12)", () => {
  it("buildMarkerComment always starts with TEST_DATABASE_MARKER (every possession check is a startsWith)", () => {
    const comment = buildMarkerComment("apps/api/scripts/x.ts", "/abs/path/.git/worktrees/wt");
    expect(comment.startsWith(TEST_DATABASE_MARKER)).toBe(true);
  });

  it("markerProvenancePath round-trips the path buildMarkerComment embedded", () => {
    const comment = buildMarkerComment("apps/api/scripts/x.ts", "/abs/path/.git/worktrees/wt");
    expect(markerProvenancePath(comment)).toBe("/abs/path/.git/worktrees/wt");
  });

  it("markerProvenancePath returns null for a pre-Phase-132 marker (unknown, never guessed)", () => {
    const legacy =
      "clokr-test-database:v1 — provisioned by apps/api/scripts/ensure-test-database.ts (Phase 101). Contents are disposable.";
    expect(markerProvenancePath(legacy)).toBeNull();
  });

  it("markerProvenancePath returns null for a string that does not carry the marker at all", () => {
    expect(markerProvenancePath("not-really-a-marker")).toBeNull();
  });

  it("round-trips a provenance path containing a space", () => {
    const comment = buildMarkerComment("apps/api/scripts/x.ts", "/path with spaces/.git");
    expect(markerProvenancePath(comment)).toBe("/path with spaces/.git");
  });
});

describe("resolveTestNamespace (D-02)", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[TEST_NAMESPACE_ENV_VAR];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[TEST_NAMESPACE_ENV_VAR];
    else process.env[TEST_NAMESPACE_ENV_VAR] = saved;
  });

  it("an explicit empty override resolves to the empty namespace without spawning git", () => {
    process.env[TEST_NAMESPACE_ENV_VAR] = "";
    expect(resolveTestNamespace()).toBe("");
  });

  it("an explicit valid override resolves to that namespace", () => {
    process.env[TEST_NAMESPACE_ENV_VAR] = "a1b2c3d4";
    expect(resolveTestNamespace()).toBe("a1b2c3d4");
  });

  it("a malformed override throws — a human-typed override deserves a loud error", () => {
    process.env[TEST_NAMESPACE_ENV_VAR] = "nope";
    expect(() => resolveTestNamespace()).toThrow();
  });

  it("an unset override derives and memoizes into process.env", () => {
    delete process.env[TEST_NAMESPACE_ENV_VAR];
    resolveTestNamespace();
    expect(process.env[TEST_NAMESPACE_ENV_VAR]).toBeDefined();
  });
});

describe("deriveTestNamespace against a real git repository (D-01/D-03/D-06/D-07)", () => {
  let gitAvailable = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    gitAvailable = false;
  }

  const describeIfGit = gitAvailable ? describe : describe.skip;

  describeIfGit("with a real repository + linked worktrees", () => {
    let root: string;
    let mainRoot: string;
    let mainApiDir: string;
    let worktreeA: string;
    let worktreeB: string;
    let worktreeASubdir: string;
    let notARepo: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "clokr-ns-"));
      mainRoot = join(root, "main");
      mkdirSync(mainRoot, { recursive: true });

      const gitOpts = { cwd: mainRoot, stdio: "ignore" as const };
      execFileSync("git", ["-c", "init.defaultBranch=main", "init"], gitOpts);
      execFileSync(
        "git",
        [
          "-c",
          "user.email=clokr-test@example.com",
          "-c",
          "user.name=Clokr Test",
          "commit",
          "--allow-empty",
          "-m",
          "initial",
        ],
        gitOpts,
      );

      worktreeA = join(root, "wt-a");
      worktreeB = join(root, "wt-b");
      execFileSync("git", ["worktree", "add", worktreeA, "-b", "ns-a"], gitOpts);
      execFileSync("git", ["worktree", "add", worktreeB, "-b", "ns-b"], gitOpts);

      mainApiDir = join(mainRoot, "apps", "api");
      mkdirSync(mainApiDir, { recursive: true });
      worktreeASubdir = join(worktreeA, "apps", "api");
      mkdirSync(worktreeASubdir, { recursive: true });

      notARepo = mkdtempSync(join(tmpdir(), "clokr-ns-not-a-repo-"));
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(notARepo, { recursive: true, force: true });
    });

    it("main tree from its root derives the empty namespace", () => {
      expect(deriveTestNamespace(mainRoot)).toBe("");
    });

    it("main tree from a subdirectory ALSO derives the empty namespace (the relative-vs-absolute trap)", () => {
      // Without --path-format=absolute, --git-dir would be absolute and --git-common-dir
      // relative here, and a naive string compare would misreport this as a worktree — renaming
      // CI's databases. This is the common case: npm/pnpm/tsx run with cwd = apps/api.
      expect(deriveTestNamespace(mainApiDir)).toBe("");
    });

    it("a linked worktree derives an 8-lowercase-hex namespace", () => {
      expect(deriveTestNamespace(worktreeA)).toMatch(/^[0-9a-f]{8}$/);
    });

    it("a linked worktree derives the SAME namespace from a subdirectory (depth-independent)", () => {
      expect(deriveTestNamespace(worktreeASubdir)).toBe(deriveTestNamespace(worktreeA));
    });

    it("two different linked worktrees derive two DIFFERENT namespaces", () => {
      expect(deriveTestNamespace(worktreeA)).not.toBe(deriveTestNamespace(worktreeB));
    });

    it("a directory that is not a git repository derives the empty namespace", () => {
      expect(deriveTestNamespace(notARepo)).toBe("");
    });

    it("git being unresolvable (empty PATH) derives the empty namespace (D-07)", () => {
      const savedPath = process.env.PATH;
      try {
        process.env.PATH = "";
        expect(deriveTestNamespace(mainRoot)).toBe("");
      } finally {
        process.env.PATH = savedPath;
      }
    });
  });
});
