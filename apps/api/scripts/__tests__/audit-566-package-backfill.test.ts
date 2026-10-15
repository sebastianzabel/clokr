/**
 * Issue #566, D-09 — fixture test for audit-566-package-backfill.ts.
 *
 * The script is a read-only preview of the Bestandsschutz grant of the packages migration. The
 * tenant-by-tenant comparison with the migration SQL lives in
 * `src/__tests__/tenant-packages-migration-566.test.ts`; this file covers the CLI, the output
 * shape (ids, numbers and names of modules and signals only) and the read-only guarantee.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  EXIT_OK,
  EXIT_ERROR,
  computePackageBackfill,
  type PackageBackfillRow,
} from "../audit-566-package-backfill";
import {
  FIXTURES,
  PackagesMigrationReplayRollback,
  buildFixtureTenant,
  readDataSection,
  readPackages,
  splitDataSectionStatements,
} from "../../src/__tests__/tenant-packages-migration-566-fixtures";

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

const PHOREST_PASSWORD = `secret-${randomUUID()}`;

/** Strips block, JSDoc and line comments so a docblock explaining the read-only rule cannot trip a scan. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

describe("audit-566-package-backfill (Issue #566, D-09)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedTestData>>;
  let run: { code: number; lines: string[] };

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedTestData(app, "audit566");
    await app.prisma.terminalApiKey.create({
      data: {
        tenantId: fixture.tenant.id,
        name: "fixture",
        keyHash: randomUUID(),
        keyPrefix: "clk_fixt",
      },
    });
    await app.prisma.tenantConfig.update({
      where: { tenantId: fixture.tenant.id },
      data: { phorestPassword: PHOREST_PASSWORD },
    });
    run = await capture(() => main([], app.prisma));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, fixture.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("prints the fixture tenant's grant and the fired signals, and exits 0", () => {
    expect(run.code).toBe(EXIT_OK);
    const line = run.lines.find((l) => l.startsWith(`tenantId=${fixture.tenant.id} `));
    expect(line, "the fixture tenant has a line").toBeDefined();
    expect(line).toContain("salonQuota=1");
    expect(line).toContain("bookedModules=INTEGRATIONS,HARDWARE_CLOCK");
    expect(line).toContain("signals=PHOREST_CREDENTIALS,TERMINAL");
    expect(run.lines.some((l) => l.startsWith("Totals: tenants="))).toBe(true);
  });

  it("returns the same rows the CLI printed, one per tenant, ordered by id", async () => {
    const rows = await computePackageBackfill(app.prisma);
    expect(rows.length).toBeGreaterThan(0);
    const ids = rows.map((r) => r.tenantId);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const own = rows.find((r) => r.tenantId === fixture.tenant.id);
    expect(own?.bookedModules).toEqual(["INTEGRATIONS", "HARDWARE_CLOCK"]);
    expect(own?.analyticsEvaluated).toBe(true);
  });

  it("prints only ids, numbers, module names and signal names — never a credential", () => {
    const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const tenantLine = new RegExp(
      `^tenantId=${UUID} salonQuota=\\d+ bookedModules=(NONE|[A-Z_]+(,[A-Z_]+)*) ` +
        `signals=(NONE|[A-Z_>0-9]+(,[A-Z_>0-9]+)*) analytics=(evaluated|not-evaluable)$`,
    );
    const totalsLine =
      /^Totals: tenants=\d+ CHAIN=\d+ INTEGRATIONS=\d+ HARDWARE_CLOCK=\d+ ANALYTICS=\d+$/;
    const tenantLines = run.lines.filter((l) => l.startsWith("tenantId="));
    expect(tenantLines.length).toBeGreaterThan(0); // anti-vacuity: the regex ran on real lines
    for (const line of tenantLines) expect(line).toMatch(tenantLine);
    expect(run.lines.filter((l) => l.startsWith("Totals:"))).toHaveLength(1);
    expect(run.lines.find((l) => l.startsWith("Totals:"))).toMatch(totalsLine);
    expect(run.lines.join("\n")).not.toContain(PHOREST_PASSWORD);
    expect(run.lines.join("\n")).not.toContain(fixture.tenant.name);
  });

  it("rejects a write flag with exit 1, and --help exits 0", async () => {
    expect((await capture(() => main(["--apply"], app.prisma))).code).toBe(EXIT_ERROR);
    expect((await capture(() => main(["--confirm"], app.prisma))).code).toBe(EXIT_ERROR);
    const help = await capture(() => main(["--help"], app.prisma));
    expect(help.code).toBe(EXIT_OK);
    expect(help.lines.join("\n")).toContain("READ-ONLY");
  });

  it("without DATABASE_URL and without an injected client it exits 1 and connects to nothing", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect((await capture(() => main([]))).code).toBe(EXIT_ERROR);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("is read-only: the source holds no write call and reads no Tenant column besides id", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../audit-566-package-backfill.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000); // anti-vacuity: the scan read a real file
    const code = codeOnly(source);
    expect(code).not.toMatch(/\b(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(code).not.toMatch(/\$executeRaw/);
    // Only the one existence probe reads through $queryRaw, and it reads the catalog.
    const rawCalls = code.match(/\$queryRaw/g) ?? [];
    expect(rawCalls).toHaveLength(2);
    expect(code.match(/information_schema\./g) ?? []).toHaveLength(2);
    // The tenant list selects the id and nothing else: the other Tenant columns of this phase do
    // not exist before the deploy.
    const tenantRead = code.match(/db\.tenant\.findMany\(([^)]*)\)/);
    expect(tenantRead, "the script reads the tenant list").not.toBeNull();
    expect((tenantRead as RegExpMatchArray)[1].replace(/\s+/g, "")).toBe("{select:{id:true}}");
    // Names, mail addresses and employee numbers are never selected.
    expect(code).not.toMatch(/firstName|lastName|email|employeeNumber|slug/);
    // The CLI declares exactly --help; no write flag exists.
    expect(code).toMatch(/options:\s*\{\s*help: \{ type: "boolean", default: false \} \}/);
  });

  it("importing the module is side-effect-free (the entrypoint guard keeps it from running)", () => {
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("audit-566-package-backfill — parity with the migration and the pre-deploy schema (D-09)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("equals the real data section tenant by tenant, on the same pre-backfill data", async () => {
    const statements = splitDataSectionStatements(readDataSection());
    expect(statements).toHaveLength(1);

    let captured:
      | {
          ids: Record<string, string>;
          preview: PackageBackfillRow[];
          after: Record<string, { modules: string[]; quota: number }>;
        }
      | undefined;
    await expect(
      app.prisma.$transaction(
        async (tx) => {
          const ids: Record<string, string> = {};
          for (const spec of FIXTURES) ids[spec.tag] = await buildFixtureTenant(tx, spec);
          // The independent dry run reads the pre-backfill data BEFORE the SQL runs.
          const preview = await computePackageBackfill(tx);
          await tx.$executeRawUnsafe(statements[0]);
          const after = await readPackages(tx, Object.values(ids));
          captured = { ids, preview, after };
          throw new PackagesMigrationReplayRollback(
            "deliberate rollback — these fixtures must never be committed",
          );
        },
        { timeout: 60000, maxWait: 30000 },
      ),
    ).rejects.toBeInstanceOf(PackagesMigrationReplayRollback);

    expect(captured, "the callback must have run to its end").toBeDefined();
    const { ids, preview, after } = captured as NonNullable<typeof captured>;
    const byId = new Map(preview.map((row) => [row.tenantId, row]));

    // The script computes what the backfill WOULD grant; the guard that keeps an operator-edited
    // row lives only in the SQL, so those fixtures are excluded from parity.
    const compared = FIXTURES.filter((f) => !f.edited);
    expect(compared.length).toBeGreaterThan(10); // anti-vacuity
    for (const spec of compared) {
      const row = byId.get(ids[spec.tag]);
      expect(row, `${spec.tag}: the dry run lists the tenant`).toBeDefined();
      expect(
        { modules: row?.bookedModules, quota: row?.salonQuota },
        `${spec.tag}: dry run equals the migration`,
      ).toEqual(after[ids[spec.tag]]);
      expect(row?.analyticsEvaluated).toBe(true);
    }
    // Which signal fired is reported too.
    expect(byId.get(ids.DELETED_SOURCE)?.signals).toEqual(["PRESENCE_SOURCE"]);
    expect(byId.get(ids.NONE)?.signals).toEqual([]);
    // The edited tenants are still previewed with what the backfill would grant, never as edited.
    expect(byId.get(ids.OPERATOR_EDITED_A)?.salonQuota).toBe(5);
    // The SQL kept both edited rows.
    expect(after[ids.OPERATOR_EDITED_A]).toEqual({ modules: [], quota: 3 });
    expect(after[ids.OPERATOR_EDITED_B]).toEqual({ modules: ["ANALYTICS"], quota: 1 });
  });

  it("survives the pre-deploy schema: no activity kinds, ANALYTICS not evaluable, every other grant printed", async () => {
    const wanted = ["NONE", "THREE_ACTIVE", "SCOPED_SALONS", "COUPLING", "TERMINAL"];
    const specs = FIXTURES.filter((f) => wanted.includes(f.tag));
    expect(specs).toHaveLength(wanted.length);

    let captured: { ids: Record<string, string>; preview: PackageBackfillRow[] } | undefined;
    await expect(
      app.prisma.$transaction(
        async (tx) => {
          const ids: Record<string, string> = {};
          for (const spec of specs) ids[spec.tag] = await buildFixtureTenant(tx, spec);
          // Recreate the int/prod schema before the v1.16.0 deploy: Phase 81 is not migrated yet
          // (DDL is transactional, so the rollback restores both names).
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TimeEntry" RENAME COLUMN "activityKind" TO "activityKind_renamed"`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TimeEntryActivityShare" RENAME TO "TimeEntryActivityShare_renamed"`,
          );
          const preview = await computePackageBackfill(tx);
          captured = { ids, preview };
          throw new PackagesMigrationReplayRollback(
            "deliberate rollback — these fixtures must never be committed",
          );
        },
        { timeout: 60000, maxWait: 30000 },
      ),
    ).rejects.toBeInstanceOf(PackagesMigrationReplayRollback);

    expect(captured, "the callback must have run to its end").toBeDefined();
    const { ids, preview } = captured as NonNullable<typeof captured>;
    const byId = new Map(preview.map((row) => [row.tenantId, row]));
    for (const spec of specs) {
      const row = byId.get(ids[spec.tag]);
      expect(row, `${spec.tag}: listed`).toBeDefined();
      expect(row?.analyticsEvaluated, `${spec.tag}: analytics not evaluable`).toBe(false);
      expect(
        { modules: row?.bookedModules, quota: row?.salonQuota },
        `${spec.tag}: every other grant is still printed`,
      ).toEqual({ modules: spec.expected.modules, quota: spec.expected.quota });
    }
    expect(preview.every((row) => !row.analyticsEvaluated)).toBe(true);
  });
});
