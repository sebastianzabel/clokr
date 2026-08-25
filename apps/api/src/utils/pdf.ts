import PDFDocument from "pdfkit";

// ── Brand constants ──────────────────────────────────────
const BRAND_COLOR = "#4f46e5";
const HEADER_H = 44;

// ── Saldo labels (SALDO-DISP-05) ─────────────────────────
// Shared between generateMonthlyReportPdf (single-employee) and streamCompanyMonthlyReportPdf
// (company-wide) so the exported wording cannot drift between the two generators. Mirrors the
// screen's vocabulary (apps/web/src/lib/components/saldo/SaldoAnzeige.svelte: confirmedLabel /
// forecastLabel) — see docs/saldo-anzeige.md.
export const OVERTIME_LABEL_CONFIRMED = "Überstunden (Bestätigt)";
export const OVERTIME_LABEL_FORECAST = "Überstunden (Prognose)";
export const OVERTIME_FORECAST_FOOTNOTE =
  "Der Monat ist noch nicht abgeschlossen — dieser Wert ist eine Prognose und kann sich bis zum Monatsabschluss noch ändern.";
export const COMPANY_PROVISIONAL_LEGEND =
  "* Monat noch nicht abgeschlossen — Saldo ist eine Prognose und kann sich bis zum Monatsabschluss noch ändern.";

// ── § 9 BUrlG legend (Phase 104, D-30) ───────────────────────────────────────
// Single source of the wording, shared by the JSON Monatsbericht (routes/reports.ts), the
// single-employee PDF and the company PDF — the same drift argument as the OVERTIME_* labels
// above. The string is asserted character-for-character by reports-sick-days.test.ts; changing
// it is a deliberate act, not a refactor.
export const SECTION9_LEGEND =
  "Tage mit bestätigter AU während genehmigten Urlaubs werden als Kranktage geführt und nicht auf den Jahresurlaub angerechnet (§ 9 BUrlG).";

interface MonthlyReportData {
  tenantName: string;
  employeeName: string;
  employeeNumber: string;
  month: string; // "März 2026"
  workedHours: number;
  targetHours: number;
  overtimeHours: number;
  /** Phase 97-02 (SALDO-DISP-05): true = confirmed (closed month), false = forecast (open month),
   *  null = intentionally unlabelled (MONTHLY_HOURS with no budget — mirrors
   *  resolveReportOvertimeHours's `labelled` flag in reports.ts; renderer omits the label). */
  overtimeConfirmed: boolean | null;
  sickDays: number;
  sickDaysWithAttest: number;
  vacationDays: number;
  otherAbsenceDays: number;
  /** Phase 104 (D-30): credited § 9 BUrlG days inside this month. > 0 renders the legend. */
  section9Days: number;
  entries: Array<{
    date: string;
    start: string;
    end: string;
    breakMin: number;
    netHours: number;
    note?: string;
  }>;
}

export interface CompanyMonthlyReportData {
  tenantName: string;
  month: string; // "März 2026"
  year: number;
  monthNumber: number;
  roleFilter: "all" | "EMPLOYEE" | "MANAGER";
  rows: Array<{
    employeeName: string;
    employeeNumber: string;
    role: "ADMIN" | "MANAGER" | "EMPLOYEE";
    workedHours: number;
    targetHours: number;
    overtimeHours: number;
    /** Same tri-state meaning as MonthlyReportData.overtimeConfirmed above. */
    overtimeConfirmed: boolean | null;
    sickDaysWithAttest: number;
    sickDaysWithoutAttest: number;
    vacationDays: number;
    totalAbsenceDays: number;
    /** Phase 104 (D-30): credited § 9 BUrlG days for this employee in this month. */
    section9DaysThisMonth: number;
    entries: Array<{
      date: string;
      start: string;
      end: string;
      breakMin: number;
      netHours: number;
      note?: string;
    }>;
  }>;
}

export interface LeaveListData {
  tenantName: string;
  year: number;
  employees: Array<{
    employeeName: string;
    employeeNumber: string;
    periods: Array<{
      startDate: string; // "dd.MM.yyyy"
      endDate: string; // "dd.MM.yyyy"
      leaveTypeName: string;
      days: number;
    }>;
    totalDays: number;
  }>;
}

