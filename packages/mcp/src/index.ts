#!/usr/bin/env node
/**
 * Clokr MCP Server — Development Tools
 *
 * Provides tools for interacting with the Clokr API directly from Claude Code.
 * Useful for querying employees, shifts, time entries, reports, etc.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.CLOKR_API_URL ?? "http://localhost:4000/api/v1";
let authToken: string | null = null;

// ── API helper ──────────────────────────────────────────────────────────────

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const url = new URL(path, API_BASE.endsWith("/") ? API_BASE : API_BASE + "/");
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ── Server setup ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "clokr",
  version: "0.1.0",
});

// ── Auth ────────────────────────────────────────────────────────────────────

server.tool(
  "login",
  "Login to Clokr API and get an auth token",
  {
    email: z.string().describe("User email"),
    password: z.string().describe("User password"),
  },
  async ({ email, password }) => {
    const { status, data } = await apiCall("POST", "auth/login", { email, password });
    if (status === 200 && (data as any).accessToken) {
      authToken = (data as any).accessToken;
      const user = (data as any).user;
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Logged in as ${user.email} (${user.role}). Token stored for subsequent requests.`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: `❌ Login failed (${status}): ${JSON.stringify(data)}` }],
    };
  },
);

// ── Employees ───────────────────────────────────────────────────────────────

server.tool(
  "list_employees",
  "List all employees in the tenant",
  {},
  async () => {
    const { status, data } = await apiCall("GET", "employees");
    if (status !== 200) {
      return { content: [{ type: "text" as const, text: `Error ${status}: ${JSON.stringify(data)}` }] };
    }
    const emps = data as any[];
    const summary = emps.map(
      (e) => `• ${e.employeeNumber} — ${e.lastName}, ${e.firstName} (${e.user?.email}) [${e.user?.role}] ${e.user?.isActive ? "✅" : "❌"}`,
    );
    return {
      content: [{ type: "text" as const, text: `${emps.length} Mitarbeiter:\n${summary.join("\n")}` }],
    };
  },
);

// ── Dashboard ───────────────────────────────────────────────────────────────

server.tool(
  "dashboard",
  "Get the current user's dashboard stats (today, week, overtime, vacation)",
  {},
  async () => {
    const { status, data } = await apiCall("GET", "dashboard");
    if (status !== 200) {
      return { content: [{ type: "text" as const, text: `Error ${status}: ${JSON.stringify(data)}` }] };
    }
    const d = data as any;
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `📊 Dashboard`,
            `Heute: ${d.today?.workedHours?.toFixed(1) ?? "?"}h (${d.today?.entries ?? 0} Einträge)`,
            `Woche: ${d.week?.workedHours?.toFixed(1) ?? "?"}h / ${d.week?.targetHours?.toFixed(1) ?? "?"}h Soll`,
            `Überstunden: ${d.overtime?.balanceHours >= 0 ? "+" : ""}${d.overtime?.balanceHours?.toFixed(1) ?? "?"}h`,
            `Resturlaub: ${d.vacation?.remaining ?? "?"} / ${d.vacation?.total ?? "?"} Tage`,
          ].join("\n"),
        },
      ],
    };
  },
);

// ── Time Entries ────────────────────────────────────────────────────────────

server.tool(
  "list_time_entries",
  "List time entries for a date range",
  {
    from: z.string().describe("Start date YYYY-MM-DD"),
    to: z.string().describe("End date YYYY-MM-DD"),
  },
  async ({ from, to }) => {
    const { status, data } = await apiCall("GET", "time-entries", undefined, { from, to });
    if (status !== 200) {
      return { content: [{ type: "text" as const, text: `Error ${status}: ${JSON.stringify(data)}` }] };
    }
    const entries = data as any[];
    if (entries.length === 0) {
      return { content: [{ type: "text" as const, text: "Keine Zeiteinträge im Zeitraum." }] };
    }
    const lines = entries.map((e) => {
      const start = new Date(e.startTime).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      const end = e.endTime ? new Date(e.endTime).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "offen";
      return `• ${e.date?.split("T")[0]} ${start}–${end} (${e.breakMinutes}min Pause) ${e.note ?? ""}`;
    });
    return {
      content: [{ type: "text" as const, text: `${entries.length} Einträge:\n${lines.join("\n")}` }],
    };
  },
);

server.tool(
  "clock_in",
  "Clock in (start time tracking)",
  {},
  async () => {
    const { status, data } = await apiCall("POST", "time-entries/clock-in", { source: "MANUAL" });
    if (status === 201 || status === 200) {
      return { content: [{ type: "text" as const, text: `✅ Eingestempelt! Entry ID: ${(data as any).entry?.id}` }] };
    }
    return { content: [{ type: "text" as const, text: `❌ ${status}: ${JSON.stringify(data)}` }] };
  },
);

server.tool(
  "clock_out",
  "Clock out (stop time tracking)",
  {
    entryId: z.string().describe("Time entry ID to clock out"),
    breakMinutes: z.number().default(0).describe("Break minutes"),
  },
  async ({ entryId, breakMinutes }) => {
    const { status, data } = await apiCall("POST", `time-entries/${entryId}/clock-out`, { breakMinutes });
    if (status === 200) {
      return { content: [{ type: "text" as const, text: `✅ Ausgestempelt! ${JSON.stringify((data as any).warnings ?? [])}` }] };
    }
    return { content: [{ type: "text" as const, text: `❌ ${status}: ${JSON.stringify(data)}` }] };
  },
);

// ── Shifts ───────────────────────────────────────────────────────────────────

server.tool(
  "list_shifts",
  "List shifts for a week (provide any date in the week)",
  {
    date: z.string().default("").describe("Any date in the week (YYYY-MM-DD), defaults to current week"),
  },
  async ({ date }) => {
    const query: Record<string, string> = {};
    if (date) query.date = date;
    const { status, data } = await apiCall("GET", "shifts/week", undefined, query);
    if (status !== 200) {
      return { content: [{ type: "text" as const, text: `Error ${status}: ${JSON.stringify(data)}` }] };
    }
    const d = data as any;
    const lines: string[] = [`Woche: ${d.weekDays?.[0]} – ${d.weekDays?.[6]}`];
    for (const emp of d.employees ?? []) {
      const empShifts = (d.shifts ?? []).filter((s: any) => s.employeeId === emp.id);
      if (empShifts.length === 0) {
        lines.push(`  ${emp.lastName}, ${emp.firstName}: keine Schichten`);
      } else {
        const shifts = empShifts
          .map((s: any) => `${s.date?.split("T")[0]} ${s.startTime}–${s.endTime} (${s.label ?? ""})`)
          .join(", ");
        lines.push(`  ${emp.lastName}, ${emp.firstName}: ${shifts}`);
      }
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// ── Leave / Absences ────────────────────────────────────────────────────────

server.tool(
  "list_leave_requests",
  "List leave/absence requests",
  {},
  async () => {
    const { status, data } = await apiCall("GET", "leave/requests");
    if (status !== 200) {
      return { content: [{ type: "text" as const, text: `Error ${status}: ${JSON.stringify(data)}` }] };
    }
    const reqs = data as any[];
    if (reqs.length === 0) {
      return { content: [{ type: "text" as const, text: "Keine Anträge vorhanden." }] };
    }
    const lines = reqs.map(
      (r) => `• ${r.startDate?.split("T")[0]}–${r.endDate?.split("T")[0]} ${r.typeCode} [${r.status}] ${r.days} Tage`,
    );
    return { content: [{ type: "text" as const, text: `${reqs.length} Anträge:\n${lines.join("\n")}` }] };
  },
);

// ── Reports ─────────────────────────────────────────────────────────────────

server.tool(
  "monthly_report",
  "Get monthly report for a specific month",
  {
    month: z.string().describe("Month in YYYY-MM format"),
  },
  async ({ month }) => {
    const [year, m] = month.split("-");
    const { status, data } = await apiCall("GET", "reports/monthly", undefined, { year, month: m });
    if (status !== 200) {
      return { content: [{ type: "text" as const, text: `Error ${status}: ${JSON.stringify(data)}` }] };
    }
    const d = data as any;
    const lines = (d.rows ?? []).map(
      (r: any) =>
        `• ${r.employeeName} (${r.employeeNumber}): ${r.workedHours}h / ${r.shouldHours}h Soll | Krank: ${r.sickDays}d | Urlaub: ${r.vacationDays}d`,
    );
    return {
      content: [{ type: "text" as const, text: `Monatsbericht ${month}:\n${lines.join("\n")}` }],
    };
  },
);

// ── Overtime ────────────────────────────────────────────────────────────────

server.tool(
  "overtime_account",
  "Get overtime account for an employee",
  {
    employeeId: z.string().describe("Employee ID"),
  },
  async ({ employeeId }) => {
    const { status, data } = await apiCall("GET", `overtime/${employeeId}`);
    if (status !== 200) {
      return { content: [{ type: "text" as const, text: `Error ${status}: ${JSON.stringify(data)}` }] };
    }
    const d = data as any;
    const txLines = (d.transactions ?? [])
      .slice(0, 10)
      .map(
        (t: any) => `  ${t.createdAt?.split("T")[0]} ${t.type} ${t.hours >= 0 ? "+" : ""}${t.hours}h ${t.description ?? ""}`,
      );
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Überstundenkonto: ${d.balanceHours}h (${d.status})`,
            `Letzte Transaktionen:`,
            ...txLines,
          ].join("\n"),
        },
      ],
    };
  },
);

// ── Notifications ───────────────────────────────────────────────────────────

server.tool(
  "notifications",
  "Get current notifications",
  {},
  async () => {
    const { status, data } = await apiCall("GET", "notifications");
    if (status !== 200) {
      return { content: [{ type: "text" as const, text: `Error ${status}: ${JSON.stringify(data)}` }] };
    }
    const d = data as any;
    const lines = (d.notifications ?? []).map(
      (n: any) => `${n.read ? "📖" : "🔔"} ${n.title}: ${n.message} (${n.createdAt?.split("T")[0]})`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `${d.unreadCount} ungelesen\n${lines.join("\n") || "Keine Benachrichtigungen."}`,
        },
      ],
    };
  },
);

// ── Generic API call ────────────────────────────────────────────────────────

server.tool(
  "api_request",
  "Make a raw API request to any Clokr endpoint",
  {
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
    path: z.string().describe("API path (e.g. 'employees' or 'shifts/templates')"),
    body: z.string().default("").describe("JSON body (optional)"),
    query: z.string().default("").describe("Query params as key=value&key2=value2"),
  },
  async ({ method, path, body, query }) => {
    const parsedBody = body ? JSON.parse(body) : undefined;
    const parsedQuery: Record<string, string> = {};
    if (query) {
      for (const pair of query.split("&")) {
        const [k, v] = pair.split("=");
        if (k) parsedQuery[k] = v ?? "";
      }
    }
    const { status, data } = await apiCall(method, path, parsedBody, parsedQuery);
    return {
      content: [
        {
          type: "text" as const,
          text: `${status}\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
);

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Clokr MCP Server running on stdio");
}

main().catch(console.error);
