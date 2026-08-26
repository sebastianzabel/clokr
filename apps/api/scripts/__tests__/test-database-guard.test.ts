/**
 * TI-03 guard tests (Phase 101, plan 02) — one case per rejection branch of the pure shape check,
 * plus marker-possession coverage for `assertTestDatabaseMarker`.
 *
 * Conventions follow scripts/__tests__/audit-saldo-chain-integrity.test.ts: describe/it shape, no
 * mocking framework, no hardcoded calendar date anywhere. Unlike that file, the marker-possession
 * cases here DO need the real running Postgres (`assertTestDatabaseMarker` opens a connection by
 * design) — that connection is the same `clokr_test` / dev-reference target every other test in
 * this suite already relies on via globalSetup, so nothing new is required to run this file.
 */
import { describe, it, expect } from "vitest";
import { assertTestDatabaseUrlShape, assertTestDatabaseMarker } from "../test-database-guard";
import { TEST_DATABASE_NAME } from "../../src/utils/test-database";

const VALID_TEST_URL = `postgresql://clokr:password@localhost:5432/${TEST_DATABASE_NAME}`;

describe("assertTestDatabaseUrlShape (TI-03 — pure, no I/O)", () => {
  it("throws for an undefined value", () => {
    expect(() => assertTestDatabaseUrlShape(undefined, "TEST_DATABASE_URL")).toThrow();
  });

  it("throws for an empty string", () => {
    expect(() => assertTestDatabaseUrlShape("", "TEST_DATABASE_URL")).toThrow();
  });

  it("throws for a whitespace-only string", () => {
    expect(() => assertTestDatabaseUrlShape("   ", "TEST_DATABASE_URL")).toThrow();
  });

  it("throws for a non-URL string", () => {
    expect(() => assertTestDatabaseUrlShape("not-a-url-at-all", "TEST_DATABASE_URL")).toThrow();
  });

  it("throws for a non-postgres protocol", () => {
    expect(() =>
      assertTestDatabaseUrlShape(
        `mysql://clokr:password@localhost:5432/${TEST_DATABASE_NAME}`,
        "TEST_DATABASE_URL",
      ),
    ).toThrow();
  });

  it("throws when the database name is outside the test namespace", () => {
    expect(() =>
      assertTestDatabaseUrlShape(
        "postgresql://clokr:password@localhost:5432/clokr",
        "TEST_DATABASE_URL",
      ),
    ).toThrow();
  });

  it("rejects every name outside the anchored namespace, including near-misses (D-06)", () => {
    const rejected = [
      "clokr",
      "clokr_dev",
      "clokr_testing",
      "clokr_test_x",
      "clokr_test_",
      "clokr_test_kopie_von_prod", // the exact name D-06 cites for rejecting an UNANCHORED prefix
      "clokr_test_1_prod",
      "myclokr_test", // anchoring proof: the pattern is not a substring match
      "postgres",
    ];
    for (const name of rejected) {
      expect(
        () =>
          assertTestDatabaseUrlShape(
            `postgresql://clokr:password@localhost:5432/${name}`,
            "TEST_DATABASE_URL",
          ),
        `expected "${name}" to be refused`,
      ).toThrow();
    }
  });

  it("accepts the template and any per-worker database in the anchored namespace (D-06)", () => {
    const accepted = ["clokr_test", "clokr_test_1", "clokr_test_4", "clokr_test_12"];
    for (const name of accepted) {
      const url = assertTestDatabaseUrlShape(
        `postgresql://clokr:password@localhost:5432/${name}`,
        "TEST_DATABASE_URL",
      );
      expect(url).toBeInstanceOf(URL);
      expect(url.pathname).toBe(`/${name}`);
    }
  });

  it("throws when a schema query parameter is present, even with the correct database name", () => {
    expect(() =>
      assertTestDatabaseUrlShape(
        `postgresql://clokr:password@localhost:5432/${TEST_DATABASE_NAME}?schema=test`,
        "TEST_DATABASE_URL",
      ),
    ).toThrow(/schema/i);
  });

  it("returns the parsed URL for a well-formed target and does not throw", () => {
    const url = assertTestDatabaseUrlShape(VALID_TEST_URL, "TEST_DATABASE_URL");
    expect(url).toBeInstanceOf(URL);
    expect(url.pathname).toBe(`/${TEST_DATABASE_NAME}`);
  });

  it("names the source and the credential-free target in a rejection message", () => {
    let thrown: Error | undefined;
    try {
      assertTestDatabaseUrlShape(
        "postgresql://clokr:password@localhost:5432/clokr",
        "TEST_DATABASE_URL",
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown, "expected assertTestDatabaseUrlShape to throw").toBeDefined();
    expect(thrown!.message).toContain("TEST_DATABASE_URL");
    expect(thrown!.message).toContain("localhost:5432/clokr");
  });

  it("never includes the substring 'password' in any rejection message (pin the redaction, don't just trust it)", () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, "TEST_DATABASE_URL"],
      ["", "TEST_DATABASE_URL"],
      ["   ", "TEST_DATABASE_URL"],
      ["not-a-url-at-all", "TEST_DATABASE_URL"],
      [`mysql://clokr:password@localhost:5432/${TEST_DATABASE_NAME}`, "TEST_DATABASE_URL"],
      ["postgresql://clokr:password@localhost:5432/clokr", "TEST_DATABASE_URL"],
      [
        `postgresql://clokr:password@localhost:5432/${TEST_DATABASE_NAME}?schema=test`,
        "TEST_DATABASE_URL",
      ],
      ["postgresql://clokr:password@localhost:5432/clokr_dev", "TEST_DATABASE_URL"],
      ["postgresql://clokr:password@localhost:5432/clokr_testing", "TEST_DATABASE_URL"],
      ["postgresql://clokr:password@localhost:5432/clokr_test_x", "TEST_DATABASE_URL"],
      ["postgresql://clokr:password@localhost:5432/clokr_test_", "TEST_DATABASE_URL"],
      ["postgresql://clokr:password@localhost:5432/clokr_test_kopie_von_prod", "TEST_DATABASE_URL"],
      ["postgresql://clokr:password@localhost:5432/clokr_test_1_prod", "TEST_DATABASE_URL"],
      ["postgresql://clokr:password@localhost:5432/myclokr_test", "TEST_DATABASE_URL"],
      ["postgresql://clokr:password@localhost:5432/postgres", "TEST_DATABASE_URL"],
    ];
    for (const [raw, source] of cases) {
      let thrown: Error | undefined;
      try {
        assertTestDatabaseUrlShape(raw, source);
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown, `expected a throw for raw=${String(raw)}`).toBeDefined();
      expect(thrown!.message.toLowerCase()).not.toContain("password");
    }
  });
});