// ── Helpers ───────────────────────────────────────────────

function drawColoredHeader(doc: PDFKit.PDFDocument, title: string, subtitle: string): void {
  doc.rect(0, 0, doc.page.width, HEADER_H).fill(BRAND_COLOR);
  doc
    .fillColor("#ffffff")
    .fontSize(14)
    .font("Helvetica-Bold")
    .text(title, 50, 12, {
      width: doc.page.width - 100,
    });
  doc
    .fillColor("#d4d4f7")
    .fontSize(9)
    .font("Helvetica")
    .text(subtitle, 50, 28, {
      width: doc.page.width - 100,
    });
  doc.fillColor("#111827"); // reset for body
  doc.y = HEADER_H + 16;
}

function drawSmallFooter(doc: PDFKit.PDFDocument): void {
  // Save current y position — restore after drawing footer to avoid disrupting content flow
  const savedY = doc.y;
  doc
    .fontSize(7)
    .font("Helvetica")
    .fillColor("#6b7280")
    .text(
      `Erstellt am ${new Date().toLocaleDateString("de-DE")} \u2014 Clokr`,
      50,
      doc.page.height - 40,
      { align: "center", width: doc.page.width - 100, lineBreak: false },
    );
  doc.fillColor("#111827");
  // Restore y so footer drawing doesn't advance the content cursor
  doc.y = savedY;
}

/**
 * Phase 104 (D-30): writes the § 9 legend at the current cursor when the report actually contains
 * credited days, and advances `doc.y` past it. Writes nothing at 0 — a report without § 9 days must
 * be unchanged from before this feature existed.
 */
export function drawSection9Legend(doc: PDFKit.PDFDocument, section9Days: number): void {
  if (!section9Days || section9Days <= 0) return;
  doc.fontSize(8).font("Helvetica").fillColor("#6b7280");
  const width = doc.page.width - 100;
  const height = doc.heightOfString(SECTION9_LEGEND, { width });
  doc.text(SECTION9_LEGEND, 50, doc.y, { width });
  doc.y += height;
  doc.fillColor("#111827");
}

