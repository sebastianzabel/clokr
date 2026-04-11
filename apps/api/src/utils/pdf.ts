import PDFDocument from "pdfkit";

// ── Brand constants ──────────────────────────────────────
const BRAND_COLOR = "#4f46e5";
const HEADER_H = 44;

interface MonthlyReportData {
  tenantName: string;
  employeeName: string;
  employeeNumber: string;
  month: string; // "März 2026"
  workedHours: number;
  targetHours: number;
  overtimeHours: number;
  sickDays: number;
  sickDaysWithAttest: number;
  vacationDays: number;
  otherAbsenceDays: number;
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
    sickDaysWithAttest: number;
    sickDaysWithoutAttest: number;
    vacationDays: number;
    totalAbsenceDays: number;
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
  doc.fillColor("#ffffff").fontSize(14).font("Helvetica-Bold").text(title, 50, 12, {
    width: doc.page.width - 100,
  });
  doc.fillColor("#d4d4f7").fontSize(9).font("Helvetica").text(subtitle, 50, 28, {
    width: doc.page.width - 100,
  });
  doc.fillColor("#111827"); // reset for body
  doc.y = HEADER_H + 16;
}

function drawSmallFooter(doc: PDFKit.PDFDocument): void {
  doc
    .fontSize(7)
    .font("Helvetica")
    .fillColor("#6b7280")
    .text(
      `Erstellt am ${new Date().toLocaleDateString("de-DE")} \u2014 Clokr`,
      50,
      doc.page.height - 40,
      { align: "center", width: doc.page.width - 100 },
    );
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

    doc.text(`Soll-Stunden: ${data.targetHours.toFixed(1)} h`, col1, sy);
    doc.text(`Ist-Stunden: ${data.workedHours.toFixed(1)} h`, col2, sy);
    doc.text(
      `Überstunden: ${data.overtimeHours >= 0 ? "+" : ""}${data.overtimeHours.toFixed(1)} h`,
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

      doc.moveTo(50, tableTop + 14).lineTo(doc.page.width - 50, tableTop + 14).stroke("#e5e7eb");

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
        doc.text(`${entry.netHours.toFixed(1)} h`, x, rowY, { width: colWidths[4] });
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
// Does NOT use bufferPages (incompatible with streaming per RESEARCH.md Pitfall 2).
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

  // Register footer for every new page added after the first page
  doc.on("pageAdded", () => {
    drawSmallFooter(doc);
  });

  // Draw footer on the first page immediately (pageAdded fires only for pages added later)
  drawSmallFooter(doc);

  // ── Summary / cover page ──────────────────────────────
  drawColoredHeader(
    doc,
    data.tenantName,
    `Monatsbericht \u2014 ${data.month} \u2014 ${roleLabel}`,
  );

  // Summary table
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#111827").text("Übersicht");
  doc.moveDown(0.5);

  const summaryHeaders = ["Mitarbeiter", "Nr.", "Soll (h)", "Ist (h)", "Saldo (h)", "Urlaub", "Krank"];
  const summaryWidths = [150, 60, 60, 60, 60, 50, 50];

  doc.fontSize(8).font("Helvetica-Bold");
  let tx = 50;
  const tableTop = doc.y;
  summaryHeaders.forEach((h, i) => {
    doc.text(h, tx, tableTop, { width: summaryWidths[i] });
    tx += summaryWidths[i];
  });
  doc.moveTo(50, tableTop + 14).lineTo(doc.page.width - 50, tableTop + 14).stroke("#e5e7eb");

  doc.fontSize(8).font("Helvetica").fillColor("#111827");
  let rowY = tableTop + 18;

  for (const row of data.rows) {
    if (rowY > doc.page.height - 60) {
      doc.addPage();
      rowY = 50;
    }
    let rx = 50;
    const saldo = row.workedHours - row.targetHours;
    doc.text(row.employeeName, rx, rowY, { width: summaryWidths[0] });
    rx += summaryWidths[0];
    doc.text(row.employeeNumber, rx, rowY, { width: summaryWidths[1] });
    rx += summaryWidths[1];
    doc.text(row.targetHours.toFixed(1), rx, rowY, { width: summaryWidths[2] });
    rx += summaryWidths[2];
    doc.text(row.workedHours.toFixed(1), rx, rowY, { width: summaryWidths[3] });
    rx += summaryWidths[3];
    doc.text(`${saldo >= 0 ? "+" : ""}${saldo.toFixed(1)}`, rx, rowY, {
      width: summaryWidths[4],
    });
    rx += summaryWidths[4];
    doc.text(String(row.vacationDays), rx, rowY, { width: summaryWidths[5] });
    rx += summaryWidths[5];
    doc.text(
      String(row.sickDaysWithAttest + row.sickDaysWithoutAttest),
      rx,
      rowY,
      { width: summaryWidths[6] },
    );
    rowY += 14;
  }

  // ── Per-employee detail pages ─────────────────────────
  for (const row of data.rows) {
    doc.addPage();

    // Section header (no colored band on detail pages — just employee name)
    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .fillColor("#111827")
      .text(`${row.employeeName} (${row.employeeNumber})`);
    doc.fontSize(9).font("Helvetica").fillColor("#6b7280").text(`Rolle: ${row.role}`);
    doc.fillColor("#111827");
    doc.moveDown(0.5);

    // Zusammenfassung box
    const boxY = doc.y;
    doc.rect(50, boxY, doc.page.width - 100, 70).stroke("#e5e7eb");

    doc.fontSize(9).font("Helvetica");
    const saldo = row.workedHours - row.targetHours;
    const bc1 = 60;
    const bc2 = 200;
    const bc3 = 340;
    let by = boxY + 10;

    doc.text(`Soll: ${row.targetHours.toFixed(1)} h`, bc1, by);
    doc.text(`Ist: ${row.workedHours.toFixed(1)} h`, bc2, by);
    doc.text(`Saldo: ${saldo >= 0 ? "+" : ""}${saldo.toFixed(1)} h`, bc3, by);
    by += 18;
    doc.text(`Kranktage: ${row.sickDaysWithAttest + row.sickDaysWithoutAttest}`, bc1, by);
    doc.text(`davon m. Attest: ${row.sickDaysWithAttest}`, bc2, by);
    doc.text(`Urlaubstage: ${row.vacationDays}`, bc3, by);

    doc.y = boxY + 80;
    doc.moveDown(0.5);

    // Time entries table
    if (row.entries.length > 0) {
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#111827").text("Zeiteinträge");
      doc.moveDown(0.4);

      const etTop = doc.y;
      const colWidths = [70, 55, 55, 50, 55, doc.page.width - 100 - 285];
      const headers = ["Datum", "Start", "Ende", "Pause", "Netto", "Notiz"];

      doc.fontSize(8).font("Helvetica-Bold");
      let ex = 50;
      headers.forEach((h, i) => {
        doc.text(h, ex, etTop, { width: colWidths[i] });
        ex += colWidths[i];
      });
      doc.moveTo(50, etTop + 14).lineTo(doc.page.width - 50, etTop + 14).stroke("#e5e7eb");

      doc.fontSize(8).font("Helvetica").fillColor("#111827");
      let ey = etTop + 18;

      for (const entry of row.entries) {
        if (ey > doc.page.height - 80) {
          doc.addPage();
          ey = 50;
        }
        ex = 50;
        doc.text(entry.date, ex, ey, { width: colWidths[0] });
        ex += colWidths[0];
        doc.text(entry.start, ex, ey, { width: colWidths[1] });
        ex += colWidths[1];
        doc.text(entry.end || "\u2014", ex, ey, { width: colWidths[2] });
        ex += colWidths[2];
        doc.text(`${entry.breakMin} min`, ex, ey, { width: colWidths[3] });
        ex += colWidths[3];
        doc.text(`${entry.netHours.toFixed(1)} h`, ex, ey, { width: colWidths[4] });
        ex += colWidths[4];
        doc.text(entry.note || "", ex, ey, { width: colWidths[5] });
        ey += 14;
      }
    } else {
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#6b7280")
        .text("Keine Zeiteinträge in diesem Monat.");
      doc.fillColor("#111827");
    }
  }

}

// ── streamLeaveListPdf (PDF-02/PDF-05) ────────────────────────────────────────
// Synchronous void — caller owns lifecycle. Does NOT call doc.end().
export function streamLeaveListPdf(doc: PDFKit.PDFDocument, data: LeaveListData): void {
  // Register footer for every new page added after the first page
  doc.on("pageAdded", () => {
    drawSmallFooter(doc);
  });

  // Draw footer on the first page immediately
  drawSmallFooter(doc);

  // ── Header ───────────────────────────────────────────
  drawColoredHeader(doc, data.tenantName, `Urlaubsliste \u2014 ${data.year}`);

  if (data.employees.length === 0) {
    doc.fontSize(9).font("Helvetica").fillColor("#6b7280").text("Keine Urlaubsdaten vorhanden.");
    doc.fillColor("#111827");
    return;
  }

  const colWidths = [130, 100, 150, 60];
  const colHeaders = ["Von", "Bis", "Typ", "Tage"];

  for (const emp of data.employees) {
    // Employee heading
    if (doc.y > doc.page.height - 120) {
      doc.addPage();
    }

    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor("#111827")
      .text(`${emp.employeeName} (${emp.employeeNumber}) \u2014 Gesamt: ${emp.totalDays} Tage`);
    doc.moveDown(0.3);

    if (emp.periods.length === 0) {
      doc.fontSize(8).font("Helvetica").fillColor("#6b7280").text("Keine genehmigten Urlaubsanträge.");
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
      doc.moveTo(50, tTop + 14).lineTo(50 + colWidths.reduce((a, b) => a + b, 0), tTop + 14).stroke("#e5e7eb");

      doc.fontSize(8).font("Helvetica").fillColor("#111827");
      let ry = tTop + 18;

      for (const period of emp.periods) {
        if (ry > doc.page.height - 80) {
          doc.addPage();
          ry = 50;
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
