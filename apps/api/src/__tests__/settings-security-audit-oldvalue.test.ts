/**
 * settings-security-audit-oldvalue.test.ts
 *
 * Issue #148 — `PUT /api/v1/settings/security` wrote an AuditLog row whose `oldValue` listed
 * three fields (twoFaEnabled, passwordMinLength, maxNegativeBalanceMinutes) while the same
 * request could write twenty-two. The before-state of the other nineteen — the e-mail
 * notification flags among them — was therefore not reconstructible from the trail, against
 * CLAUDE.md § Audit-Proof ("before/after values", "who changed what, when and why").
 *
 * This suite pins the FULL field set and the ACTUAL previous values, not just the one flag the
 * ticket names:
 *
 *   1. It establishes a baseline in which EVERY writable field holds a value that differs from
 *      its column default. `it("fixture is discriminating")` asserts exactly that, so a
 *      projection that silently fell back to defaults cannot pass by coincidence.
 *   2. It then sends a request that touches ONE field and asserts the audit row's `oldValue`
 *      deep-equals the whole baseline — which is only true if every field is read off the stored
 *      row.
 *   3. It asserts the key set of `oldValue` equals the writable field set derived from the
 *      route's own Zod schema, so dropping a field from the projection goes red even if the
 *      remaining values still match.
 *
 * Anti-vacuity: the assertions were seen red against the pre-fix implementation (the
 * hand-written three-field `oldValue`) before being accepted — see PR body for both runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import {
  SECURITY_SETTINGS_DEFAULTS,
  SECURITY_SETTINGS_FIELDS,
  type SecuritySettings,
} from "../contexts/platform/api/settings";

/**
 * A complete security-settings state in which every single field differs from its column
 * default. Nothing here may equal `SECURITY_SETTINGS_DEFAULTS` — the first test enforces it.
 */
const BASELINE: SecuritySettings = {
  twoFaEnabled: true,
  passwordMinLength: 14,
  passwordRequireUpper: false,
  passwordRequireLower: false,
  passwordRequireDigit: false,
  passwordRequireSpecial: false,
  maxNegativeBalanceMinutes: 123,
  emailNotificationsEnabled: true,
  emailOnLeaveRequest: false,
  emailOnLeaveDecision: false,
  emailOnOvertimeWarning: true,
  emailOnMissingEntries: true,
  emailOnClockOutReminder: true,
  emailOnMonthClose: false,
  emailOnRetroEntry: false,
  sessionTimeoutMinutes: 45,
  refreshTokenDays: 11,
  rememberMeEnabled: false,
  rememberMeDays: 21,
  maxSessionsPerUser: 3,
  loginMaxAttempts: 9,
  loginLockoutMinutes: 27,
};

describe("PUT /api/v1/settings/security — audit oldValue completeness (issue #148)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ssao");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("fixture is discriminating: the writable field set is non-empty and no baseline value equals its default", () => {
    expect(SECURITY_SETTINGS_FIELDS.length).toBeGreaterThan(0);
    // The endpoint has had >= 20 writable fields since Phase 109; a set that suddenly shrank to
    // a handful means the schema was gutted, not that the trail got simpler.
    expect(SECURITY_SETTINGS_FIELDS.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(BASELINE).sort()).toEqual([...SECURITY_SETTINGS_FIELDS].sort());
    for (const field of SECURITY_SETTINGS_FIELDS) {
      expect(
        BASELINE[field],
        `BASELINE.${field} must differ from its column default, or this suite cannot tell a stored value from a fallback`,
      ).not.toEqual(SECURITY_SETTINGS_DEFAULTS[field]);
    }
  });

  it("writes an oldValue that carries every writable field with its actual previous value", async () => {
    // 1. Establish the baseline — every field away from its default.
    const seedRes = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/security",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: BASELINE,
    });
    expect(seedRes.statusCode).toBe(200);
    expect(JSON.parse(seedRes.body)).toEqual(BASELINE);

    const before = await app.prisma.auditLog.findMany({
      where: { entity: "TenantConfig", action: "UPDATE", entityId: data.tenant.id },
      select: { id: true },
    });
    const knownIds = new Set(before.map((l) => l.id));

    // 2. Flip exactly ONE field — the e-mail master switch named in issue #148. Everything else
    //    is absent from the payload, so its before-state exists ONLY in the audit row.
    const flipRes = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/security",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { emailNotificationsEnabled: !BASELINE.emailNotificationsEnabled },
    });
    expect(flipRes.statusCode).toBe(200);

    // 3. Exactly one new audit row, and it is the one this request wrote.
    const after = await app.prisma.auditLog.findMany({
      where: { entity: "TenantConfig", action: "UPDATE", entityId: data.tenant.id },
    });
    const fresh = after.filter((l) => !knownIds.has(l.id));
    expect(fresh).toHaveLength(1);
    const oldValue = fresh[0].oldValue as Record<string, unknown>;
    const newValue = fresh[0].newValue as Record<string, unknown>;
    expect(fresh[0].userId).toBe(data.adminUser.id);

    // 4. The key set is the complete writable set — not a hand-picked subset.
    expect(Object.keys(oldValue).sort()).toEqual([...SECURITY_SETTINGS_FIELDS].sort());

    // 5. And every value is the ACTUAL previous one, not a default fallback.
    expect(oldValue).toEqual(BASELINE);

    // 6. The field from the ticket, spelled out: before and after are both present and differ.
    expect(oldValue.emailNotificationsEnabled).toBe(BASELINE.emailNotificationsEnabled);
    expect(newValue.emailNotificationsEnabled).toBe(!BASELINE.emailNotificationsEnabled);

    // 7. The after-state is complete too, and unchanged fields kept their baseline value.
    expect(Object.keys(newValue).sort()).toEqual([...SECURITY_SETTINGS_FIELDS].sort());
    expect(newValue).toEqual({
      ...BASELINE,
      emailNotificationsEnabled: !BASELINE.emailNotificationsEnabled,
    });
  });
});