// ── generateMonthlyReportPdf (PDF-04: improved layout, same signature) ────────
export function generateMonthlyReportPdf(data: MonthlyReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Colored header band (PDF-04) ──────────────────────
    drawColoredHeader(doc, data.tenantName, "Monatsbericht");

    // Employee info
    doc.fontSize(12).font("Helvetica-Bold").text(data.employeeName);
    doc
      .fontSize(9)
      .font("Helvetica")
      .text(`Mitarbeiter-Nr.: ${data.employeeNumber}`)
      .text(`Zeitraum: ${data.month}`);
    doc.moveDown(1);

    // Summary box
    doc.fontSize(11).font("Helvetica-Bold").text("Zusammenfassung");
    doc.moveDown(0.3);

    const summaryY = doc.y;
    doc.rect(50, summaryY, doc.page.width - 100, 80).stroke("#e5e7eb");

    doc.fontSize(9).font("Helvetica");
    const col1 = 60;
    const col2 = 200;
    const col3 = 340;
    let sy = summaryY + 10;

    doc.text(`Soll-Stunden: ${data.targetHours.toFixed(2)} h`, col1, sy);
    doc.text(`Ist-Stunden: ${data.workedHours.toFixed(2)} h`, col2, sy);
    const overtimeLabel =
      data.overtimeConfirmed === null
        ? "Überstunden"
        : data.overtimeConfirmed
          ? OVERTIME_LABEL_CONFIRMED
          : OVERTIME_LABEL_FORECAST;
    doc.text(
      `${overtimeLabel}: ${data.overtimeHours >= 0 ? "+" : ""}${data.overtimeHours.toFixed(2)} h`,
      col3,
      sy,
    );
    sy += 18;
    doc.text(`Krankheitstage: ${data.sickDays}`, col1, sy);
    doc.text(`davon mit Attest: ${data.sickDaysWithAttest}`, col2, sy);
    doc.text(`Urlaubstage: ${data.vacationDays}`, col3, sy);
    sy += 18;
    doc.text(`Sonstige Abwesenheit: ${data.otherAbsenceDays}`, col1, sy);

    doc.y = summaryY + 90;
    // Open-month footnote (Task 2, SALDO-DISP-05) — only when the figure is a labelled Prognose;
    // omitted for overtimeConfirmed === null (see resolveReportOvertimeHours's `labelled` flag) and
    // for a confirmed/closed month, which needs no caveat.
    if (data.overtimeConfirmed === false) {
      doc.fontSize(8).font("Helvetica").fillColor("#6b7280");
      const footnoteWidth = doc.page.width - 100;
      const footnoteHeight = doc.heightOfString(OVERTIME_FORECAST_FOOTNOTE, {
        width: footnoteWidth,
      });
      doc.text(OVERTIME_FORECAST_FOOTNOTE, 50, doc.y, { width: footnoteWidth });
      doc.y += footnoteHeight;
      doc.fillColor("#111827");
    }
    // § 9-Legende (D-30) — erklärt, warum Tage von Urlaub nach "Krank mit Attest" gewandert sind.
    drawSection9Legend(doc, data.section9Days);
    doc.moveDown(1);

    // Time entries table
    if (data.entries.length > 0) {
      doc.fontSize(11).font("Helvetica-Bold").text("Zeiteinträge");
      doc.moveDown(0.5);

      const tableTop = doc.y;
      const colWidths = [70, 55, 55, 50, 55, doc.page.width - 100 - 285];
      const headers = ["Datum", "Start", "Ende", "Pause", "Netto", "Notiz"];

      doc.fontSize(8).font("Helvetica-Bold");
      let x = 50;
      headers.forEach((h, i) => {
        doc.text(h, x, tableTop, { width: colWidths[i] });
        x += colWidths[i];
      });

      doc
        .moveTo(50, tableTop + 14)
        .lineTo(doc.page.width - 50, tableTop + 14)
        .stroke("#e5e7eb");

      doc.fontSize(8).font("Helvetica");
      let rowY = tableTop + 18;

      for (const entry of data.entries) {
        if (rowY > doc.page.height - 80) {
          doc.addPage();
          rowY = 50;
        }

        x = 50;
        doc.text(entry.date, x, rowY, { width: colWidths[0] });
        x += colWidths[0];
        doc.text(entry.start, x, rowY, { width: colWidths[1] });
        x += colWidths[1];
        doc.text(entry.end || "\u2014", x, rowY, { width: colWidths[2] });
        x += colWidths[2];
        doc.text(`${entry.breakMin} min`, x, rowY, { width: colWidths[3] });
        x += colWidths[3];
        doc.text(`${entry.netHours.toFixed(2)} h`, x, rowY, { width: colWidths[4] });
        x += colWidths[4];
        doc.text(entry.note || "", x, rowY, { width: colWidths[5] });

        rowY += 14;
      }
    }

    // ── Page-number footer pass (PDF-04: Seite X von Y) ───
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(7)
        .font("Helvetica")
        .fillColor("#6b7280")
        .text(
          `Erstellt am ${new Date().toLocaleDateString("de-DE")}  \u00b7  Seite ${i + 1} von ${range.count}  \u00b7  Clokr`,
          50,
          doc.page.height - 40,
          { align: "center", width: doc.page.width - 100 },
        );
    }
    doc.flushPages();

    doc.end();
  });
}

