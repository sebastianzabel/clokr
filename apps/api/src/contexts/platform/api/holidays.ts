import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { FederalState, Salon } from "@clokr/db";
import { requireAuth, requireRole } from "../../../middleware/auth";
import { findDefaultSalon, findSalon, isMultiSalonTenant } from "../facade/salons";
import { holidaysForSalon } from "../facade/holiday-resolution";
// eslint-disable-next-line no-restricted-imports -- E-1: creating a holiday loops over every employee and calls the saldo recalculation directly. Disappears in Block 2 (#102-#104), where a holiday-created event replaces the direct call. ADR 0001 Eintrag H.
import { recalculateSnapshots } from "../../working-time-account/recalculate-snapshots";

const SALON_NOT_FOUND_BODY = { error: "Salon nicht gefunden" } as const;

const holidaysQuerySchema = z.object({
  year: z.string().regex(/^\d+$/).optional(),
  salonId: z.string().uuid().optional(),
});

const createHolidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().min(1).max(100),
  salonId: z.string().uuid().optional(),
});

interface HolidayResponseEntry {
  id: string;
  tenantId: string;
  salonId: string;
  date: string;
  name: string;
  federalState: FederalState;
  year: number;
  isManual: boolean;
}

type HolidaySalonResolution =
  | { ok: true; salon: Salon }
  | { ok: false; status: 400 | 404 | 409; body: { error: string; code?: string } };

/**
 * Phase 71b (issue #71), D-09/D-10: resolve which salon a GET/POST `/api/v1/holidays` call is for.
 * An EXPLICIT `salonId` goes through `findSalon` — a foreign tenant's real salon and an id that
 * exists nowhere are the SAME null result, so both answer the identical 404 below (T-100-09 by
 * construction: one code path, not two that happen to agree). No `salonId`: with more than one
 * active salon the caller must say which one (400 `SALON_REQUIRED`); with exactly one, that salon
 * is the default; with zero active salons, 409 `NO_ACTIVE_SALON` (Phase 64b D-18 says this is
 * unreachable in production, but the route still answers instead of throwing).
 */
async function resolveHolidaySalon(
  app: FastifyInstance,
  tenantId: string,
  salonId: string | undefined,
): Promise<HolidaySalonResolution> {
  if (salonId) {
    const salon = await findSalon(app.prisma, tenantId, salonId);
    if (!salon) return { ok: false, status: 404, body: SALON_NOT_FOUND_BODY };
    return { ok: true, salon };
  }

  if (await isMultiSalonTenant(app.prisma, tenantId)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Bitte einen Salon angeben — der Mandant hat mehrere aktive Salons.",
        code: "SALON_REQUIRED",
      },
    };
  }

  const defaultSalon = await findDefaultSalon(app.prisma, tenantId);
  if (!defaultSalon) {
    return {
      ok: false,
      status: 409,
      body: { error: "Kein aktiver Salon vorhanden.", code: "NO_ACTIVE_SALON" },
    };
  }
  return { ok: true, salon: defaultSalon };
}

function sendUnresolved(
  reply: FastifyReply,
  resolution: Extract<HolidaySalonResolution, { ok: false }>,
) {
  return reply.code(resolution.status).send(resolution.body);
}

