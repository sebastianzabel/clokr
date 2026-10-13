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

async function loginAs(email: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: PASSWORD },
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
