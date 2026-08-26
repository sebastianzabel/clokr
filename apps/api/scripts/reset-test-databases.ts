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
 * D-07/D-08: this script — and only this script — may drop a database, and only when the target
 * carries the `TEST_DATABASE_MARKER` (possession, the actual mechanism) AND its name is a worker
 * database in the anchored namespace (convenience, see `isWorkerDatabaseName`). The dev database
 * `clokr` carries no marker and is therefore STRUCTURALLY undroppable here, not merely excluded
 * by a naming convention. The template `clokr_test` is excluded too — `isWorkerDatabaseName` is
 * false for it, so the migrated template survives every reset. This file must NOT reach the
 * production runtime image; apps/api/Dockerfile removes it from the runtime stage and asserts
 * its absence (D-08 gate).
 *
 * `COMMENT ON DATABASE` lives in `pg_shdescription`, keyed to the database OID — a `TEMPLATE`
 * copy does NOT inherit it (reproduced live, 106-RESEARCH.md). Every cloned worker database is
 * therefore stamped individually, immediately after its `CREATE DATABASE ... TEMPLATE`.
 */
import pg from "pg";
import {
  TEST_DATABASE_NAME,
  TEST_DATABASE_MARKER,
  WORKER_DATABASE_NAMES,
  isWorkerDatabaseName,
  parseDatabaseUrl,
  databaseNameOf,
  describeTarget,
} from "../src/utils/test-database";

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

  const target = describeTarget(url.toString());
  const dbName = databaseNameOf(url);

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
  if (dbName !== TEST_DATABASE_NAME) {
    fatal(
      `reset-test-databases: REFUSED — TEST_DATABASE_URL points at "${dbName}", not the ` +
        `template "${TEST_DATABASE_NAME}". This script derives the ${WORKER_DATABASE_NAMES.length} ` +
        `worker database names itself from the template target — being pointed at a worker ` +
        `database is a misconfiguration, not a shortcut.\n  target: ${target}`,
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
    for (const name of WORKER_DATABASE_NAMES) {
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
    await terminateTemplateBackends(maint, TEST_DATABASE_NAME);

    // ── Clone phase ──────────────────────────────────────────────────────────────────
    let created = 0;
    for (const name of WORKER_DATABASE_NAMES) {
      try {
        await maint.query(`CREATE DATABASE "${name}" TEMPLATE "${TEST_DATABASE_NAME}"`);
      } catch (err) {
        const message = (err as Error).message;
        if (/being accessed by other users/i.test(message)) {
          // Retry once after re-quiescing the template.
          await terminateTemplateBackends(maint, TEST_DATABASE_NAME);
          try {
            await maint.query(`CREATE DATABASE "${name}" TEMPLATE "${TEST_DATABASE_NAME}"`);
          } catch (retryErr) {
            const report = await pgStatActivityReport(maint, TEST_DATABASE_NAME);
            fatal(
              `reset-test-databases: FATAL — CREATE DATABASE "${name}" TEMPLATE "${TEST_DATABASE_NAME}" ` +
                `failed twice: ${(retryErr as Error).message}\n` +
                `  target: ${target}\n` +
                `  pg_stat_activity for template "${TEST_DATABASE_NAME}":\n${report}`,
            );
          }
        } else {
          fatal(
            `reset-test-databases: FATAL — CREATE DATABASE "${name}" TEMPLATE "${TEST_DATABASE_NAME}" ` +
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
        const comment =
          `${TEST_DATABASE_MARKER} — provisioned by apps/api/scripts/reset-test-databases.ts ` +
          `(Phase 106). Contents are disposable.`;
        const escaped = escapeLiteral(comment);
        await workerClient.query(`COMMENT ON DATABASE "${name}" IS '${escaped}'`);
      } catch (err) {
        await workerClient.end().catch(() => {});
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
