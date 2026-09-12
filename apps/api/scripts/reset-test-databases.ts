/**
 * Drops and re-clones the N per-worker test databases from the migrated `clokr_test` template
 * (Phase 106, D-04/D-05/D-07/D-08).
 *
 * This is the ONE place in this repository that issues `DROP DATABASE`. It is invoked as the
 * third link of `test:setup`'s `&&` chain, after `ensure-test-database.ts` (creates/stamps the
 * template) and `prisma migrate deploy` (migrates the template) have both committed — see
 * apps/api/package.json. That ordering is load-bearing: cloning before the migration commits
 * would byte-copy a half-migrated template.
 *
 * D-05: every run starts fresh. Every worker database (`clokr_test_1` … `clokr_test_N`) is
 * dropped and re-created from the template on EVERY invocation — never reused. A zombie
 * connection blocking the drop is a LOUD failure naming the database and the holding
 * backend(s), never a silent fallback to reuse.
 *
 * D-07/D-08: this script — and only this script — may drop a database. It contains exactly two
 * `DROP DATABASE` statements, and BOTH are gated:
 *
 *   1. The reset drop (`mayDropDatabase`) requires the target to carry the `TEST_DATABASE_MARKER`
 *      (possession, the actual mechanism) AND to have a worker-namespace name (convenience, see
 *      `isWorkerDatabaseName`).
 *   2. The marker-stamp rollback (`mayRollbackDrop`) removes an orphan that — by construction —
 *      has no marker yet, so possession cannot authorize it. It requires the worker-namespace name
 *      AND membership in the worker-name set this run derived from the template
 *      (`workerDatabaseNames`, passed in explicitly as of Phase 132 since that set is now
 *      namespace-dependent).
 *
 * The dev database `clokr` carries no marker, has a non-worker name, and is not in this run's
 * worker-name set — it is therefore STRUCTURALLY undroppable on both paths, not merely excluded
 * by a naming convention. The template is excluded too: `isWorkerDatabaseName` is false for it,
 * so the migrated template survives every reset. This file must NOT reach the production runtime
 * image; apps/api/Dockerfile removes it from the runtime stage and asserts its absence (D-08 gate).
 *
 * `COMMENT ON DATABASE` lives in `pg_shdescription`, keyed to the database OID — a `TEMPLATE`
 * copy does NOT inherit it (reproduced live, 106-RESEARCH.md). Every cloned worker database is
 * therefore stamped individually, immediately after its `CREATE DATABASE ... TEMPLATE`.
 *
 * Phase 132: the template and worker names are now per WORKING DIRECTORY (D-06/D-10). A run in
 * linked git worktree A derives its own namespace, its own `templateName`, and its own
 * `workerNames` — it can therefore never touch worktree B's databases, because the drop and clone
 * loops below iterate exactly `workerNames`, nothing broader. In the main working tree the
 * namespace is empty and every name is byte-identical to today's.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";
import {
  TEST_DATABASE_MARKER,
  isWorkerDatabaseName,
  parseDatabaseUrl,
  databaseNameOf,
  describeTarget,
  templateDatabaseName,
  workerDatabaseNames,
  namespacedDatabaseUrl,
  resolveTestNamespace,
  buildMarkerComment,
} from "../src/utils/test-database";

/**
 * The absolute git directory of the working directory running this script — the value D-12
 * records in the marker so an orphaned namespace can be attributed from the database itself
 * rather than from a side ledger. Falls back to process.cwd() when git cannot answer. Copied
 * verbatim from ensure-test-database.ts (Phase 132) rather than moved into test-database.ts:
 * this is a provenance string, NOT a second namespace derivation, and test-database.ts must stay
 * free of anything a `setupFiles` re-import would pay for — see that module's header.
 */
