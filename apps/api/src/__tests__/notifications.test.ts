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

  describe("DELETE /api/v1/notifications/:id", () => {
    let notificationId: string;

    beforeAll(async () => {
      // Create a notification via leave request
      await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-10-06",
          endDate: "2026-10-09",
        },
      });
      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(listRes.body);
      const leaveNotif = body.notifications.find((n: { type: string }) => n.type === "LEAVE_REQUEST");
      notificationId = leaveNotif?.id;
    });

    it("dismisses own notification and removes it from GET response", async () => {
      expect(notificationId).toBeDefined();

      const dismissRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/notifications/${notificationId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(dismissRes.statusCode).toBe(200);
      const body = JSON.parse(dismissRes.body);
      expect(body.success).toBe(true);

      // Should no longer appear in GET
      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const listBody = JSON.parse(listRes.body);
      const stillThere = listBody.notifications.find((n: { id: string }) => n.id === notificationId);
      expect(stillThere).toBeUndefined();
    });

    it("returns 404 when dismissing another user's notification", async () => {
      // employee tries to dismiss admin's notification (already dismissed, but still tests cross-user)
      // Create a fresh one to test cross-user properly
      await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-10-13",
          endDate: "2026-10-15",
        },
      });
      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const listBody = JSON.parse(listRes.body);
      const adminNotif = listBody.notifications.find((n: { type: string }) => n.type === "LEAVE_REQUEST");
      expect(adminNotif).toBeDefined();

      // Try to dismiss admin's notification as employee (cross-user)
      const dismissRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/notifications/${adminNotif.id}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(dismissRes.statusCode).toBe(404);
    });

    it("returns 404 for a non-existent id", async () => {
      const dismissRes = await app.inject({
        method: "DELETE",
        url: "/api/v1/notifications/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(dismissRes.statusCode).toBe(404);
    });

    it("returns 404 when dismissing an already-dismissed notification", async () => {
      expect(notificationId).toBeDefined();

      // Already dismissed in first test
      const dismissRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/notifications/${notificationId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(dismissRes.statusCode).toBe(404);
    });
  });

  describe("Auto-dismiss on leave review", () => {
    it("approving a leave request auto-dismisses the manager LEAVE_REQUEST notification", async () => {
      // Create leave request as employee
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-11-03",
          endDate: "2026-11-05",
        },
      });
      expect(createRes.statusCode).toBe(201);
      const { id: requestId } = JSON.parse(createRes.body);

      // Verify admin has a LEAVE_REQUEST notification for this request
      const beforeListRes = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const beforeBody = JSON.parse(beforeListRes.body);
      const beforeNotif = beforeBody.notifications.find(
        (n: { type: string; link: string }) =>
          n.type === "LEAVE_REQUEST" && n.link?.includes(requestId),
      );
      expect(beforeNotif).toBeDefined();

      // Admin approves the request
      const reviewRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/review`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { status: "APPROVED" },
      });
      expect(reviewRes.statusCode).toBe(200);

      // LEAVE_REQUEST notification for this request should be gone from admin's list
      const afterListRes = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const afterBody = JSON.parse(afterListRes.body);
      const afterNotif = afterBody.notifications.find(
        (n: { type: string; link: string }) =>
          n.type === "LEAVE_REQUEST" && n.link?.includes(requestId),
      );
      expect(afterNotif).toBeUndefined();
    });
  });
});
