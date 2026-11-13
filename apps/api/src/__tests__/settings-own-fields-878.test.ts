/**
 * Issue #878 — the server half of "each settings section sends only its own fields".
 *
 * PUT /settings/work is a partial update: a field the body does not name stays as stored. So once
 * a page sends only its own fields (pinned per save in
 * apps/web/src/__tests__/settings-own-fields-878.test.ts), a change saved in the meantime through
 * another page survives. Each case below replays one page pair with the exact payload shape the
 * web pin allows: change A through page X, then save page Y whose copy was loaded BEFORE A — A
 * stays, and the audit row of Y's save names only the fields Y actually changed.
 *
 * The last case characterises why the fix sits in the web: the endpoint is last-writer-wins, so
 * the former load-time copy (every field read at page load) overwrote A with its old value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, soleAuditRow } from "./setup";

describe("PUT /settings/work keeps fields a page does not send (Issue #878)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let configId: string;
  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  async function put(payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: auth(),
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  async function auditIds(): Promise<string[]> {
    return (
      await app.prisma.auditLog.findMany({
        where: { entity: "TenantConfig", entityId: configId, action: "UPDATE" },
        select: { id: true },
      })
    ).map((r) => r.id);
  }
  /** The one UPDATE row written since `known`, i.e. by the save just made. */
  async function latestAudit(known: string[]) {
    return soleAuditRow(app.prisma, {
      where: { entity: "TenantConfig", entityId: configId, action: "UPDATE", id: { notIn: known } },
    });
  }
  const config = () =>
    app.prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: data.tenant.id } });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "own878");
    await put({ defaultBreakOver6h: 30, defaultBreakOver9h: 45 }); // ensure the config row exists
    configId = (await config()).id;
  });
  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("/admin/system Pausendauer after /admin/vacation: the vacation change stays, the audit names only the break fields", async () => {
    const before = await config(); // the system page's copy, loaded before A
    const changedDays = Number(before.defaultVacationDays) === 27 ? 28 : 27;
    await put({ defaultVacationDays: changedDays }); // A, through /admin/vacation

    const known = await auditIds();
    await put({ defaultBreakOver6h: 40, defaultBreakOver9h: 50 }); // saveBreakDefaults
    const after = await config();
    expect(Number(after.defaultVacationDays)).toBe(changedDays);
    expect(after.defaultBreakOver6h).toBe(40);
    const row = await latestAudit(known);
    expect(Object.keys(row.oldValue as object).sort()).toEqual([
      "defaultBreakOver6h",
      "defaultBreakOver9h",
    ]);
  });

  it("/admin/system Arbeitstage after the company section: the time zone change stays", async () => {
    await put({ timezone: "Europe/Vienna" }); // A, through saveFederalState
    const known = await auditIds();
    await put({ defaultWorkDays: [1, 2, 3, 4] }); // saveDefaultWorkDays
    const after = await config();
    expect(after.timezone).toBe("Europe/Vienna");
    const row = await latestAudit(known);
    expect(Object.keys(row.newValue as object).filter((k) => k !== "appliedCount")).toEqual([
      "defaultWorkDays",
    ]);
    await put({ timezone: "Europe/Berlin", defaultWorkDays: [1, 2, 3, 4, 5] });
  });

  it("/admin/system break confirmation toggles do not reset each other", async () => {
    await put({ enforceBreakConfirmation: true, blockMonthCloseOnUnconfirmedBreak: false });
    await put({ blockMonthCloseOnUnconfirmedBreak: true }); // A, through the second toggle
    await put({ enforceBreakConfirmation: true }); // the first toggle, from a page loaded before A
    expect((await config()).blockMonthCloseOnUnconfirmedBreak).toBe(true);
    await put({ enforceBreakConfirmation: false, blockMonthCloseOnUnconfirmedBreak: false });
  });

  it("/admin/export DATEV after /admin/vacation and /admin/system: both changes stay, the audit names only DATEV fields", async () => {
    const before = await config();
    const threshold = Number(before.overtimeThreshold) === 12 ? 14 : 12;
    await put({ overtimeThreshold: threshold }); // A, through /admin/vacation
    await put({ autoBreakEnabled: true, defaultBreakStart: "12:30" }); // B, through /admin/system

    const known = await auditIds();
    await put({
      datevNormalstundenNr: 110,
      datevUrlaubNr: 310,
      datevKrankNr: 210,
      datevSonderurlaubNr: 312,
      datevBeraterNr: 1234567,
      datevMandantenNr: 12345,
    }); // saveDatev
    const after = await config();
    expect(Number(after.overtimeThreshold)).toBe(threshold);
    expect(after.autoBreakEnabled).toBe(true);
    expect(after.defaultBreakStart).toBe("12:30");
    const row = await latestAudit(known);
    for (const key of Object.keys(row.oldValue as object)) expect(key).toMatch(/^datev/);
  });

  it("characterisation: the former load-time copy overwrote a change saved in between", async () => {
    const loaded = await config(); // what a page used to keep and send back
    const changedDays = Number(loaded.defaultVacationDays) === 25 ? 26 : 25;
    await put({ defaultVacationDays: changedDays }); // A
    await put({ defaultVacationDays: Number(loaded.defaultVacationDays), defaultBreakOver6h: 30 }); // old shape
    expect(Number((await config()).defaultVacationDays)).toBe(Number(loaded.defaultVacationDays));
  });
});