function provisioningPath(): string {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * The ONE place in this repository that issues `DROP DATABASE` (Phase 106, D-07/D-08).
 *
 * D-07: a DROP is permitted only when the target carries the TEST_DATABASE_MARKER
 * (`COMMENT ON DATABASE`, i.e. possession — the mechanism) AND its name is a worker database in
 * the anchored namespace (convenience). The dev database `clokr` carries no marker and is
 * therefore STRUCTURALLY undroppable here, not merely excluded by a naming convention. The
 * template `clokr_test` is excluded too: `isWorkerDatabaseName` is false for it, so the migrated
 * template survives every reset.
 *
 * D-08: this file must NOT reach the production runtime image. apps/api/Dockerfile removes it
 * from the runtime stage and then asserts its absence — see the D-08 gate there.
 */
export function mayDropDatabase(name: string, marker: string | null): boolean {
  return isWorkerDatabaseName(name) && marker !== null && marker.startsWith(TEST_DATABASE_MARKER);
}

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Backstop for the ONE drop that cannot go through `mayDropDatabase` (WR-01): rolling back a
 * freshly cloned worker database whose marker stamp failed. That orphan carries no marker by
 * construction, so possession — the normal mechanism — is unavailable to authorize its removal.
 *
 * The name gate still applies, and membership in `workerNames` is required on top of it, so the
 * target is provably one of the N names THIS run derived from the template. The dev database
 * `clokr` and the template are absent from that set and fail `isWorkerDatabaseName` besides.
 * Without this, reachability was the only thing standing between that statement and a non-worker
 * database — a correct argument, but not an enforced one.
 *
 * `workerNames` is now an explicit parameter (Phase 132) rather than a module-level constant:
 * this function is module-level and exported and cannot close over `main()`'s namespace-derived
 * set, and the set is namespace-dependent, so it must be passed in for the "one of the N names
 * THIS run derived" guarantee to stay literally true.
 */
export function mayRollbackDrop(name: string, workerNames: readonly string[]): boolean {
  return isWorkerDatabaseName(name) && workerNames.includes(name);
}

/** Escape single quotes for a `COMMENT ON DATABASE ... IS '<literal>'` statement. */
function escapeLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

async function pgStatActivityReport(client: pg.Client, datname: string): Promise<string> {
  const rows = await client.query(
    "SELECT pid, application_name, client_addr, state, backend_start FROM pg_stat_activity WHERE datname = $1",
    [datname],
  );
  if (rows.rowCount === 0) {
    return "  (no pg_stat_activity rows found — the connection may have closed between the failed DROP and this diagnostic query)";
  }
  return rows.rows
    .map(
      (r: {
        pid: number;
        application_name: string | null;
        client_addr: string | null;
        state: string | null;
        backend_start: Date | null;
      }) =>
        `  pid=${r.pid} application_name=${r.application_name ?? "<none>"} client_addr=${
          r.client_addr ?? "<none>"
        } state=${r.state ?? "<none>"} backend_start=${r.backend_start?.toISOString() ?? "<none>"}`,
    )
    .join("\n");
}

async function terminateTemplateBackends(client: pg.Client, templateName: string): Promise<void> {
  await client.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [templateName],
  );
}

