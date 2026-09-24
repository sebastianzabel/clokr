import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Prisma } from "@clokr/db";
import { fromZonedTime } from "date-fns-tz";
import { requireRole } from "../../../middleware/auth";
// eslint-disable-next-line no-restricted-imports -- E-2: the importer writes directly into time-tracking and working-time-account. Disappears in Block 2 (#102-#104). ADR 0001 Eintrag H.
import {
  updateOvertimeAccount,
  validateTimeEntryInvariants,
} from "../../time-tracking/api/time-entries";
// eslint-disable-next-line no-restricted-imports -- E-2: the importer writes directly into time-tracking and working-time-account. Disappears in Block 2 (#102-#104). ADR 0001 Eintrag H.
import { getTenantTimezone } from "../../working-time-account/timezone";
import { createOvertimeAccount } from "../../working-time-account"; // Phase 100B Plan 06 — W13
import { createImportedTimeEntry } from "../../time-tracking"; // Phase 100B Plan 08 — T12
// Phase 67b Plan 03 (issue #67, D-23) — the Stammsalon lifecycle helpers.
import { listSalons } from "../facade/salons";
import {
  createInitialHomeAssignment,
  resolveHomeSalonForNewEmployee,
} from "../facade/salon-assignments";
import { auditSalonAssignmentEvent } from "../salon-assignment-audit";
import { tenantLocalDay, toAssignmentDto } from "../salon-assignment-rules";

const employeeRowSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  employeeNumber: z.string().min(1),
  hireDate: z.string(),
  role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]).default("EMPLOYEE"),
  weeklyHours: z.coerce.number().positive().default(40),
  scheduleType: z.enum(["FIXED_SCHEDULE", "FLEXTIME", "MONTHLY_HOURS"]).default("FIXED_SCHEDULE"),
  monthlyHours: z.coerce.number().min(0).max(999).optional(),
  password: z.string().min(8).optional(),
});

const timeEntryRowSchema = z.object({
  employeeNumber: z.string().min(1),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  breakMinutes: z.coerce.number().min(0).default(0),
  note: z.string().optional(),
});

