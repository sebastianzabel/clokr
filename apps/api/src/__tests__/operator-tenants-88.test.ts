/**
 * Phase 88 plan 11 (AC-88-05…10, D-04/D-05/D-07/D-09) — the operator manages tenants through
 * /api/v1/operator/tenants: create (immediately usable), list/get as metadata only, rename,
 * deactivate/reactivate, re-issue the first admin's invitation.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, seedOperator, cleanupTestData } from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import { ensureDefaultLeaveTypes } from "../contexts/absence";

const PASSWORD = "Usab1lity-Passw0rd!2026";
const BASE = "/api/v1/operator/tenants";

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
let operatorId: string;
let operatorToken: string;
let addressCounter = 0;
const createdTenantIds: string[] = [];
let mailSpy: ReturnType<typeof vi.spyOn>;
let mails: { to: string; firstName: string; token: string; tenantId: string }[] = [];

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.89.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  token?: string,
  body?: unknown,
) {
  return app.inject({
    method,
    url,
    ...(body !== undefined ? { payload: body as object } : {}),
    headers: {
      "user-agent": "vitest-operator-tenants",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    remoteAddress: uniqueAddress(),
  });
}

function uniqueSlug(label: string): string {
  return `t88-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function createBody(label: string, overrides: Record<string, unknown> = {}) {
  const slug = uniqueSlug(label);
  return {
    name: `Mandant ${slug}`,
    slug,
    federalState: "SACHSEN",
    admin: { email: `${slug}@example.invalid`, firstName: "Erste", lastName: "Leitung" },
    ...overrides,
  };
}

async function createTenant(label: string, overrides: Record<string, unknown> = {}) {
  const body = createBody(label, overrides);
  const res = await call("POST", BASE, operatorToken, body);
  expect(res.statusCode, res.body).toBe(201);
  const parsed = JSON.parse(res.body) as {
    tenant: { id: string };
    defaultSalonId: string;
    adminEmployeeId: string;
    invitationMailSent: boolean;
  };
  createdTenantIds.push(parsed.tenant.id);
  return { body, parsed, mail: mails[mails.length - 1] };
}

async function loginAs(email: string, password = PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    remoteAddress: uniqueAddress(),
  });
}

async function acceptAndLogin(email: string, token: string): Promise<string> {
  const accept = await app.inject({
    method: "POST",
    url: "/api/v1/invitations/accept",
    payload: { token, password: PASSWORD },
    remoteAddress: uniqueAddress(),
  });
  expect(accept.statusCode, accept.body).toBe(200);
  const login = await loginAs(email);
  expect(login.statusCode, login.body).toBe(200);
  return (JSON.parse(login.body) as { accessToken: string }).accessToken;
}

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app, "ot88");
  const operator = await seedOperator(app);
  operatorId = operator.id;
  operatorToken = signOperatorToken(app, operatorId, "access");
  mailSpy = vi.spyOn(app.mailer, "sendInvitation").mockImplementation(async (params) => {
    mails.push(params);
  });
});

afterEach(() => {
  mailSpy.mockClear();
});

afterAll(async () => {
  mailSpy.mockRestore();
  for (const id of createdTenantIds) await cleanupTestData(app, id);
  await cleanupTestData(app, data.tenant.id);
  await closeTestApp();
});

const DTO_KEYS = [
  "createdAt",
  "deactivatedAt",
  "deactivatedReason",
  "federalState",
  "id",
  "name",
  "slug",
];

describe("POST /api/v1/operator/tenants (tracer)", () => {
  it("creates a tenant its first admin can use right away, and never returns the invitation token", async () => {
    mails = [];
    const { body, parsed, mail } = await createTenant("tracer");

    expect(Object.keys(parsed).sort()).toEqual([
      "adminEmployeeId",
      "defaultSalonId",
      "invitationMailSent",
      "tenant",
    ]);
    expect(Object.keys(parsed.tenant).sort()).toEqual(DTO_KEYS);
    expect(parsed.invitationMailSent).toBe(true);
    expect(mail.token.length).toBeGreaterThan(10);
    expect(mail.to).toBe(body.admin.email);

    // The raw token appears nowhere in the response (T-88-52).
    const res = await call("GET", `${BASE}/${parsed.tenant.id}`, operatorToken);
    expect(res.body).not.toContain(mail.token);

    const accessToken = await acceptAndLogin(body.admin.email, mail.token);
    const context = await app.inject({
      method: "GET",
      url: "/api/v1/me/context",
      headers: { authorization: `Bearer ${accessToken}` },
      remoteAddress: uniqueAddress(),
    });
    expect(context.statusCode, context.body).toBe(200);
    const salons = (JSON.parse(context.body) as { salons: { id: string }[] }).salons;
    expect(salons.map((s) => s.id)).toEqual([parsed.defaultSalonId]);
    const salon = await app.prisma.salon.findUniqueOrThrow({
      where: { id: parsed.defaultSalonId },
    });
    expect(salon.federalState).toBe("SACHSEN");
  });

  it("writes exactly one TENANT_CREATED row with the ids and no e-mail address", async () => {
    const { body, parsed } = await createTenant("audit");
    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_CREATED", subjectTenantId: parsed.tenant.id },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.operatorId).toBe(operatorId);
    expect(row.entityId).toBe(parsed.tenant.id);
    expect(row.ipAddress).toBeTruthy();
    expect(row.userAgent).toBe("vitest-operator-tenants");
    const newValue = row.newValue as Record<string, unknown>;
    expect(Object.keys(newValue).sort()).toEqual([
      "adminEmployeeId",
      "adminUserId",
      "defaultSalonId",
      "tenant",
    ]);
    expect(newValue.defaultSalonId).toBe(parsed.defaultSalonId);
    expect(newValue.adminEmployeeId).toBe(parsed.adminEmployeeId);
    expect(JSON.stringify(row.newValue)).not.toContain(body.admin.email);
  });

  it("gives the new tenant its default leave types and the first admin a hire-year VACATION entitlement", async () => {
    const { parsed } = await createTenant("leave");
    const types = await app.prisma.leaveType.findMany({
      where: { tenantId: parsed.tenant.id },
      select: { code: true },
    });
    expect(types.map((t) => t.code).sort()).toEqual(
      [
        "EDUCATION",
        "MATERNITY",
        "OVERTIME_COMP",
        "PARENTAL",
        "SICK",
        "SICK_CHILD",
        "SPECIAL",
        "UNPAID",
        "VACATION",
      ].sort(),
    );
    const employee = await app.prisma.employee.findUniqueOrThrow({
      where: { id: parsed.adminEmployeeId },
      select: { hireDate: true },
    });
    const entitlements = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId: parsed.adminEmployeeId, leaveType: { code: "VACATION" } },
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].year).toBe(employee.hireDate.getFullYear());
    expect(Number(entitlements[0].totalDays)).toBeGreaterThan(0);
  });

  it("ensureDefaultLeaveTypes is idempotent and never overwrites a renamed type", async () => {
    const { parsed } = await createTenant("idem");
    await app.prisma.leaveType.updateMany({
      where: { tenantId: parsed.tenant.id, code: "VACATION" },
      data: { name: "Erholungsurlaub" },
    });
    const created = await app.prisma.$transaction((tx) =>
      ensureDefaultLeaveTypes(tx, parsed.tenant.id),
    );
    expect(created).toBe(0);
    const vacation = await app.prisma.leaveType.findFirstOrThrow({
      where: { tenantId: parsed.tenant.id, code: "VACATION" },
    });
    expect(vacation.name).toBe("Erholungsurlaub");
    expect(await app.prisma.leaveType.count({ where: { tenantId: parsed.tenant.id } })).toBe(9);
  });

  it("requires federalState (no default), rejects unknown keys and a malformed slug", async () => {
    const { federalState: _omit, ...withoutState } = createBody("nostate");
    void _omit;
    expect((await call("POST", BASE, operatorToken, withoutState)).statusCode).toBe(400);
    expect(
      (await call("POST", BASE, operatorToken, { ...createBody("extra"), isAdmin: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call("POST", BASE, operatorToken, createBody("bad", { slug: "Ungültig Slug" })))
        .statusCode,
    ).toBe(400);
    const adminExtra = createBody("adminextra");
    expect(
      (
        await call("POST", BASE, operatorToken, {
          ...adminExtra,
          admin: { ...adminExtra.admin, role: "ADMIN" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("answers a taken slug and a taken e-mail with 409 and leaves no tenant behind", async () => {
    const first = await createTenant("dup");
    const taken = createBody("dup2", { slug: first.body.slug });
    const slugRes = await call("POST", BASE, operatorToken, taken);
    expect(slugRes.statusCode).toBe(409);
    expect(JSON.parse(slugRes.body).code).toBe("SLUG_TAKEN");

    const emailBody = createBody("dup3");
    emailBody.admin.email = first.body.admin.email;
    const emailRes = await call("POST", BASE, operatorToken, emailBody);
    expect(emailRes.statusCode).toBe(409);
    expect(JSON.parse(emailRes.body).code).toBe("EMAIL_TAKEN");
    expect(await app.prisma.tenant.count({ where: { slug: emailBody.slug } })).toBe(0);
  });

  it("maps a unique-constraint race after the pre-checks to 409 as well", async () => {
    const first = await createTenant("race");
    // Hide the pre-check from L3 so the insert itself hits the unique index: the thrown
    // TenantProvisioningConflictError must still end as a 409 and roll everything back.
    const original = app.prisma.$transaction.bind(app.prisma);
    const spy = vi.spyOn(app.prisma, "$transaction").mockImplementationOnce(((
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      original(async (tx) => {
        const proxy = new Proxy(tx, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop === "tenant") {
              return new Proxy(value as object, {
                get(t, p) {
                  if (p === "findUnique") return async () => null;
                  return Reflect.get(t, p);
                },
              });
            }
            return value;
          },
        });
        return fn(proxy);
      })) as never);
    const res = await call(
      "POST",
      BASE,
      operatorToken,
      createBody("race2", { slug: first.body.slug }),
    );
    spy.mockRestore();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("SLUG_TAKEN");
    expect(await app.prisma.tenant.count({ where: { slug: first.body.slug } })).toBe(1);
  });

  it("still creates the tenant when the mail fails and reports invitationMailSent false", async () => {
    mailSpy.mockRejectedValueOnce(new Error("SMTP nicht konfiguriert"));
    const body = createBody("nomail");
    const res = await call("POST", BASE, operatorToken, body);
    expect(res.statusCode, res.body).toBe(201);
    const parsed = JSON.parse(res.body);
    createdTenantIds.push(parsed.tenant.id);
    expect(parsed.invitationMailSent).toBe(false);
    expect(await app.prisma.tenant.count({ where: { slug: body.slug } })).toBe(1);
  });
});

describe("GET /api/v1/operator/tenants and /:id", () => {
  it("lists tenants (deactivated included) and returns exactly the metadata keys", async () => {
    const { parsed } = await createTenant("list");
    await app.prisma.tenant.update({
      where: { id: parsed.tenant.id },
      data: { deactivatedAt: new Date(), deactivatedReason: "Test" },
    });

    const list = await call("GET", BASE, operatorToken);
    expect(list.statusCode).toBe(200);
    const items = JSON.parse(list.body) as { id: string; deactivatedAt: string | null }[];
    for (const item of items) expect(Object.keys(item).sort()).toEqual(DTO_KEYS);
    const expectedOrder = await app.prisma.tenant.findMany({
      select: { id: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    expect(items.map((i) => i.id)).toEqual(expectedOrder.map((t) => t.id));
    expect(items.find((i) => i.id === parsed.tenant.id)?.deactivatedAt).toBeTruthy();

    const one = await call("GET", `${BASE}/${parsed.tenant.id}`, operatorToken);
    expect(one.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(one.body)).sort()).toEqual(DTO_KEYS);
  });

  it("answers an unknown id with 404", async () => {
    const res = await call("GET", `${BASE}/00000000-0000-4000-8000-000000000088`, operatorToken);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mandant nicht gefunden" });
  });
});

describe("operator tenant routes refuse the tenant principal", () => {
  it("answers a tenant admin token with 403 TENANT_PRINCIPAL_REFUSED and no token with 401", async () => {
    const listRes = await call("GET", BASE, data.adminToken);
    expect(listRes.statusCode).toBe(403);
    const createRes = await call("POST", BASE, data.adminToken, createBody("refused"));
    expect(createRes.statusCode).toBe(403);
    expect(await app.prisma.tenant.count({ where: { slug: { startsWith: "t88-refused" } } })).toBe(
      0,
    );

    const refusals = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_PRINCIPAL_REFUSED", subjectTenantId: data.tenant.id },
    });
    expect(refusals.length).toBeGreaterThanOrEqual(1);

    expect((await call("GET", BASE)).statusCode).toBe(401);
    expect((await call("POST", BASE, undefined, createBody("anon"))).statusCode).toBe(401);
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe("PATCH /api/v1/operator/tenants/:id (rename)", () => {
  it("changes the name only, audits old and new, and writes nothing for an unchanged name", async () => {
    const { parsed } = await createTenant("rename");
    const before = await app.prisma.tenant.findUniqueOrThrow({ where: { id: parsed.tenant.id } });
    const salonBefore = await app.prisma.salon.findUniqueOrThrow({
      where: { id: parsed.defaultSalonId },
    });

    const res = await call("PATCH", `${BASE}/${parsed.tenant.id}`, operatorToken, {
      name: "  Neuer Name  ",
    });
    expect(res.statusCode, res.body).toBe(200);
    const dto = JSON.parse(res.body);
    expect(Object.keys(dto).sort()).toEqual(DTO_KEYS);
    expect(dto.name).toBe("Neuer Name");
    expect(dto.slug).toBe(before.slug);

    const salonAfter = await app.prisma.salon.findUniqueOrThrow({
      where: { id: parsed.defaultSalonId },
    });
    expect(salonAfter.name).toBe(salonBefore.name);

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_RENAMED", subjectTenantId: parsed.tenant.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBe(operatorId);
    expect(rows[0].oldValue).toEqual({ name: before.name });
    expect(rows[0].newValue).toEqual({ name: "Neuer Name" });

    const same = await call("PATCH", `${BASE}/${parsed.tenant.id}`, operatorToken, {
      name: "Neuer Name",
    });
    expect(same.statusCode).toBe(200);
    expect(
      await app.prisma.operatorAuditLog.count({
        where: { action: "TENANT_RENAMED", subjectTenantId: parsed.tenant.id },
      }),
    ).toBe(1);
  });

  it("rejects an extra key, an empty name and an unknown id", async () => {
    const { parsed } = await createTenant("rename2");
    const url = `${BASE}/${parsed.tenant.id}`;
    expect((await call("PATCH", url, operatorToken, { name: "X", slug: "y" })).statusCode).toBe(
      400,
    );
    expect((await call("PATCH", url, operatorToken, { name: "   " })).statusCode).toBe(400);
    expect(
      (
        await call("PATCH", `${BASE}/00000000-0000-4000-8000-000000000088`, operatorToken, {
          name: "X",
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("deactivate and reactivate", () => {
  let data2: Awaited<ReturnType<typeof seedTestData>>;
  let refreshSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    data2 = await seedTestData(app, "ot88b");
    await app.prisma.tenantConfig.update({
      where: { tenantId: data2.tenant.id },
      data: { twoFaEnabled: false },
    });
    refreshSpy = vi.fn(async () => undefined);
    app.refreshScheduler = refreshSpy as unknown as () => Promise<void>;
  });

  afterAll(async () => {
    delete app.refreshScheduler;
    await cleanupTestData(app, data2.tenant.id);
  });

  async function counts() {
    const tenantId = data2.tenant.id;
    const [employees, users, timeEntries, salons, configs, leaveRequests, invitations] =
      await Promise.all([
        app.prisma.employee.count({ where: { tenantId } }),
        app.prisma.user.count({ where: { employee: { tenantId } } }),
        app.prisma.timeEntry.count({ where: { employee: { tenantId } } }),
        app.prisma.salon.count({ where: { tenantId } }),
        app.prisma.tenantConfig.count({ where: { tenantId } }),
        app.prisma.leaveRequest.count({ where: { employee: { tenantId } } }),
        app.prisma.invitation.count({ where: { employee: { tenantId } } }),
      ]);
    return { employees, users, timeEntries, salons, configs, leaveRequests, invitations };
  }

  it("deactivates immediately without any explicit cache invalidation, keeps the data and refuses every credential", async () => {
    const url = `${BASE}/${data2.tenant.id}`;
    // Prime the tenant-state cache with "active": only the route's own post-commit invalidation
    // can make the next request see the change (no invalidateTenantState call in this test).
    const primed = await app.inject({
      method: "GET",
      url: "/api/v1/me/context",
      headers: { authorization: `Bearer ${data2.adminToken}` },
      remoteAddress: uniqueAddress(),
    });
    expect(primed.statusCode).toBe(200);
    const login = await loginAs(data2.empUser.email, "test1234");
    expect(login.statusCode, login.body).toBe(200);
    const { refreshToken } = JSON.parse(login.body) as { refreshToken: string };
    const before = await counts();

    refreshSpy.mockClear();
    const missingReason = await call("POST", `${url}/deactivate`, operatorToken, {});
    expect(missingReason.statusCode).toBe(400);
    expect(
      (await call("POST", `${url}/deactivate`, operatorToken, { reason: "ab" })).statusCode,
    ).toBe(400);

    const res = await call("POST", `${url}/deactivate`, operatorToken, {
      reason: "Vertrag beendet",
    });
    expect(res.statusCode, res.body).toBe(200);
    const dto = JSON.parse(res.body);
    expect(Object.keys(dto).sort()).toEqual(DTO_KEYS);
    expect(dto.deactivatedAt).toBeTruthy();
    expect(dto.deactivatedReason).toBe("Vertrag beendet");
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    const refused = await app.inject({
      method: "GET",
      url: "/api/v1/me/context",
      headers: { authorization: `Bearer ${data2.adminToken}` },
      remoteAddress: uniqueAddress(),
    });
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).code).toBe("TENANT_DEACTIVATED");

    const relogin = await loginAs(data2.empUser.email, "test1234");
    expect(relogin.statusCode).toBe(403);
    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
      remoteAddress: uniqueAddress(),
    });
    // Deactivation revoked the open refresh token, so the refresh is refused (401 revoked / 403 tenant).
    expect([401, 403]).toContain(refresh.statusCode);

    expect(await counts()).toEqual(before);

    const again = await call("POST", `${url}/deactivate`, operatorToken, { reason: "nochmal" });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body).code).toBe("ALREADY_DEACTIVATED");

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "TENANT_DEACTIVATED", subjectTenantId: data2.tenant.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBe(operatorId);
  });

  it("reactivates: sign-in works again, a second reactivation is a 409", async () => {
    const url = `${BASE}/${data2.tenant.id}`;
    refreshSpy.mockClear();
    const res = await call("POST", `${url}/reactivate`, operatorToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).deactivatedAt).toBeNull();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    const again = await call("POST", `${url}/reactivate`, operatorToken);
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body).code).toBe("NOT_DEACTIVATED");

    const relogin = await loginAs(data2.empUser.email, "test1234");
    expect(relogin.statusCode, relogin.body).toBe(200);
    expect(
      await app.prisma.operatorAuditLog.count({
        where: { action: "TENANT_REACTIVATED", subjectTenantId: data2.tenant.id },
      }),
    ).toBe(1);
  });

  it("answers an unknown tenant id with 404 on both routes", async () => {
    const ghost = `${BASE}/00000000-0000-4000-8000-000000000089`;
    expect(
      (await call("POST", `${ghost}/deactivate`, operatorToken, { reason: "abc" })).statusCode,
    ).toBe(404);
    expect((await call("POST", `${ghost}/reactivate`, operatorToken)).statusCode).toBe(404);
  });
});

describe("POST /api/v1/operator/tenants/:id/resend-admin-invitation", () => {
  it("issues a new token and expires the old invitation while nobody has signed in", async () => {
    const { body, parsed, mail } = await createTenant("resend");
    const oldToken = mail.token;
    const res = await call(
      "POST",
      `${BASE}/${parsed.tenant.id}/resend-admin-invitation`,
      operatorToken,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ invitationMailSent: true });
    expect(res.body).not.toContain(oldToken);

    const resent = mails[mails.length - 1];
    expect(resent.to).toBe(body.admin.email);
    expect(resent.token).not.toBe(oldToken);
    expect(res.body).not.toContain(resent.token);

    const oldAccept = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token: oldToken, password: PASSWORD },
      remoteAddress: uniqueAddress(),
    });
    expect(oldAccept.statusCode).toBeGreaterThanOrEqual(400);

    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { action: "ADMIN_INVITATION_RESENT", subjectTenantId: parsed.tenant.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].newValue).toEqual({ employeeId: parsed.adminEmployeeId });

    // Once the admin accepted, the bootstrap window is closed.
    await acceptAndLogin(body.admin.email, resent.token);
    const late = await call(
      "POST",
      `${BASE}/${parsed.tenant.id}/resend-admin-invitation`,
      operatorToken,
    );
    expect(late.statusCode).toBe(409);
    expect(JSON.parse(late.body).code).toBe("TENANT_IN_USE");
  });

  it("is refused on a deactivated tenant and unknown for an unknown id", async () => {
    const { parsed } = await createTenant("resend2");
    await app.prisma.tenant.update({
      where: { id: parsed.tenant.id },
      data: { deactivatedAt: new Date(), deactivatedReason: "Test" },
    });
    const res = await call(
      "POST",
      `${BASE}/${parsed.tenant.id}/resend-admin-invitation`,
      operatorToken,
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("TENANT_DEACTIVATED");

    const ghost = await call(
      "POST",
      `${BASE}/00000000-0000-4000-8000-000000000090/resend-admin-invitation`,
      operatorToken,
    );
    expect(ghost.statusCode).toBe(404);
  });

  it("reports invitationMailSent false when the mail fails", async () => {
    const { parsed } = await createTenant("resend3");
    mailSpy.mockRejectedValueOnce(new Error("SMTP nicht konfiguriert"));
    const res = await call(
      "POST",
      `${BASE}/${parsed.tenant.id}/resend-admin-invitation`,
      operatorToken,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ invitationMailSent: false });
  });
});

describe("the operator surface cannot delete and refuses tenant tokens on every lifecycle route", () => {
  it("has no DELETE route under /api/v1/operator and answers DELETE with 404", async () => {
    const routes = app.printRoutes({ commonPrefix: false });
    const operatorLines = routes.split("\n").filter((line) => line.includes("operator"));
    expect(operatorLines.length).toBeGreaterThan(0);
    expect(operatorLines.some((line) => /\(DELETE/.test(line))).toBe(false);
    const { parsed } = await createTenant("nodelete");
    const res = await call("DELETE", `${BASE}/${parsed.tenant.id}`, operatorToken);
    expect(res.statusCode).toBe(404);
    expect(await app.prisma.tenant.count({ where: { id: parsed.tenant.id } })).toBe(1);
  });

  it("answers a tenant admin token with 403 on rename, deactivate, reactivate and resend", async () => {
    const id = data.tenant.id;
    const attempts = [
      call("PATCH", `${BASE}/${id}`, data.adminToken, { name: "Übernommen" }),
      call("POST", `${BASE}/${id}/deactivate`, data.adminToken, { reason: "Übernahme" }),
      call("POST", `${BASE}/${id}/reactivate`, data.adminToken),
      call("POST", `${BASE}/${id}/resend-admin-invitation`, data.adminToken),
      call("GET", `${BASE}/${id}`, data.adminToken),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(403);
    const tenant = await app.prisma.tenant.findUniqueOrThrow({ where: { id } });
    expect(tenant.deactivatedAt).toBeNull();
    expect(tenant.name).not.toBe("Übernommen");
  });
});
