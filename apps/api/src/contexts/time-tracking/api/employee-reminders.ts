// Issue #609 (D-02) - the person's own switches for the shift reminders.
//
// The reminders are a Zeiterfassung feature, so the routes live here. The three opt-out columns
// sit on Employee (an Unterbau-Erweiterung) and the `/employees` prefix is a namespace, not an
// owner - the same reasoning as employee-wifi.ts (Phase 243 Plan 02). Only the caller's own row is
// ever read or written: the employee id comes from the token, never from the path or the body.
// The employee reads and the create/update audit values omit the columns (D-16), so the employee
// API does not disclose a colleague's opt-outs. The change made HERE is audited with the changed
// keys like every change of a person's data (traceability), so holders of `audit-log:read` can read
// it, and an operator under an active support access sees it redacted by type (WR-02, ADR AF).

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../../middleware/auth";

// Defaults of the tenant settings (the column defaults); used when a tenant has no config row yet.
const DEFAULT_OFFSET_MINUTES = 15;
const DEFAULT_DAY_CLOSE_TIME = "20:00";

// `.strict()`: an id or any other key is a 400, there is no way to address another person.
const remindersPatchSchema = z
  .object({
    shiftStartOff: z.boolean().optional(),
    shiftEndOff: z.boolean().optional(),
    dayCloseOff: z.boolean().optional(),
  })
  .strict();

const OWN_COLUMNS = {
  shiftStartOff: "reminderShiftStartOff",
  shiftEndOff: "reminderShiftEndOff",
  dayCloseOff: "reminderDayCloseOff",
} as const;

type OwnKey = keyof typeof OWN_COLUMNS;

export async function employeeReminderRoutes(app: FastifyInstance) {
  // The profile never reads the whole tenant config: five reminder fields and the caller's own row.
  async function readState(tenantId: string, employeeId: string) {
    const [cfg, own] = await Promise.all([
      app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: {
          reminderShiftStartEnabled: true,
          reminderShiftEndEnabled: true,
          reminderDayCloseEnabled: true,
          reminderOffsetMinutes: true,
          reminderDayCloseTime: true,
        },
      }),
      app.prisma.employee.findUnique({
        where: { id: employeeId, tenantId },
        select: {
          reminderShiftStartOff: true,
          reminderShiftEndOff: true,
          reminderDayCloseOff: true,
        },
      }),
    ]);
    if (!own) return null;
    return {
      tenant: {
        shiftStartEnabled: cfg?.reminderShiftStartEnabled ?? false,
        shiftEndEnabled: cfg?.reminderShiftEndEnabled ?? false,
        dayCloseEnabled: cfg?.reminderDayCloseEnabled ?? false,
        offsetMinutes: cfg?.reminderOffsetMinutes ?? DEFAULT_OFFSET_MINUTES,
        dayCloseTime: cfg?.reminderDayCloseTime ?? DEFAULT_DAY_CLOSE_TIME,
      },
      own: {
        shiftStartOff: own.reminderShiftStartOff,
        shiftEndOff: own.reminderShiftEndOff,
        dayCloseOff: own.reminderDayCloseOff,
      },
    };
  }

  // GET /api/v1/employees/me/reminders - which occasions the tenant enabled plus my opt-outs
  app.get("/me/reminders", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      // 400, never 401: the web client would start a token refresh loop on a 401.
      if (!employeeId) return reply.code(400).send({ error: "Kein Mitarbeiterprofil vorhanden" });
      const state = await readState(req.user.tenantId, employeeId);
      if (!state) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      return reply.send(state);
    },
  });

  // PATCH /api/v1/employees/me/reminders - switch an occasion off or on for myself
  app.patch("/me/reminders", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = remindersPatchSchema.parse(req.body ?? {});
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;
      if (!employeeId) return reply.code(400).send({ error: "Kein Mitarbeiterprofil vorhanden" });

      const requested = (Object.keys(OWN_COLUMNS) as OwnKey[]).filter((k) => body[k] !== undefined);
      if (requested.length === 0) {
        return reply.code(400).send({ error: "Keine Änderung angegeben" });
      }

      const current = await readState(tenantId, employeeId);
      if (!current) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Only the keys whose value really changes are written and audited.
      const data: Record<string, boolean> = {};
      const oldValue: Record<string, boolean> = {};
      const newValue: Record<string, boolean> = {};
      for (const k of requested) {
        const next = body[k] as boolean;
        if (current.own[k] === next) continue;
        const column = OWN_COLUMNS[k];
        data[column] = next;
        oldValue[column] = current.own[k];
        newValue[column] = next;
      }
      if (Object.keys(data).length === 0) return reply.send(current);

      await app.prisma.employee.update({ where: { id: employeeId, tenantId }, data });
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: employeeId,
        oldValue,
        newValue,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      const fresh = await readState(tenantId, employeeId);
      return reply.send(fresh ?? current);
    },
  });
}