describe("assertTestDatabaseMarker (TI-03 — possession check, opens one connection)", () => {
  it("resolves for the database provisioned by ensure-test-database.ts", async () => {
    const raw = process.env.TEST_DATABASE_URL;
    expect(
      raw,
      "TEST_DATABASE_URL must be set — run pnpm --filter @clokr/api run test:setup first",
    ).toBeTruthy();
    await expect(assertTestDatabaseMarker(raw as string)).resolves.toBeUndefined();
  });

  it("rejects when pointed at the dev database (clokr), which carries no marker — the phase's whole thesis, as a test", async () => {
    const devRaw = process.env.ISOLATION_CHECK_DEV_DATABASE_URL;
    expect(
      devRaw,
      "ISOLATION_CHECK_DEV_DATABASE_URL must be set (added to .env.test in Phase 101 plan 01)",
    ).toBeTruthy();
    await expect(assertTestDatabaseMarker(devRaw as string)).rejects.toThrow();
  });

  it("rejects rather than hanging when the target host/port is unreachable — a connection error is a rejection, never a swallowed pass", async () => {
    // A local port nothing listens on. Exercises the connect-error branch specifically (as opposed
    // to the shape-check or the mismatch branch), pinning that a network failure aborts the run
    // instead of silently proceeding.
    const unreachable = `postgresql://clokr:password@localhost:59999/${TEST_DATABASE_NAME}`;
    await expect(assertTestDatabaseMarker(unreachable)).rejects.toThrow();
  });

  it("never includes the substring 'password' in a marker-rejection message", async () => {
    const devRaw = process.env.ISOLATION_CHECK_DEV_DATABASE_URL as string;
    let thrown: Error | undefined;
    try {
      await assertTestDatabaseMarker(devRaw);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown, "expected assertTestDatabaseMarker to reject").toBeDefined();
    expect(thrown!.message.toLowerCase()).not.toContain("password");
  });

  it("rejects a marked namespace database when an exact name is demanded and does not match", async () => {
    const raw = process.env.TEST_DATABASE_URL as string;
    await expect(assertTestDatabaseMarker(raw, "clokr_test_99")).rejects.toThrow();
  });
});