// ── streamCompanyMonthlyReportPdf (PDF-01/PDF-03/PDF-05) ─────────────────────
// Synchronous void — caller owns PDFDocument lifecycle (create → call → end → send).
// Does NOT use bufferPages (incompatible with streaming).
// Footer is written BEFORE each page break (explicit control, no pageAdded event).
export function streamCompanyMonthlyReportPdf(
  doc: PDFKit.PDFDocument,
  data: CompanyMonthlyReportData,
): void {
  const roleLabel =
    data.roleFilter === "EMPLOYEE"
      ? "Nur Mitarbeiter"
      : data.roleFilter === "MANAGER"
        ? "Nur Manager"
        : "Alle Mitarbeiter";

  // Helper: write footer on current page, then add a fresh page, return startY for content
  function nextPage(): number {
    drawSmallFooter(doc);
    doc.addPage();
    return doc.page.margins.top;
  }

  // ── Cover page ────────────────────────────────────────
  drawColoredHeader(doc, data.tenantName, `Monatsbericht \u2014 ${data.month} \u2014 ${roleLabel}`);

  // Summary table header
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#111827").text("Übersicht");
  doc.moveDown(0.5);

  const summaryHeaders = [
    "Mitarbeiter",
    "Nr.",
    "Soll (h)",
    "Ist (h)",
    "Saldo (h)",
    "Urlaub",
    "Krank",
  ];
  const summaryWidths = [150, 60, 60, 60, 60, 50, 50];
  const tableMargin = 50;
  const ROW_H = 16;
  const FOOTER_MARGIN = 60; // reserved space for footer at bottom

  let tx = tableMargin;
  const tableTop = doc.y;
  doc.fontSize(8).font("Helvetica-Bold");
  summaryHeaders.forEach((h, i) => {
    doc.text(h, tx, tableTop, { width: summaryWidths[i] });
    tx += summaryWidths[i];
  });
  doc
    .moveTo(tableMargin, tableTop + 14)
    .lineTo(doc.page.width - tableMargin, tableTop + 14)
    .stroke("#e5e7eb");

  doc.fontSize(8).font("Helvetica").fillColor("#111827");
  let rowY = tableTop + 18;
  let anyProvisional = false; // set when any row's overtimeConfirmed === false (Task 2, SALDO-DISP-05)

  for (const row of data.rows) {
    if (rowY + ROW_H > doc.page.height - FOOTER_MARGIN) {
      rowY = nextPage();
      // Repeat column headers on continuation pages
      let hx = tableMargin;
      doc.fontSize(8).font("Helvetica-Bold");
      summaryHeaders.forEach((h, i) => {
        doc.text(h, hx, rowY, { width: summaryWidths[i] });
        hx += summaryWidths[i];
      });
      doc
        .moveTo(tableMargin, rowY + 14)
        .lineTo(doc.page.width - tableMargin, rowY + 14)
        .stroke("#e5e7eb");
      doc.fontSize(8).font("Helvetica").fillColor("#111827");
      rowY += 18;
    }

    let rx = tableMargin;
    // Saldo cell sources the already §615-resolved row.overtimeHours (Task 1 fix, T-97-02-02) —
    // NOT a locally recomputed workedHours - targetHours, which silently diverges for SHIFT_BASED.
    let saldoText = `${row.overtimeHours >= 0 ? "+" : ""}${row.overtimeHours.toFixed(2)}`;
    if (row.overtimeConfirmed === false) {
      saldoText += " *";
      anyProvisional = true;
    }
    doc.text(row.employeeName, rx, rowY, { width: summaryWidths[0] });
    rx += summaryWidths[0];
    doc.text(row.employeeNumber, rx, rowY, { width: summaryWidths[1] });
    rx += summaryWidths[1];
    doc.text(row.targetHours.toFixed(2), rx, rowY, { width: summaryWidths[2] });
    rx += summaryWidths[2];
    doc.text(row.workedHours.toFixed(2), rx, rowY, { width: summaryWidths[3] });
    rx += summaryWidths[3];
    doc.text(saldoText, rx, rowY, { width: summaryWidths[4] });
    rx += summaryWidths[4];
    doc.text(String(row.vacationDays), rx, rowY, { width: summaryWidths[5] });
    rx += summaryWidths[5];
    doc.text(String(row.sickDaysWithAttest + row.sickDaysWithoutAttest), rx, rowY, {
      width: summaryWidths[6],
    });
    rowY += ROW_H;
  }

  // Provisional-rows legend (Task 2, SALDO-DISP-05) — only when at least one row's month is not
  // yet closed. Reuses the same pagination discipline as the row loop above.
  if (anyProvisional) {
    if (rowY + ROW_H > doc.page.height - FOOTER_MARGIN) {
      rowY = nextPage();
    }
    doc.fontSize(8).font("Helvetica").fillColor("#6b7280");
    doc.text(COMPANY_PROVISIONAL_LEGEND, tableMargin, rowY, {
      width: doc.page.width - 2 * tableMargin,
    });
    rowY += ROW_H;
    doc.fillColor("#111827");
  }

  // § 9-Legende (D-30) — nur wenn mindestens eine Zeile tatsächlich § 9-Tage trägt.
  const anySection9 = data.rows.some((r) => (r.section9DaysThisMonth ?? 0) > 0);
  if (anySection9) {
    if (rowY + ROW_H > doc.page.height - FOOTER_MARGIN) {
      rowY = nextPage();
    }
    doc.fontSize(8).font("Helvetica").fillColor("#6b7280");
    doc.text(SECTION9_LEGEND, tableMargin, rowY, {
      width: doc.page.width - 2 * tableMargin,
    });
    rowY += ROW_H;
    doc.fillColor("#111827");
  }

  // Footer on last page
  drawSmallFooter(doc);
}

