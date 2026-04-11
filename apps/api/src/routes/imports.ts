import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Prisma } from "@clokr/db";
import { requireRole } from "../middleware/auth";
import { updateOvertimeAccount } from "./time-entries";

const employeeRowSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  employeeNumber: z.string().min(1),
  hireDate: z.string(),
  role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]).default("EMPLOYEE"),
  weeklyHours: z.coerce.number().positive().default(40),
  scheduleType: z.enum(["FIXED_WEEKLY", "MONTHLY_HOURS"]).default("FIXED_WEEKLY"),
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
    handler: async (req, _reply) => {
      const { csv } = z.object({ csv: z.string() }).parse(req.body);
      const rows = parseCsv(csv);

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
              raw.schedule_type || raw.scheduleType || raw.modell || raw.Modell || "FIXED_WEEKLY",
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

            await tx.overtimeAccount.create({
              data: { employeeId: emp.id, balanceHours: 0 },
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
          const startTime = new Date(`${dateStr}T${data.startTime}:00.000Z`);
          const endTime = new Date(`${dateStr}T${data.endTime}:00.000Z`);

          if (endTime <= startTime) throw new Error("Endzeit muss nach Startzeit liegen");

          await app.prisma.timeEntry.create({
            data: {
              employeeId,
              date: new Date(dateStr),
              startTime,
              endTime,
              breakMinutes: data.breakMinutes,
              note: data.note || null,
              type: "WORK",
              source: "MANUAL",
            },
          });

          affectedEmployeeIds.add(employeeId);
          results.push({ row: i + 1, status: "ok" });
        } catch (e: unknown) {
          results.push({
            row: i + 1,
            status: "error",
            error: e instanceof Error ? e.message.slice(0, 200) : "Unknown error",
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