export async function holidayRoutes(app: FastifyInstance) {
  // GET /api/v1/holidays?year=2026&salonId=...
  // Berechnet Feiertage on-the-fly für das Bundesland des Salons (§ 2 EFZG — Arbeitsort
  // entscheidet, nicht das Bundesland des Mandanten), mergt zusätzlich manuell hinzugefügte
  // Einträge des Salons und die mandantenweiten Heiligabend-/Silvester-Regeln.
  app.get("/", {
    schema: { tags: ["Feiertage"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { year, salonId } = holidaysQuerySchema.parse(req.query);
      const y = year ? parseInt(year, 10) : new Date().getFullYear();
      const tenantId = req.user.tenantId;

      const resolution = await resolveHolidaySalon(app, tenantId, salonId);
      if (!resolution.ok) return sendUnresolved(reply, resolution);
      const { salon } = resolution;

      const salonHolidays = await holidaysForSalon(
        app.prisma,
        tenantId,
        salon.id,
        `${y}-01-01`,
        `${y}-12-31`,
      );

      const computed: HolidayResponseEntry[] = [];
      const manual: HolidayResponseEntry[] = [];
      for (const h of salonHolidays) {
        const entry: HolidayResponseEntry = {
          id: h.manualHolidayId ?? `computed-${h.date}`,
          tenantId,
          salonId: salon.id,
          date: h.date,
          name: h.name,
          federalState: salon.federalState,
          year: y,
          isManual: h.manualHolidayId !== null,
        };
        (entry.isManual ? manual : computed).push(entry);
      }

      // Heiligabend/Silvester company rules — mandantenweit, unverändert durch diese Migration.
      const config = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      const companyHolidays: HolidayResponseEntry[] = [];
      const validFromYear = config?.holidayRulesValidFromYear ?? new Date().getFullYear();
      const christmasRule = y >= validFromYear ? (config?.christmasEveRule ?? "NORMAL") : "NORMAL";
      const newYearsRule = y >= validFromYear ? (config?.newYearsEveRule ?? "NORMAL") : "NORMAL";
      if (christmasRule !== "NORMAL") {
        companyHolidays.push({
          id: `company-${y}-12-24`,
          tenantId,
          salonId: salon.id,
          date: `${y}-12-24`,
          name:
            christmasRule === "FULL_DAY_OFF" ? "Heiligabend (frei)" : "Heiligabend (halber Tag)",
          federalState: salon.federalState,
          year: y,
          isManual: false,
        });
      }
      if (newYearsRule !== "NORMAL") {
        companyHolidays.push({
          id: `company-${y}-12-31`,
          tenantId,
          salonId: salon.id,
          date: `${y}-12-31`,
          name: newYearsRule === "FULL_DAY_OFF" ? "Silvester (frei)" : "Silvester (halber Tag)",
          federalState: salon.federalState,
          year: y,
          isManual: false,
        });
      }

      // Merge precedence: manuell > Firmenregel > berechnet — same rule as before this rewrite,
      // now applied over the salon-resolved sets instead of the tenant-wide ones.
      const manualDates = new Set(manual.map((m) => m.date));
      const companyDates = new Set(companyHolidays.map((c) => c.date));
      const merged = [
        ...computed.filter((c) => !manualDates.has(c.date) && !companyDates.has(c.date)),
        ...companyHolidays.filter((c) => !manualDates.has(c.date)),
        ...manual,
      ].sort((a, b) => a.date.localeCompare(b.date));

      return merged;
    },
  });

  // POST /api/v1/holidays  – manuellen Feiertag für einen Salon hinzufügen
  app.post("/", {
    schema: { tags: ["Feiertage"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const body = createHolidaySchema.parse(req.body);
      const tenantId = req.user.tenantId;

      const resolution = await resolveHolidaySalon(app, tenantId, body.salonId);
      if (!resolution.ok) return sendUnresolved(reply, resolution);
      const { salon } = resolution;

      const holiday = await app.prisma.publicHoliday.create({
        data: {
          tenantId,
          salonId: salon.id,
          date: new Date(body.date),
          name: body.name,
          year: parseInt(body.date.slice(0, 4), 10),
          federalState: salon.federalState,
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "PublicHoliday",
        entityId: holiday.id,
        newValue: {
          date: holiday.date,
          name: holiday.name,
          tenantId: holiday.tenantId,
          salonId: holiday.salonId,
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Retroactive recalculation: every tenant employee, not just those whose work location on
      // this day is this salon. Research A5: recalculateSnapshots is idempotent and already skips
      // locked months, so recomputing an unaffected employee costs nothing but re-deriving the
      // holiday resolver here (to narrow the loop) risks silently missing one — correctness over
      // the saved work.
      const holidayDate = new Date(body.date);
      const employees = await app.prisma.employee.findMany({
        where: { tenantId },
        select: { id: true },
      });
      for (const emp of employees) {
        await recalculateSnapshots(app, emp.id, holidayDate).catch((err) =>
          app.log.error(
            { err, employeeId: emp.id },
            "Failed to recalculate snapshots after holiday creation",
          ),
        );
      }

      return reply.code(201).send({
        ...holiday,
        date: holiday.date.toISOString().split("T")[0],
        isManual: true,
      });
    },
  });

  // DELETE /api/v1/holidays/:id  – nur manuelle Einträge löschbar (unverändert durch D-10)
  app.delete("/:id", {
    schema: { tags: ["Feiertage"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await app.prisma.publicHoliday.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      // IN-02: return 404 when not found so the caller is not misled into thinking
      // a deletion occurred and to avoid writing a no-op audit entry with null oldValue.
      if (!existing) return reply.code(404).send({ error: "Feiertag nicht gefunden" });
      await app.prisma.publicHoliday.deleteMany({
        where: { id, tenantId: req.user.tenantId },
      });
      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "PublicHoliday",
        entityId: id,
        oldValue: existing,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Retroactive recalculation: find affected employees and recalculate
      if (existing) {
        const employees = await app.prisma.employee.findMany({
          where: { tenantId: req.user.tenantId },
          select: { id: true },
        });
        for (const emp of employees) {
          await recalculateSnapshots(app, emp.id, existing.date).catch((err) =>
            app.log.error(
              { err, employeeId: emp.id },
              "Failed to recalculate snapshots after holiday deletion",
            ),
          );
        }
      }

      return reply.code(204).send();
    },
  });
}