async function main(): Promise<void> {
  const raw = process.env.TEST_DATABASE_URL;

  let url: URL;
  try {
    url = parseDatabaseUrl(raw, "TEST_DATABASE_URL");
  } catch (err) {
    fatal(`reset-test-databases: REFUSED — ${(err as Error).message}`);
  }

  let target = describeTarget(url.toString());

  // ── Refusal gate — every branch below exits before ANY connection is opened ──────────
  if (process.env.NODE_ENV === "production") {
    fatal(
      `reset-test-databases: REFUSED — NODE_ENV is "production" — this script must never run ` +
        `against production.\n  target: ${target}`,
    );
  }
  if (url.searchParams.has("schema")) {
    fatal(
      `reset-test-databases: REFUSED — URL carries a "schema" query parameter ` +
        `("${url.searchParams.get("schema")}") — that is the retired Prisma-only isolation ` +
        `mechanism (D-01). Remove ?schema= from TEST_DATABASE_URL.\n  target: ${target}`,
    );
  }

  // ── Namespace (Phase 132) ────────────────────────────────────────────────────────────
  // Resolve THIS working directory's namespace once, then rewrite the input into it, exactly
  // like ensure-test-database.ts — after the schema/production refusals above, before the
  // template-identity check below (which must compare against the RESOLVED template name).
  const namespace = resolveTestNamespace();
  url = namespacedDatabaseUrl(url, namespace);
  target = describeTarget(url.toString());
  const dbName = databaseNameOf(url);
  const templateName = templateDatabaseName(namespace);
  const workerNames = workerDatabaseNames(namespace);

  if (dbName !== templateName) {
    fatal(
      `reset-test-databases: REFUSED — TEST_DATABASE_URL points at "${dbName}", not the ` +
        `template "${templateName}" for THIS working directory. In a linked git worktree that is ` +
        `"clokr_test_<ns>"; in the main working tree it is "clokr_test" (Phase 132, D-06). This ` +
        `script derives the ${workerNames.length} worker database names itself from the template ` +
        `target — being pointed at a worker database is a misconfiguration, not a shortcut.\n` +
        `  target: ${target}`,
    );
  }

  // ── ONE maintenance connection, pathname swapped to /postgres ────────────────────────
  const maintenanceUrl = new URL(url.toString());
  maintenanceUrl.pathname = "/postgres";
  const maint = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await maint.connect();

  try {
    // ── Drop phase ───────────────────────────────────────────────────────────────────
    let dropped = 0;
    for (const name of workerNames) {
      const markerRow = await maint.query<{ marker: string | null }>(
        "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
        [name],
      );
      if (markerRow.rowCount === 0) {
        // nothing to drop, continue
        continue;
      }
      const marker = markerRow.rows[0].marker;
      if (!mayDropDatabase(name, marker)) {
        fatal(
          `reset-test-databases: REFUSED to drop "${name}" — it is in the test namespace but does not\n` +
            `  carry the "${TEST_DATABASE_MARKER}" marker, so this tooling cannot prove it created it.\n` +
            `  actual marker: ${marker ?? "<none>"}\n` +
            `  target:        ${target}\n` +
            `  This usually means a previous run died between CREATE DATABASE and the marker stamp.\n` +
            `  Remedy (destructive, do it deliberately):\n` +
            `    docker exec clokr-postgres-1 psql -U clokr -d postgres -c 'DROP DATABASE "${name}" WITH (FORCE)'\n` +
            `  then re-run: pnpm --filter @clokr/api run test:setup`,
        );
      }
      try {
        await maint.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        dropped += 1;
      } catch (err) {
        const report = await pgStatActivityReport(maint, name);
        fatal(
          `reset-test-databases: FATAL — DROP DATABASE "${name}" failed even WITH (FORCE): ` +
            `${(err as Error).message}\n` +
            `  target: ${target}\n` +
            `  pg_stat_activity for "${name}":\n${report}\n` +
            `  Remedy: kill the listed pid(s) if this is a local zombie vitest worker, or force-drop\n` +
            `    manually: docker exec clokr-postgres-1 psql -U clokr -d postgres -c 'DROP DATABASE "${name}" WITH (FORCE)'\n` +
            `  then re-run: pnpm --filter @clokr/api run test:setup`,
        );
      }
    }

    // ── Template quiesce — CREATE DATABASE ... TEMPLATE requires zero connections on the source
    await terminateTemplateBackends(maint, templateName);

    // ── Clone phase ──────────────────────────────────────────────────────────────────
    let created = 0;
    for (const name of workerNames) {
      try {
        await maint.query(`CREATE DATABASE "${name}" TEMPLATE "${templateName}"`);
      } catch (err) {
        const message = (err as Error).message;
        if (/being accessed by other users/i.test(message)) {
          // Retry once after re-quiescing the template.
          await terminateTemplateBackends(maint, templateName);
          try {
            await maint.query(`CREATE DATABASE "${name}" TEMPLATE "${templateName}"`);
          } catch (retryErr) {
            const report = await pgStatActivityReport(maint, templateName);
            fatal(
              `reset-test-databases: FATAL — CREATE DATABASE "${name}" TEMPLATE "${templateName}" ` +
                `failed twice: ${(retryErr as Error).message}\n` +
                `  target: ${target}\n` +
                `  pg_stat_activity for template "${templateName}":\n${report}`,
            );
          }
        } else {
          fatal(
            `reset-test-databases: FATAL — CREATE DATABASE "${name}" TEMPLATE "${templateName}" ` +
              `failed: ${message}\n  target: ${target}`,
          );
        }
      }

      // Stamp the marker individually — pg_shdescription (COMMENT ON DATABASE) is keyed to the
      // database OID and is NOT inherited from the TEMPLATE source (reproduced live in
      // RESEARCH.md). If the stamp fails, drop the unmarked orphan immediately rather than
      // leaving it behind for the next run's drop-gate to trip on.
      const workerUrl = new URL(url.toString());
      workerUrl.pathname = `/${name}`;
      const workerClient = new pg.Client({ connectionString: workerUrl.toString() });
      try {
        await workerClient.connect();
        const comment = buildMarkerComment(
          "apps/api/scripts/reset-test-databases.ts",
          provisioningPath(),
        );
        const escaped = escapeLiteral(comment);
        await workerClient.query(`COMMENT ON DATABASE "${name}" IS '${escaped}'`);
      } catch (err) {
        await workerClient.end().catch(() => {});
        if (!mayRollbackDrop(name, workerNames)) {
          fatal(
            `reset-test-databases: REFUSED to roll back "${name}" — it is not one of the ` +
              `${workerNames.length} worker databases this run derived from the ` +
              `template, so it must not be dropped.\n  target: ${target}`,
          );
        }
        await maint.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => {});
        fatal(
          `reset-test-databases: FATAL — stamping the marker on "${name}" failed: ` +
            `${(err as Error).message}\n  target: ${target}\n` +
            `  The unmarked orphan was force-dropped so it cannot trip the next run's drop-gate.`,
        );
      } finally {
        await workerClient.end();
      }

      created += 1;
    }

    console.error(
      `reset-test-databases: ${dropped} dropped, ${created} created from template ` +
        `${describeTarget(url.toString())} (marker stamped on each).`,
    );
  } finally {
    await maint.end();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("reset-test-databases: FATAL —", err instanceof Error ? err.message : err);
  process.exit(1);
});