// ── streamLeaveListPdf (PDF-02/PDF-05) ────────────────────────────────────────
// Synchronous void — caller owns lifecycle. Does NOT call doc.end().
// Footer written explicitly before page breaks (no pageAdded event).
export function streamLeaveListPdf(doc: PDFKit.PDFDocument, data: LeaveListData): void {
  function nextPage(): number {
    drawSmallFooter(doc);
    doc.addPage();
    return doc.page.margins.top;
  }

  // ── Header ───────────────────────────────────────────
  drawColoredHeader(doc, data.tenantName, `Urlaubsliste \u2014 ${data.year}`);

  if (data.employees.length === 0) {
    doc.fontSize(9).font("Helvetica").fillColor("#6b7280").text("Keine Urlaubsdaten vorhanden.");
    doc.fillColor("#111827");
    drawSmallFooter(doc);
    return;
  }

  const colWidths = [130, 100, 150, 60];
  const colHeaders = ["Von", "Bis", "Typ", "Tage"];

  for (const emp of data.employees) {
    // Employee heading — ensure enough space for name + at least one row
    if (doc.y > doc.page.height - 120) {
      doc.y = nextPage();
    }

    doc.x = 50; // Reset x cursor after table rows
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor("#111827")
      .text(`${emp.employeeName} (${emp.employeeNumber}) \u2014 Gesamt: ${emp.totalDays} Tage`, 50);
    doc.moveDown(0.3);

    if (emp.periods.length === 0) {
      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#6b7280")
        .text("Keine genehmigten Urlaubsanträge.", 50);
      doc.fillColor("#111827");
    } else {
      // Table header
      const tTop = doc.y;
      doc.fontSize(8).font("Helvetica-Bold").fillColor("#111827");
      let hx = 50;
      colHeaders.forEach((h, i) => {
        doc.text(h, hx, tTop, { width: colWidths[i] });
        hx += colWidths[i];
      });
      doc
        .moveTo(50, tTop + 14)
        .lineTo(50 + colWidths.reduce((a, b) => a + b, 0), tTop + 14)
        .stroke("#e5e7eb");

      doc.fontSize(8).font("Helvetica").fillColor("#111827");
      let ry = tTop + 18;

      for (const period of emp.periods) {
        if (ry + 14 > doc.page.height - 60) {
          ry = nextPage();
        }
        let rx = 50;
        doc.text(period.startDate, rx, ry, { width: colWidths[0] });
        rx += colWidths[0];
        doc.text(period.endDate, rx, ry, { width: colWidths[1] });
        rx += colWidths[1];
        doc.text(period.leaveTypeName, rx, ry, { width: colWidths[2] });
        rx += colWidths[2];
        doc.text(String(period.days), rx, ry, { width: colWidths[3] });
        ry += 14;
      }
      doc.y = ry;
    }

    doc.moveDown(0.8); // gap between employees
  }
}

