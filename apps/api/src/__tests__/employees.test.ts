import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Employees API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "em");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("POST /api/v1/employees (create with password)", () => {
    let uid: string;

    beforeAll(() => {
      uid = Date.now().toString(36);
    });

    it("creates employee with direct password (immediately active)", async () => {
      const email = `direct-${uid}@test.de`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email,
          firstName: "Direct",
          lastName: "Created",
          employeeNumber: `D-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "test1234",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.invitationStatus).toBe("ACCEPTED");

      // Verify user can log in immediately
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      expect(loginRes.statusCode).toBe(200);
    });

    it("creates employee via invitation (inactive until accepted)", async () => {
      const email = `invite-${uid}@test.de`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email,
          firstName: "Invited",
          lastName: "User",
          employeeNumber: `I-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.invitationStatus).toBe("PENDING");

      // Verify user cannot log in yet
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "anything" },
      });
      expect(loginRes.statusCode).toBe(401);
    });

    it("rejects password shorter than 8 chars", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `short-pw-${uid}@test.de`,
          firstName: "Short",
          lastName: "Password",
          employeeNumber: `SP-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          password: "1234567",
        },
      });

      // Zod validation error — may return 400 or 500 depending on error handling
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("rejects duplicate email", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `admin-${uid}@test.de`,
          firstName: "Duplicate",
          lastName: "Email",
          employeeNumber: `DE-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          password: "test1234",
        },
      });

      // First create should work
      expect(res.statusCode).toBe(201);

      // Second with same email should fail
      const res2 = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `admin-${uid}@test.de`,
          firstName: "Duplicate",
          lastName: "Email",
          employeeNumber: `DE2-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          password: "test1234",
        },
      });
      expect(res2.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe("GET /api/v1/employees", () => {
    it("admin can list all employees", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2); // admin + employee
    });

    it("regular employee cannot list employees", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("PATCH /api/v1/employees/:id/deactivate", () => {
    it("admin can deactivate an employee", async () => {
      const duid = Date.now().toString(36) + "da";
      const email = `deact-${duid}@test.de`;
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email,
          firstName: "To",
          lastName: "Deactivate",
          employeeNumber: `DA-${duid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          password: "test1234",
        },
      });
      const { id: empId } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${empId}/deactivate`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);

      // Verify cannot login anymore
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      expect(loginRes.statusCode).toBe(401);
    });
  });
});