function parseDate(str: string): string {
  // Support DD.MM.YYYY and YYYY-MM-DD
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
    const [d, m, y] = str.split(".");
    return `${y}-${m}-${d}`;
  }
  return str;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Detect separator (semicolon or comma)
  const sep = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(sep).map((h) => h.trim().replace(/^["']|["']$/g, ""));

  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const values = line.split(sep).map((v) => v.trim().replace(/^["']|["']$/g, ""));
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = values[i] ?? "";
      });
      return row;
    });
}

export async function importRoutes(app: FastifyInstance) {
  // POST /employees — bulk import employees from CSV
  app.post("/employees", {
    schema: { tags: ["Import"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { csv } = z.object({ csv: z.string() }).parse(req.body);
      const rows = parseCsv(csv);

      // Phase 67b Plan 03 (D-23, issue #67): every imported employee needs a Stammsalon (HOME)
      // row, and this endpoint has no per-row salon column (deferred to #82) — so it only works
      // when the tenant has EXACTLY ONE active salon, checked up front, before ANY row is
      // written. Zero or several active salons rejects the WHOLE import; no IMPORT audit row.
      const activeSalons = await listSalons(app.prisma, req.user.tenantId, {
        includeInactive: false,
      });
      if (activeSalons.length === 0) {
        return reply.code(400).send({ error: "Der Mandant hat keinen aktiven Salon." });
      }
      if (activeSalons.length > 1) {
        return reply.code(400).send({
          error:
            "Bei mehreren aktiven Salons ist kein Import möglich. Bitte legen Sie die Mitarbeiter einzeln an und geben Sie den Stammsalon an.",
        });
      }
      const [theSalon] = activeSalons;
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);

      const results: { row: number; status: "ok" | "error"; email?: string; error?: string }[] = [];

      for (let i = 0; i < rows.length; i++) {
        try {
          const raw = rows[i];
          const data = employeeRowSchema.parse({
            ...raw,
            hireDate: parseDate(raw.hireDate || raw.eintrittsdatum || raw.Eintrittsdatum || ""),
            email: raw.email || raw.Email || raw["E-Mail"] || "",
            firstName: raw.firstName || raw.vorname || raw.Vorname || "",
            lastName: raw.lastName || raw.nachname || raw.Nachname || "",
            employeeNumber:
              raw.employeeNumber ||
              raw.nr ||
              raw.Nr ||
              raw["Mitarbeiter-Nr"] ||
              raw["Mitarbeiter-Nr."] ||
              "",
            role: raw.role || raw.Rolle || "EMPLOYEE",
            weeklyHours: raw.weeklyHours || raw.wochenstunden || raw.Wochenstunden || "40",
            scheduleType:
              raw.schedule_type || raw.scheduleType || raw.modell || raw.Modell || "FIXED_SCHEDULE",
            monthlyHours:
              raw.monthly_hours ||
              raw.monthlyHours ||
              raw.monatsstunden ||
              raw.Monatsstunden ||
              undefined,
            password: raw.password || raw.Passwort || undefined,
          });

          const hasPassword = !!data.password;
          const passwordHash = hasPassword
            ? await bcrypt.hash(data.password!, 12)
            : await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

          await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            // D-23/D-02: re-checks the salon under FOR SHARE — a race with a concurrent
            // deactivation between the up-front check and this row's own transaction throws,
            // which the per-row catch below reports as this row's error (rolled back).
            const salonOutcome = await resolveHomeSalonForNewEmployee(
              tx,
              req.user.tenantId,
              theSalon.id,
            );
            if (salonOutcome.status !== "OK") {
              throw new Error(
                salonOutcome.status === "SALON_INACTIVE"
                  ? "Einem deaktivierten Salon kann keine neue Zuordnung zugewiesen werden."
                  : "Salon nicht gefunden",
              );
            }

            const user = await tx.user.create({
              data: {
                email: data.email,
                passwordHash,
                role: data.role as Prisma.UserCreateInput["role"],
                isActive: hasPassword,
              },
            });

            const emp = await tx.employee.create({
              data: {
                tenantId: req.user.tenantId,
                userId: user.id,
                firstName: data.firstName,
                lastName: data.lastName,
                employeeNumber: data.employeeNumber,
                hireDate: new Date(data.hireDate),
              },
            });

            await tx.workSchedule.create({
              data: {
                employeeId: emp.id,
                type: data.scheduleType,
                weeklyHours: data.weeklyHours,
                monthlyHours: data.monthlyHours ?? null,
                validFrom: new Date(data.hireDate),
              },
            });

            await createOvertimeAccount(tx, emp.id, req.user.tenantId);

            // D-23: the imported employee's Stammsalon (HOME) row, open-ended from its
            // tenant-local hire day, in the SAME per-row transaction — audited CREATE.
            const homeAssignment = await createInitialHomeAssignment(
              tx,
              req.user.tenantId,
              emp.id,
              salonOutcome.salonId,
              tenantLocalDay(emp.hireDate, tz),
            );
            await auditSalonAssignmentEvent(app, req, {
              entity: "EmployeeSalonAssignment",
              action: "CREATE",
              entityId: homeAssignment.id,
              newValue: toAssignmentDto(homeAssignment),
              tx,
            });
          });

          results.push({ row: i + 1, status: "ok", email: data.email });
        } catch (e: unknown) {
          results.push({
            row: i + 1,
            status: "error",
            error: e instanceof Error ? e.message.slice(0, 200) : "Unknown error",
          });
        }
      }

      const okCount = results.filter((r) => r.status === "ok").length;
      const errorCount = results.filter((r) => r.status === "error").length;

      await app.audit({
        userId: req.user.sub,
        action: "IMPORT",
        entity: "Employee",
        newValue: { total: rows.length, ok: okCount, errors: errorCount },
      });

      return { total: rows.length, imported: okCount, errors: errorCount, details: results };
    },
  });

  // POST /time-entries — bulk import time entries from CSV
  app.post("/time-entries", {
    schema: { tags: ["Import"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, _reply) => {
      const { csv } = z.object({ csv: z.string() }).parse(req.body);
      const rows = parseCsv(csv);

      // Pre-load employee number → id mapping for this tenant
      const employees = await app.prisma.employee.findMany({
        where: { tenantId: req.user.tenantId },
        select: { id: true, employeeNumber: true },
      });
      const empMap = new Map(employees.map((e) => [e.employeeNumber, e.id]));

      // Wall-clock times in the CSV are in the tenant timezone, not UTC. Resolve once.
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);

      const results: { row: number; status: "ok" | "error"; error?: string }[] = [];
      const affectedEmployeeIds = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        try {
          const raw = rows[i];
          const data = timeEntryRowSchema.parse({
            employeeNumber:
              raw.employeeNumber ||
              raw.nr ||
              raw.Nr ||
              raw["Mitarbeiter-Nr"] ||
              raw["Mitarbeiter-Nr."] ||
              "",
            date: parseDate(raw.date || raw.datum || raw.Datum || ""),
            startTime: raw.startTime || raw.start || raw.Start || raw.von || raw.Von || "",
            endTime: raw.endTime || raw.end || raw.Ende || raw.bis || raw.Bis || "",
            breakMinutes: raw.breakMinutes || raw.pause || raw.Pause || "0",
            note: raw.note || raw.notiz || raw.Notiz || "",
          });

          const employeeId = empMap.get(data.employeeNumber);
          if (!employeeId)
            throw new Error(`Mitarbeiter-Nr. "${data.employeeNumber}" nicht gefunden`);

          const dateStr = data.date;
          // Parse wall-clock "HH:mm" as tenant-local time → correct UTC instant
          // (was `${dateStr}T${time}:00.000Z`, which wrongly treated it as UTC).
          const startTime = fromZonedTime(`${dateStr}T${data.startTime}:00`, tz);
          const endTime = fromZonedTime(`${dateStr}T${data.endTime}:00`, tz);

          if (endTime <= startTime) throw new Error("Endzeit muss nach Startzeit liegen");

          // Enforce the SAME invariants as POST /time-entries: month-lock (no writes
          // into a closed month), one-entry-per-day, and overlap. Per-row error on fail.
          // isCorrectionByManager: true — CSV import is a manager bulk-correction / tenant
          // onboarding of historical data and is exempt from the retro-window guard.
          // Parallels the NFC exemption: both represent legitimate back-fill of authoritative
          // data by an ADMIN, not a self-service edit by the employee. (RETRO-05)
          const invariantError = await validateTimeEntryInvariants(app, {
            employeeId,
            date: new Date(dateStr),
            dateStr,
            newStart: startTime,
            newEnd: endTime,
            tz,
            tenantId: req.user.tenantId,
            isCorrectionByManager: true,
          });
          if (invariantError) throw new Error(invariantError.error);

          // Phase 100B Plan 08 — T12, contexts/time-tracking facade.
          const created = await createImportedTimeEntry(app.prisma, {
            employeeId,
            date: new Date(dateStr),
            startTime,
            endTime,
            breakMinutes: data.breakMinutes,
            note: data.note || null,
          });

          // Per-entry audit (Revisionssicherheit) — one AuditLog row per imported entry,
          // not a single summary row.
          await app.audit({
            userId: req.user.sub,
            action: "CREATE",
            entity: "TimeEntry",
            entityId: created.id,
            newValue: created,
          });

          affectedEmployeeIds.add(employeeId);
          results.push({ row: i + 1, status: "ok" });
        } catch (e: unknown) {
          // DATA-V1814-04: a DB-level duplicate (partial-unique index) surfaces as P2002 —
          // report a clear per-row error and keep the import loop going (no abort).
          const isP2002 =
            typeof e === "object" &&
            e !== null &&
            "code" in e &&
            (e as { code: unknown }).code === "P2002";
          results.push({
            row: i + 1,
            status: "error",
            error: isP2002
              ? "Es existiert bereits ein Eintrag für diesen Tag."
              : e instanceof Error
                ? e.message.slice(0, 200)
                : "Unknown error",
          });
        }
      }

      // Update stored overtime balance for all employees whose entries were imported
      for (const empId of affectedEmployeeIds) {
        await updateOvertimeAccount(app, empId).catch((err) =>
          app.log.error({ err, employeeId: empId }, "Failed to update overtime after import"),
        );
      }

      const okCount = results.filter((r) => r.status === "ok").length;
      const errorCount = results.filter((r) => r.status === "error").length;

      await app.audit({
        userId: req.user.sub,
        action: "IMPORT",
        entity: "TimeEntry",
        newValue: { total: rows.length, ok: okCount, errors: errorCount },
      });

      return { total: rows.length, imported: okCount, errors: errorCount, details: results };
    },
  });
}