// ── streamVacationOverviewPdf ─────────────────────────────────────────────────
// Streaming counterpart to generateVacationOverviewPdf.
// Appends landscape pages to an existing doc. Does NOT call doc.end().
export function streamVacationOverviewPdf(
  doc: PDFKit.PDFDocument,
  data: {
    tenantName: string;
    year: number;
    employees: Array<{
      name: string;
      employeeNumber: string;
      totalDays: number;
      usedDays: number;
      remainingDays: number;
      carriedOver: number;
    }>;
  },
): void {
  doc.addPage({ size: "A4", layout: "landscape" });

  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .text(`${data.tenantName} \u2014 Urlaubsübersicht`, { align: "center" });
  doc
    .fontSize(10)
    .font("Helvetica")
    .text(`${data.tenantName} \u2014 ${data.year}`, { align: "center" });
  doc.moveDown(1.5);

  const headers = ["Mitarbeiter", "Nr.", "Anspruch", "Übertrag", "Genommen", "Restlich"];
  const colWidths = [200, 80, 80, 80, 80, 80];

  doc.fontSize(9).font("Helvetica-Bold");
  let x = 50;
  const tableTop = doc.y;
  headers.forEach((h, i) => {
    doc.text(h, x, tableTop, { width: colWidths[i] });
    x += colWidths[i];
  });
  doc
    .moveTo(50, tableTop + 14)
    .lineTo(50 + colWidths.reduce((a, b) => a + b, 0), tableTop + 14)
    .stroke("#e5e7eb");

  doc.fontSize(9).font("Helvetica");
  let rowY = tableTop + 20;

  for (const emp of data.employees) {
    if (rowY > doc.page.height - 60) {
      doc.addPage({ size: "A4", layout: "landscape" });
      rowY = 50;
    }
    x = 50;
    doc.text(emp.name, x, rowY, { width: colWidths[0] });
    x += colWidths[0];
    doc.text(emp.employeeNumber, x, rowY, { width: colWidths[1] });
    x += colWidths[1];
    doc.text(`${emp.totalDays}`, x, rowY, { width: colWidths[2] });
    x += colWidths[2];
    doc.text(`${emp.carriedOver}`, x, rowY, { width: colWidths[3] });
    x += colWidths[3];
    doc.text(`${emp.usedDays}`, x, rowY, { width: colWidths[4] });
    x += colWidths[4];
    doc.text(`${emp.remainingDays}`, x, rowY, { width: colWidths[5] });
    rowY += 16;
  }

  doc
    .fontSize(7)
    .font("Helvetica")
    .text(
      `Erstellt am ${new Date().toLocaleDateString("de-DE")} \u2014 Clokr`,
      50,
      doc.page.height - 40,
      { align: "center", width: doc.page.width - 100 },
    );
}

export function generateVacationOverviewPdf(data: {
  tenantName: string;
  year: number;
  employees: Array<{
    name: string;
    employeeNumber: string;
    totalDays: number;
    usedDays: number;
    remainingDays: number;
    carriedOver: number;
  }>;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .text("Clokr \u2014 Urlaubsübersicht", { align: "center" });
    doc
      .fontSize(10)
      .font("Helvetica")
      .text(`${data.tenantName} \u2014 ${data.year}`, { align: "center" });
    doc.moveDown(1.5);

    // Table
    const headers = ["Mitarbeiter", "Nr.", "Anspruch", "Übertrag", "Genommen", "Restlich"];
    const colWidths = [200, 80, 80, 80, 80, 80];

    doc.fontSize(9).font("Helvetica-Bold");
    let x = 50;
    const tableTop = doc.y;
    headers.forEach((h, i) => {
      doc.text(h, x, tableTop, { width: colWidths[i] });
      x += colWidths[i];
    });
    doc
      .moveTo(50, tableTop + 14)
      .lineTo(50 + colWidths.reduce((a, b) => a + b, 0), tableTop + 14)
      .stroke("#e5e7eb");

    doc.fontSize(9).font("Helvetica");
    let rowY = tableTop + 20;

    for (const emp of data.employees) {
      if (rowY > doc.page.height - 60) {
        doc.addPage();
        rowY = 50;
      }
      x = 50;
      doc.text(emp.name, x, rowY, { width: colWidths[0] });
      x += colWidths[0];
      doc.text(emp.employeeNumber, x, rowY, { width: colWidths[1] });
      x += colWidths[1];
      doc.text(`${emp.totalDays}`, x, rowY, { width: colWidths[2] });
      x += colWidths[2];
      doc.text(`${emp.carriedOver}`, x, rowY, { width: colWidths[3] });
      x += colWidths[3];
      doc.text(`${emp.usedDays}`, x, rowY, { width: colWidths[4] });
      x += colWidths[4];
      doc.text(`${emp.remainingDays}`, x, rowY, { width: colWidths[5] });
      rowY += 16;
    }

    doc
      .fontSize(7)
      .font("Helvetica")
      .text(
        `Erstellt am ${new Date().toLocaleDateString("de-DE")} \u2014 Clokr`,
        50,
        doc.page.height - 40,
        { align: "center", width: doc.page.width - 100 },
      );

    doc.end();
  });
}
