import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { normalizeMac } from "../utils/normalize-mac";
import { getCurrentShift } from "../utils/get-current-shift";
import { getTenantTimezone, dateStrInTz } from "../utils/timezone";
import { resolveClockEvent } from "../services/clock/resolver";
import type { ClockEvent } from "../services/clock/types";

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

      // ── 8. Clock-in / clock-out via resolver (Phase 76.2 Plan 5) ──────────
      // The existing-WIFI-entry short-circuit (Block B in tests) and the
      // cross-source short-circuit (lines 186-214 above) stay at the adapter
      // for WIFI-specific semantics: same-source AUTO + OPEN_ENTRY through the
      // resolver returns STOP (clock-out), which is the wrong WIFI semantics
      // for a presence-confirm ping. See RESEARCH.md Pitfall 4.
      if (body.eventType === "connected") {
        // Check for existing WIFI entry — never create a second entry
        const existingWifiEntry = await app.prisma.timeEntry.findFirst({
          where: { employeeId: employee.id, date: today, deletedAt: null, source: "WIFI" },
        });

        if (existingWifiEntry) {
          // Already clocked in via WIFI — confirm presence, no duplicate.
          // Adapter emits WIFI_PRESENCE_CONFIRMED verbatim (Fritzbox-adapter
          // audit-log grep + Phase 70 activity feed depend on this string).
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

        // No existing entry seen by the adapter pre-check — route through
        // resolver to create one inside the pessimistic row lock.
        //
        // intent='IN' (NOT 'AUTO'): for WIFI the connected event is a "start
        // presence" signal — never a toggle. Using AUTO would cause same-source
        // OPEN_ENTRY to STOP (clock-out) inside the resolver under race, since
        // the adapter pre-check above could miss a row created by a concurrent
        // request whose write committed between our read and our resolver call.
        // With IN, the lost-race path produces a typed CONFLICT
        // (ALREADY_CLOCKED_IN) which the adapter maps to the existing
        // idempotent WIFI_PRESENCE_CONFIRMED contract (Pitfall 4 in RESEARCH.md).
        // Sub-req C step 4 (race generalization) holds: 5 concurrent connected
        // events → exactly 1 created WIFI row + 4× WIFI_PRESENCE_CONFIRMED.
        const event: ClockEvent = {
          employeeId: employee.id,
          tenantId,
          source: "WIFI",
          intent: "IN",
          timestamp: eventTime,
          date: today,
          dateStr,
          actor: { type: "SYSTEM" },
        };

        const resolution = await resolveClockEvent(app, event);

        if (resolution.kind === "CONFLICT") {
          if (resolution.reason === "ALREADY_CLOCKED_IN") {
            // Lost race: a concurrent connected request created the entry
            // between our pre-check and our resolver call. Emit
            // WIFI_PRESENCE_CONFIRMED on the existing entry (preserves the
            // pre-Plan-5 idempotent contract).
            const winnerEntry = await app.prisma.timeEntry.findFirst({
              where: {
                employeeId: employee.id,
                date: today,
                deletedAt: null,
                endTime: null,
                isInvalid: false,
              },
            });
            if (winnerEntry) {
              await app.prisma.auditLog.create({
                data: {
                  userId: null,
                  action: "WIFI_PRESENCE_CONFIRMED",
                  entity: "TimeEntry",
                  entityId: winnerEntry.id,
                  newValue: { mac, timestamp: body.timestamp },
                  purgeable: false,
                },
              });
            }
            return reply.code(200).send({ ok: true });
          }
          // Other CONFLICTs (LEAVE_APPROVED, MONTH_LOCKED, NOT_CLOCKED_IN —
          // shouldn't fire on IN) — log + still return 200 to preserve the
          // adapter's idempotent contract (Pitfall 4 — never 409 on /events).
          app.log.warn(
            { employeeId: employee.id, mac, reason: resolution.reason },
            "WIFI_CONNECTED_UNEXPECTED_CONFLICT",
          );
        }
        return reply.code(200).send({ ok: true });
      }

      // ── 9. eventType === "disconnected" via resolver ───────────────────────
      // The resolver's STOP branch closes the open entry + emits CLOCK_OUT audit.
      // Pre-Plan-5 inline transaction + WIFI_CLOCK_OUT audit GONE.
      const disconnectEvent: ClockEvent = {
        employeeId: employee.id,
        tenantId,
        source: "WIFI",
        intent: "OUT",
        timestamp: eventTime,
        date: today,
        dateStr,
        actor: { type: "SYSTEM" },
      };

      const disconnectResolution = await resolveClockEvent(app, disconnectEvent);

      if (disconnectResolution.kind === "CONFLICT") {
        if (disconnectResolution.reason === "NOT_CLOCKED_IN") {
          // No open entry to close — emit WIFI_NO_OPEN_ENTRY (purgeable, idempotent
          // contract preserved verbatim from pre-Plan-5 lines 285-296). Fritzbox
          // adapter sees the same {ok: true} + 200.
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
        if (disconnectResolution.reason === "MONTH_LOCKED") {
          // Locked month — silent 200 (preserves pre-Plan-5 line 301-306 behavior;
          // no user-facing error for the adapter poll loop).
          app.log.warn({ employeeId: employee.id, mac }, "WIFI_DISCONNECTED_BLOCKED_BY_MONTH_LOCK");
          return reply.code(200).send({ ok: true });
        }
        // Other CONFLICT reasons (LEAVE_APPROVED, ALREADY_CLOCKED_IN — shouldn't
        // fire on OUT intent): also return 200 to preserve idempotent contract.
        return reply.code(200).send({ ok: true });
      }

      // CLOCKED_OUT or CONSOLIDATED — resolver already emitted CLOCK_OUT audit.
      return reply.code(200).send({ ok: true });
    },
  });
}
