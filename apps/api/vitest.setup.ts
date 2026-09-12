import { config } from "dotenv";
import { resolve } from "path";
import { assertTestDatabaseMarker } from "./scripts/test-database-guard";
import {
  TEST_NAMESPACE_ENV_VAR,
  assertTestDatabaseUrlShape,
  namespacedDatabaseUrl,
  resolveTestNamespace,
  templateDatabaseName,
  workerDatabaseNames,
} from "./src/utils/test-database";

/**
 * globalSetup (Phase 101 plan 02, TI-03; widened Phase 106 plan 04; namespace-aware Phase 132
 * plan 03) — runs ONCE, in the parent process, before any test worker is spawned. Loads
 * apps/api/.env.test, resolves this working directory's own test-database namespace, then requires
 * TEST_DATABASE_URL's target to be the SEPARATE, namespace-resolved TEMPLATE database this
 * project's own tooling provisioned (D-01), and requires every one of the N per-worker databases
 * (`clokr_test[_<ns>]_1` … `clokr_test[_<ns>]_<n>`) to exist and carry the marker too — each
 * verified by POSSESSION of the marker `ensure-test-database.ts`/`reset-test-databases.ts` stamp,
 * not merely by name (see scripts/test-database-guard.ts). A throw here aborts the ENTIRE run
 * before a single test file loads: no partial run, no silent connection to whatever DATABASE_URL
 * happened to resolve to. Do not catch, warn, or continue on failure.
 *
 * As of Phase 132, this function resolves the working-directory namespace exactly ONCE and the
 * databases it verifies below are THIS working directory's own — so two concurrent runs from two
 * different working directories (e.g. two linked git worktrees) verify two entirely disjoint sets
 * of databases and cannot collide, even though both share the same `clokr_test`-prefixed alphabet.
 */
export async function setup(): Promise<void> {
  // override: false — the shell / CI's own environment is authoritative; .env.test is the LOCAL
  // FALLBACK for keys not already set. This makes .github/workflows/ci.yml's TEST_DATABASE_URL live
  // configuration (previously always discarded by override: true), and makes a stale
  // TEST_DATABASE_URL=... prefix on a local command actually take effect — caught loudly by the
  // guard below instead of being silently discarded the way override: true discarded it before.
  config({ path: resolve(__dirname, ".env.test"), override: false });

  // Phase 104-07: mirror TEST_DATABASE_URL's own "host-exposed docker port" pattern for MinIO.
  // apps/api/src/plugins/storage.ts falls back to the docker-network hostname "minio" when
  // MINIO_ENDPOINT is unset — correct for the api container, unreachable from a vitest run on the
  // host. docker-compose.yml exposes MinIO on localhost:9000, same as postgres on localhost:5432.
  // Only a default (no override of an already-set value), so CI or a real .env.test entry wins.
  process.env.MINIO_ENDPOINT ??= "localhost";

  // ── Namespace (Phase 132) ────────────────────────────────────────────────────────────
  // Derived HERE and nowhere else in the harness. globalSetup runs ONCE, in the parent process,
  // before any worker is spawned, so this is the only place in the Vitest lifecycle where a `git`
  // subprocess is affordable: vitest.worker-setup.ts is a `setupFiles` entry, which Vitest
  // re-imports once per test FILE under `isolate: true` (~200x per run) — deriving there would
  // add a subprocess spawn to the suite's already-dominant per-file bootstrap cost (Issue #42,
  // explicitly out of scope for this phase, and not something to make worse).
  //
  // Writing the result back into process.env is the propagation: every worker is forked from this
  // process and inherits it, exactly as it inherits TEST_DATABASE_URL below. It is also D-02's
  // explicit override variable — one mechanism serving both purposes, so CI can pin the empty
  // namespace by simply setting it (.github/workflows/ci.yml).
  const namespace = resolveTestNamespace();
  process.env[TEST_NAMESPACE_ENV_VAR] = namespace;

  // Move TEST_DATABASE_URL into this working directory's namespace. In the main working tree and
  // in CI the namespace is empty and this is a byte-for-byte no-op (D-06, acceptance criterion 6).
  //
  // It also closes a real footgun: `dotenv`'s override:false means an already-exported shell
  // TEST_DATABASE_URL wins over .env.test. A stale `export TEST_DATABASE_URL=.../clokr_test` in a
  // worktree shell would otherwise send that worktree's run at the MAIN tree's databases, and the
  // possession guard could not object — that target genuinely is a validly-marked test database,
  // just the wrong one. The namespace, not the URL's database name, decides identity; the URL
  // still decides host, port and credentials. Set CLOKR_TEST_NAMESPACE to override the namespace.
  const templateUrl = namespacedDatabaseUrl(
    assertTestDatabaseUrlShape(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL"),
    namespace,
  );
  process.env.TEST_DATABASE_URL = templateUrl.toString();

  // Template first: it is what `prisma migrate deploy` ran against and what every worker database
  // was cloned from. Verified by POSSESSION of the marker, exactly as in Phase 101. Passing the
  // resolved template name is a STRENGTHENING over the pre-Phase-132 call (which passed none): the
  // guard now demands the exact resolved template, not merely namespace membership (D-09).
  await assertTestDatabaseMarker(process.env.TEST_DATABASE_URL, templateDatabaseName(namespace));

  // Then every worker database, by EXACT name. A missing or unmarked one aborts the whole run here,
  // in the parent process, before a single worker is spawned — rather than surfacing later as one
  // confusing red file. `test:setup` provisions these (D-02: pre-provisioned, never created by a
  // worker), so a failure here means setup did not run or did not finish.
  for (const name of workerDatabaseNames(namespace)) {
    const workerUrl = new URL(templateUrl.toString());
    workerUrl.pathname = `/${name}`;
    await assertTestDatabaseMarker(workerUrl.toString(), name);
  }

  // DATABASE_URL is deliberately NOT assigned here (Phase 106). Assigning the TEMPLATE here would
  // mean that a worker whose setupFiles failed to run would silently write into the template —
  // poisoning every subsequent clone and breaking the next run's `CREATE DATABASE ... TEMPLATE`
  // (which requires zero connections on the source). vitest.worker-setup.ts is the SINGLE owner of
  // this assignment and throws if it cannot make it. Nothing here may set a fallback.
}
