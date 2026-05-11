import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { normalizeMac } from "../utils/normalize-mac";
import { getCurrentShift } from "../utils/get-current-shift";
import { getTenantTimezone, dateStrInTz } from "../utils/timezone";

// ── Zod schema ────────────────────────────────────────────
const presenceEventSchema = z.object({
  mac: z.string().min(1),
  eventType: z.enum(["connected", "disconnected"]),
  timestamp: z.string().datetime(), // ISO-8601
  adapter: z.string().default("fritzbox"),
});

export async function presenceRoutes(app: FastifyInstance) {
  // POST /events — receive normalized presence event from an adapter (FritzBox etc.)
  const isTest = process.env.NODE_ENV === "test";
  app.post("/events", {
    schema: { tags: ["WiFi-Presence"] },
    config: { rateLimit: { max: isTest ? 5000 : 300, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      // ── 1. Auth: extract Bearer key → SHA256 → PresenceSource lookup ──────
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "Presence-Key erforderlich" });
      }
      const rawKey = authHeader.slice(7);
      const keyHash = createHash("sha256").update(rawKey).digest("hex");

      const source = await app.prisma.presenceSource.findUnique({
        where: { keyHash },
      });
      if (!source || source.revokedAt || !source.isActive) {
        return reply.code(401).send({ error: "Ungültiger oder widerrufener Presence-Key" });
      }

      const tenantId = source.tenantId;

      // Fire-and-forget: update lastUsedAt on PresenceSource (adapter health signal)
      app.prisma.presenceSource
        .update({ where: { id: source.id }, data: { lastUsedAt: new Date() } })
        .catch((err) => app.log.error({ err }, "Failed to update PresenceSource.lastUsedAt"));

      // ── 2. Parse + normalize body ─────────────────────────────────────────
      const body = presenceEventSchema.parse(req.body);
      const mac = normalizeMac(body.mac);
      const eventTime = new Date(body.timestamp);

      // ── 3. MAC → Employee lookup (opt-in + tenant-scoped) ─────────────────
      // Per design (25-CONTEXT.md): check PresenceDevice (admin- or MA-enrolled) first,
      // then fall back to Employee.wifiMacs[] for legacy/direct entries.
      // Employee has no deletedAt — DSGVO "deletion" is anonymization via user.isActive=false
      const device = await app.prisma.presenceDevice.findUnique({
        where: { tenantId_mac: { tenantId, mac } },
        include: {
          employee: {
            include: { user: { select: { isActive: true } } },
          },
        },
      });

      // WR-01: explicit cross-tenant guard — reject if device's employee belongs
      // to a different tenant (guards against data-migration anomalies)
      if (device && device.employee.tenantId !== tenantId) {
        app.log.error(
          {
            deviceId: device.id,
            deviceTenantId: device.employee.tenantId,
            sourceTenantId: tenantId,
          },
          "PresenceDevice tenant mismatch — skipping event",
        );
        return reply.code(200).send({ ok: true });
      }

      let employee = device && device.employee.user?.isActive ? device.employee : null;

      if (!employee) {
        // Fallback: legacy wifiMacs[] array on Employee
        employee = await app.prisma.employee.findFirst({
          where: {
            tenantId,
            wifiMacs: { has: mac },
            user: { isActive: true },
          },
          include: { user: { select: { isActive: true } } },
        });
      }

      if (!employee) {
        // Unknown MAC — purgeable presence-only event (DSGVO Art. 5(1)(e): auto-purge after 90 days)
        await app.prisma.auditLog.create({
          data: {
            userId: null,
            action: "WIFI_UNKNOWN_MAC",
            entity: "PresenceEvent",
            entityId: null,
            newValue: { mac, eventType: body.eventType, adapter: body.adapter },
            purgeable: true,
          },
        });
        return reply.code(200).send({ ok: true });
      }

      if (!employee.wifiPresenceEnabled) {
        // Opt-out — purgeable (GDPR: MAC observed but employee not opted in)
        await app.prisma.auditLog.create({
          data: {
            userId: null,
            action: "WIFI_OPT_OUT",
            entity: "PresenceEvent",
            entityId: employee.id,
            newValue: { mac, eventType: body.eventType },
            purgeable: true,
          },
        });
        return reply.code(200).send({ ok: true });
      }

      // ── 4. Tenant config: shift window ────────────────────────────────────
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const tenantCfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { wifiPresenceWindowMinutes: true },
      });
      const windowMinutes = tenantCfg?.wifiPresenceWindowMinutes ?? 15;

      // ── 5. Shift-window gate ──────────────────────────────────────────────
      const shiftWindow = await getCurrentShift(app.prisma, employee.id, eventTime, tz);

      if (!shiftWindow) {
        // No shift scheduled for this date — ignore the event
        await app.prisma.auditLog.create({
          data: {
            userId: null,
            action: "WIFI_NO_SHIFT",
            entity: "PresenceEvent",
            entityId: employee.id,
            newValue: { mac, eventType: body.eventType, timestamp: body.timestamp },
            purgeable: true,
          },
        });
        return reply.code(200).send({ ok: true });
      }

      // Check if event is within ±wifiPresenceWindowMinutes of shiftStart OR shiftEnd
      const windowMs = windowMinutes * 60_000;
      const { startUtc, endUtc } = shiftWindow;

      const nearShiftStart =
        eventTime >= new Date(startUtc.getTime() - windowMs) &&
        eventTime <= new Date(startUtc.getTime() + windowMs);

      const nearShiftEnd =
        eventTime >= new Date(endUtc.getTime() - windowMs) &&
        eventTime <= new Date(endUtc.getTime() + windowMs);

      if (!nearShiftStart && !nearShiftEnd) {
        await app.prisma.auditLog.create({
          data: {
            userId: null,
            action: "WIFI_OUTSIDE_WINDOW",
            entity: "PresenceEvent",
            entityId: employee.id,
            newValue: {
              mac,
              eventType: body.eventType,
              timestamp: body.timestamp,
              shiftStart: shiftWindow.shift.startTime,
              shiftEnd: shiftWindow.shift.endTime,
              windowMinutes,
            },
            purgeable: true,
          },
        });
        return reply.code(200).send({ ok: true });
      }

      // ── 6. Resolve date key for TimeEntry ────────────────────────────────
      // Compute "today" from the event timestamp in tenant timezone to handle
      // near-midnight events correctly rather than using wall-clock now()
      const dateStr = dateStrInTz(eventTime, tz);
      const today = new Date(dateStr + "T00:00:00Z");

      // ── 7. Cross-source dedup check ───────────────────────────────────────
      // If a non-WIFI entry already exists for this date, confirm presence only (no second entry)
      const existingNonWifiEntry = await app.prisma.timeEntry.findFirst({
        where: {
          employeeId: employee.id,
          date: today,
          deletedAt: null,
          source: { in: ["NFC", "MANUAL", "CORRECTION"] },
        },
      });

      if (existingNonWifiEntry) {
        await app.prisma.auditLog.create({
          data: {
            userId: null,
            action: "WIFI_PRESENCE_CONFIRMED",
            entity: "TimeEntry",
            entityId: existingNonWifiEntry.id,
            newValue: {
              mac,
              eventType: body.eventType,
              timestamp: body.timestamp,
              note: `MAC ${mac} beobachtet um ${eventTime.toISOString()}`,
            },
            purgeable: false,
          },
        });
        return reply.code(200).send({ ok: true });
      }

      // ── 8. Clock-in / clock-out transaction ───────────────────────────────
      if (body.eventType === "connected") {
        // Check for existing WIFI entry — never create a second entry
        const existingWifiEntry = await app.prisma.timeEntry.findFirst({
          where: { employeeId: employee.id, date: today, deletedAt: null, source: "WIFI" },
        });

        if (existingWifiEntry) {
          // Already clocked in via WIFI — confirm presence, no duplicate
          await app.prisma.auditLog.create({
            data: {
              userId: null,
              action: "WIFI_PRESENCE_CONFIRMED",
              entity: "TimeEntry",
              entityId: existingWifiEntry.id,
              newValue: { mac, timestamp: body.timestamp },
              purgeable: false,
            },
          });
          return reply.code(200).send({ ok: true });
        }

        // Create new WIFI clock-in inside a transaction (race-condition guard per T-25-03-07)
        const newEntry = await app.prisma.$transaction(async (tx) => {
          // Re-check inside transaction to guard against concurrent requests
          const concurrent = await tx.timeEntry.findFirst({
            where: { employeeId: employee.id, date: today, deletedAt: null },
          });
          if (concurrent) return null; // lost race — let the other request win

          return tx.timeEntry.create({
            data: {
              employeeId: employee.id,
              date: today,
              startTime: eventTime,
              source: "WIFI",
            },
          });
        });

        if (newEntry) {
          await app.prisma.auditLog.create({
            data: {
              userId: null,
              action: "WIFI_CLOCK_IN",
              entity: "TimeEntry",
              entityId: newEntry.id,
              newValue: { mac, startTime: eventTime.toISOString(), source: "WIFI" },
              purgeable: false,
            },
          });
        }

        return reply.code(200).send({ ok: true });
      }

      // ── 9. eventType === "disconnected" ───────────────────────────────────
      const openWifiEntry = await app.prisma.timeEntry.findFirst({
        where: {
          employeeId: employee.id,
          date: today,
          deletedAt: null,
          source: "WIFI",
          endTime: null,
          isInvalid: false,
        },
      });

      if (!openWifiEntry) {
        // No open WIFI entry to close — idempotent, log purgeable event
        await app.prisma.auditLog.create({
          data: {
            userId: null,
            action: "WIFI_NO_OPEN_ENTRY",
            entity: "PresenceEvent",
            entityId: employee.id,
            newValue: { mac, timestamp: body.timestamp },
            purgeable: true,
          },
        });
        return reply.code(200).send({ ok: true });
      }

      // CLAUDE.md audit-proof rule: locked months must not be modified.
      // TimeEntry.isLocked is the field to check (no ClosedMonth model exists in schema).
      if (openWifiEntry.isLocked) {
        app.log.warn(
          { entryId: openWifiEntry.id },
          "WIFI clock-out blocked: TimeEntry is locked (month is closed)",
        );
        return reply.code(200).send({ ok: true }); // silent — no user-facing error for adapter
      }

      await app.prisma.$transaction(async (tx) => {
        await tx.timeEntry.update({
          where: { id: openWifiEntry.id },
          data: { endTime: eventTime },
        });
      });

      // Write audit log outside transaction (not purgeable — 10-year retention per §147 AO / T-25-03-03)
      await app.prisma.auditLog.create({
        data: {
          userId: null,
          action: "WIFI_CLOCK_OUT",
          entity: "TimeEntry",
          entityId: openWifiEntry.id,
          oldValue: { endTime: null },
          newValue: { mac, endTime: eventTime.toISOString() },
          purgeable: false,
        },
      });

      return reply.code(200).send({ ok: true });
    },
  });
}
