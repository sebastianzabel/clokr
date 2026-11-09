/**
 * Issue #573 (D-12…D-14) — the API's error contract, measured on real routes:
 * - a validation answer is 400 "Validierungsfehler", every text German (no English Zod default),
 *   `details[]` carries path, field and message, the `message` summary names no field key;
 * - a duplicate nobody handled is a 409 with plain German text instead of a 500.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { englishZodFragmentsIn } from "./english-zod-fragments";

type Detail = { path: Array<string | number>; field: string; code: string; message: string };
type ValidationBody = { error: string; message: string; details: Detail[] };

describe("Issue #573 — German validation contract and 409 for duplicates", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "aem573");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  const send = (method: "POST" | "PUT" | "PATCH", url: string, payload: unknown, token?: string) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token ?? data.adminToken}` },
      payload: payload as Record<string, unknown>,
    });

  /** A representative sample across the contexts; each body is invalid in a different way. */
  const cases: Array<[string, "POST" | "PUT" | "PATCH", () => string, unknown]> = [
    ["create employee, empty body", "POST", () => "/api/v1/employees", {}],
    [
      "create employee, wrong formats",
      "POST",
      () => "/api/v1/employees",
      {
        email: "keine-mail",
        firstName: "",
        lastName: 7,
        employeeNumber: "",
        hireDate: "morgen",
        role: "BOSS",
        weeklyHours: 99,
      },
    ],
    ["time entry, empty body", "POST", () => "/api/v1/time-entries", {}],
    [
      "time entry, wrong times",
      "POST",
      () => "/api/v1/time-entries",
      { date: "heute", startTime: "acht", employeeId: "nicht-uuid" },
    ],
    ["leave request, empty body", "POST", () => "/api/v1/leave/requests", {}],
    [
      "work schedule, wrong types",
      "PUT",
      () => `/api/v1/settings/work/${data.employee.id}`,
      { type: "IRGENDWAS", weeklyHours: "viel", workDays: [] },
    ],
    ["special-leave rule, empty body", "POST", () => "/api/v1/special-leave/rules", {}],
    [
      "special-leave rule, out of range",
      "POST",
      () => "/api/v1/special-leave/rules",
      { name: "x".repeat(101), defaultDays: 99 },
    ],
    ["holiday, empty body", "POST", () => "/api/v1/holidays", {}],
  ];

  it.each(cases)("%s → 400, German only, no field key in the summary", async (_n, m, url, body) => {
    const res = await send(m, url(), body);
    expect(res.statusCode, res.body).toBe(400);
    const json = JSON.parse(res.body) as ValidationBody;
    expect(json.error).toBe("Validierungsfehler");
    expect(json.details.length).toBeGreaterThan(0);

    const texts = [json.message, ...json.details.map((d) => d.message)];
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      expect(englishZodFragmentsIn(text), text).toEqual([]);
    }
    for (const d of json.details) {
      expect(Array.isArray(d.path)).toBe(true);
      expect(d.field).toBe(d.path.join("."));
      for (const key of d.path.filter((p): p is string => typeof p === "string")) {
        // A key is a camelCase identifier; the summary must never print it as a word.
        if (/[a-z][A-Z]|^[a-z]+$/.test(key)) {
          expect(json.message, `summary names the key "${key}"`).not.toMatch(
            new RegExp(`(^|[^\\p{L}])${key}([^\\p{L}]|$)`, "u"),
          );
        }
      }
    }
  });

  it("a duplicate special-leave occasion is 409 'Diesen Anlass gibt es bereits.' (create and rename)", async () => {
    const first = await send("POST", "/api/v1/special-leave/rules", {
      name: "Umzug 573",
      defaultDays: 1,
    });
    expect(first.statusCode, first.body).toBe(200);
    const again = await send("POST", "/api/v1/special-leave/rules", {
      name: "Umzug 573",
      defaultDays: 2,
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(JSON.parse(again.body)).toEqual({
      error: "Diesen Anlass gibt es bereits.",
      code: "DUPLICATE",
    });

    const other = await send("POST", "/api/v1/special-leave/rules", {
      name: "Hausbau 573",
      defaultDays: 1,
    });
    expect(other.statusCode, other.body).toBe(200);
    const otherId = (JSON.parse(other.body) as { id: string }).id;
    const rename = await send("PUT", `/api/v1/special-leave/rules/${otherId}`, {
      name: "Umzug 573",
    });
    expect(rename.statusCode, rename.body).toBe(409);
    expect((JSON.parse(rename.body) as { error: string }).error).toBe(
      "Diesen Anlass gibt es bereits.",
    );
  });

  it("an NFC card already held by another person is 409 with plain text, not 500", async () => {
    const card = `NFC573-${Date.now().toString(36)}`;
    const own = await send("PATCH", `/api/v1/employees/${data.adminEmployee.id}`, {
      nfcCardId: card,
    });
    expect(own.statusCode, own.body).toBe(200);
    const taken = await send("PATCH", `/api/v1/employees/${data.employee.id}`, { nfcCardId: card });
    expect(taken.statusCode, taken.body).toBe(409);
    const body = JSON.parse(taken.body) as { error: string; code: string };
    expect(body.error).toBe("Diese NFC-Karte ist bereits einer anderen Person zugeordnet.");
    expect(body.code).toBe("DUPLICATE");
    expect(taken.body).not.toContain(card);
  });
});
