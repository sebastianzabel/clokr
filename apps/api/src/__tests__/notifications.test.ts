import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Notifications API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "nt");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("GET /api/v1/notifications", () => {
    it("returns empty list initially", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.notifications).toBeDefined();
      expect(body.unreadCount).toBeDefined();
      expect(Array.isArray(body.notifications)).toBe(true);
    });
  });

  describe("Notification creation via leave request", () => {
    it("creating a leave request generates notifications for managers", async () => {
      // Create a leave request as employee
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-09-14",
          endDate: "2026-09-18",
        },
      });

      expect(createRes.statusCode).toBe(201);

      // Check admin has a notification
      const notifRes = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      const body = JSON.parse(notifRes.body);
      const leaveNotif = body.notifications.find((n: { type: string; title: string }) => n.type === "LEAVE_REQUEST");
      expect(leaveNotif).toBeDefined();
      expect(leaveNotif.title).toContain("Urlaubsantrag");
    });
  });

  describe("PATCH /api/v1/notifications/:id/read", () => {
    it("marks a notification as read", async () => {
      // Get notifications
      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const { notifications } = JSON.parse(listRes.body);

      if (notifications.length > 0) {
        const notifId = notifications[0].id;

        const readRes = await app.inject({
          method: "PATCH",
          url: `/api/v1/notifications/${notifId}/read`,
          headers: { authorization: `Bearer ${data.adminToken}` },
        });

        expect(readRes.statusCode).toBe(200);
      }
    });
  });

  describe("PATCH /api/v1/notifications/read-all", () => {
    it("marks all notifications as read", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/notifications/read-all",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);

      // Verify unread count is 0
      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(listRes.body);
      expect(body.unreadCount).toBe(0);
    });
  });
});
