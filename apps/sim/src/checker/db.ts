/**
 * The checker's database access: one connection that cannot write. Three independent layers: the
 * database role has only SELECT (sql/readonly-role.sql), every session of it starts read-only, and
 * the checker additionally opens every unit of work as `BEGIN READ ONLY`. A write attempt fails at
 * the first layer that is present, and the test in sim-invariants-715 pins that it fails.
 */
import pg from "pg";
import type { Queryable } from "./types";

export interface ReadOnlyConnection extends Queryable {
  close(): Promise<void>;
}

export async function connectReadOnly(connectionString: string): Promise<ReadOnlyConnection> {
  const client = new pg.Client({
    connectionString,
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  await client.query("BEGIN READ ONLY");
  return {
    query: async <R>(sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as R[] };
    },
    close: async () => {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    },
  };
}
