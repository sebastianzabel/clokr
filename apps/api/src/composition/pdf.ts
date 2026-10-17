import PDFDocument from "pdfkit";
import { fmtHM, fmtSignedHM, fmtDecimalDe } from "./pdf-format";

// ── Brand constants ──────────────────────────────────────
// Issue #617 (D-617-5): the app's default brand colour (`--brand` of the pflaume theme in
// apps/web/src/tokens.css) - no PDF carries the former indigo any more.
const BRAND_COLOR = "#80377b";
// Light tint of BRAND_COLOR for the subtitle on the brand band (readable on it).
const BRAND_TINT = "#ecd9ea";
const HEADER_H = 44;

// ── Saldo labels (SALDO-DISP-05) ─────────────────────────
// Used by generateMonthlyReportPdf (single-employee) and the Monatsexport (Issue #617) so the
// exported wording cannot drift between the two documents. Mirrors the
// screen's vocabulary (apps/web/src/lib/components/saldo/SaldoAnzeige.svelte: confirmedLabel /
// forecastLabel) — see docs/saldo-anzeige.md.
export const OVERTIME_LABEL_CONFIRMED = "Überstunden (Bestätigt)";
export const OVERTIME_LABEL_FORECAST = "Überstunden (Prognose)";
export const OVERTIME_FORECAST_FOOTNOTE =
  "Der Monat ist noch nicht abgeschlossen — dieser Wert ist eine Prognose und kann sich bis zum Monatsabschluss noch ändern.";

// Issue #451 (D-03): the working-time-account's own reconciliation item (Überstundenausgleich
// withdrawal; for SHIFT_BASED the § 615 BGB two-clause evaluation) can make Ist - Soll differ from
// the printed Überstunden — not a bug, the WTA simply charges/credits the balance without touching
// Soll. Printed only when non-zero, with an explaining legend, so the arithmetic always closes:
// Ist - Soll + Verrechnung = Überstunden. Never computed in the composition layer — always read
// from MonthReportFigures.balanceAdjustmentMinutes (contexts/working-time-account).
export const BALANCE_ADJUSTMENT_LABEL = "Verrechnung";
export const BALANCE_ADJUSTMENT_LEGEND =
  "Verrechnung: Überstundenausgleich und bei Schichtdienst die Bewertung nach § 615 BGB (Minderarbeit gegenüber dem Dienstplan, Mehrarbeit gegenüber dem Vertrag). Es gilt: Ist - Soll + Verrechnung = Überstunden.";
// ASCII hyphen on purpose: PDFKit's standard Helvetica uses WinAnsi encoding, which has no U+2212
// minus sign.

// ── § 9 BUrlG legend (Phase 104, D-30) ───────────────────────────────────────
// Single source of the wording, shared by the JSON Monatsbericht (routes/reports.ts), the
// single-employee PDF and the Monatsexport — the same drift argument as the OVERTIME_* labels
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
  /** Issue #451 (D-03): the WTA's own reconciliation item — see BALANCE_ADJUSTMENT_LEGEND above.
   *  0 for the vast majority of months; printed only when non-zero. */
  balanceAdjustmentHours: number;
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
      // Issue #448 (D-05, plan 03): set when this period's day count excludes one or more
      // Berufsschultage — "Berufsschule – kein Urlaub: dd.MM., dd.MM." — printed as a smaller
      // second line under the row. Undefined for a period with no BS day.
      note?: string;
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
    .fillColor(BRAND_TINT)
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
 * Issue #617 (D-617-4) - writes a centred footer line at `page.height - 40` WITHOUT adding a page.
 *
 * PDFKit starts a new page when a text call ends below `page.height - margins.bottom`, even with
 * `lineBreak: false`; a footer inside the bottom margin therefore produced a blank trailing page.
 * The helper zeroes the page's bottom margin while it writes, then restores the margin and the
 * cursor, so the footer never moves the content flow. Every PDF footer goes through here.
 */
export function writeFooter(doc: PDFKit.PDFDocument, text: string): void {
  const savedBottom = doc.page.margins.bottom;
  const savedX = doc.x;
  const savedY = doc.y;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.page.margins.bottom = 0;
  doc.fontSize(7).font("Helvetica").fillColor("#6b7280");
  // Centred by hand: with `lineBreak: false` PDFKit does not apply `align`.
  const x = left + Math.max(0, (width - doc.widthOfString(text)) / 2);
  doc.text(text, x, doc.page.height - 40, { lineBreak: false });
  doc.page.margins.bottom = savedBottom;
  doc.fillColor("#111827");
  doc.x = savedX;
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
    // Issue #451 (D-03): printed only when the WTA reports a non-zero reconciliation item — same
    // ASCII sign style as the Überstunden line above.
    if (data.balanceAdjustmentHours !== 0) {
      doc.text(
        `${BALANCE_ADJUSTMENT_LABEL}: ${data.balanceAdjustmentHours >= 0 ? "+" : ""}${data.balanceAdjustmentHours.toFixed(2)} h`,
        col2,
        sy,
      );
    }

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
    // Issue #451 (D-03): explains the Verrechnung line above — same grey 8pt style as the
    // forecast footnote, printed only when the item is actually non-zero.
    if (data.balanceAdjustmentHours !== 0) {
      doc.fontSize(8).font("Helvetica").fillColor("#6b7280");
      const legendWidth = doc.page.width - 100;
      const legendHeight = doc.heightOfString(BALANCE_ADJUSTMENT_LEGEND, { width: legendWidth });
      doc.text(BALANCE_ADJUSTMENT_LEGEND, 50, doc.y, { width: legendWidth });
      doc.y += legendHeight;
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
        // Issue #448 (D-05): a period with a BS note needs one extra, smaller line beneath it.
        const rowHeight = period.note ? 14 + 10 : 14;
        if (ry + rowHeight > doc.page.height - 60) {
          ry = nextPage();
        }
        let rx = 50;
        doc.fontSize(8).font("Helvetica").fillColor("#111827");
        doc.text(period.startDate, rx, ry, { width: colWidths[0] });
        rx += colWidths[0];
        doc.text(period.endDate, rx, ry, { width: colWidths[1] });
        rx += colWidths[1];
        doc.text(period.leaveTypeName, rx, ry, { width: colWidths[2] });
        rx += colWidths[2];
        doc.text(String(period.days), rx, ry, { width: colWidths[3] });
        ry += 14;
        if (period.note) {
          doc.fontSize(6.5).font("Helvetica").fillColor("#6b7280");
          doc.text(period.note, 50, ry, { width: colWidths.reduce((a, b) => a + b, 0) });
          doc.fillColor("#111827");
          ry += 10;
        }
      }
      doc.y = ry;
    }

    doc.moveDown(0.8); // gap between employees
  }
}

// ── Vacation overview rows ────────────────────────────────────────────────────
// Issue #613 (AC-3) — a person of the report population without a VACATION entitlement row is part
// of the overview as a placeholder row, never silently dropped. The wording is the web overview's.
export const NO_ENTITLEMENT_LABEL = "kein Anspruch hinterlegt";

// One row type, optional figures: a placeholder row carries `missingEntitlement: true` and no
// figures. A row without figures is printed as a placeholder whatever its flag says, so the text
// `undefined` can never reach a document.
export interface VacationOverviewPdfRow {
  name: string;
  employeeNumber: string;
  totalDays?: number;
  usedDays?: number;
  remainingDays?: number;
  carriedOver?: number;
  missingEntitlement?: boolean;
}

// One row of the overview table, shared by the streamed and the standalone renderer so the two
// documents cannot drift. A placeholder prints the German note across the four figure columns.
function drawVacationOverviewRow(
  doc: PDFKit.PDFDocument,
  emp: VacationOverviewPdfRow,
  rowY: number,
  colWidths: number[],
): void {
  let x = 50;
  doc.text(emp.name, x, rowY, { width: colWidths[0] });
  x += colWidths[0];
  doc.text(emp.employeeNumber, x, rowY, { width: colWidths[1] });
  x += colWidths[1];
  if (
    emp.missingEntitlement ||
    emp.totalDays === undefined ||
    emp.carriedOver === undefined ||
    emp.usedDays === undefined ||
    emp.remainingDays === undefined
  ) {
    const figureWidth = colWidths.slice(2).reduce((a, b) => a + b, 0);
    doc.text(NO_ENTITLEMENT_LABEL, x, rowY, { width: figureWidth });
    return;
  }
  doc.text(`${emp.totalDays}`, x, rowY, { width: colWidths[2] });
  x += colWidths[2];
  doc.text(`${emp.carriedOver}`, x, rowY, { width: colWidths[3] });
  x += colWidths[3];
  doc.text(`${emp.usedDays}`, x, rowY, { width: colWidths[4] });
  x += colWidths[4];
  doc.text(`${emp.remainingDays}`, x, rowY, { width: colWidths[5] });
}

// ── streamVacationOverviewPdf ─────────────────────────────────────────────────
// Streaming counterpart to generateVacationOverviewPdf.
// Appends landscape pages to an existing doc. Does NOT call doc.end().
export function streamVacationOverviewPdf(
  doc: PDFKit.PDFDocument,
  data: {
    tenantName: string;
    year: number;
    employees: VacationOverviewPdfRow[];
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
    drawVacationOverviewRow(doc, emp, rowY, colWidths);
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
  employees: VacationOverviewPdfRow[];
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
      drawVacationOverviewRow(doc, emp, rowY, colWidths);
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

// ── Monatsexport (Issue #617) ─────────────────────────────────────────────────
// The human-readable twin of the DATEV export: one row per person of the month, no day rows
// (the § 16 Abs. 2 ArbZG day records stay in the Stundennachweis). Every figure arrives
// pre-computed - the renderer formats, it computes nothing.

export const MONTHLY_EXPORT_STATUS_LABEL = {
  CONFIRMED: "Bestätigt",
  FORECAST: "Prognose",
  UNLABELLED: "ohne Soll",
} as const;

export const MONTHLY_EXPORT_FORECAST_LEGEND =
  "Prognose: Der Monat ist noch nicht abgeschlossen \u2014 die Werte k\u00f6nnen sich bis zum Monatsabschluss noch \u00e4ndern.";
export const MONTHLY_EXPORT_UNLABELLED_LEGEND =
  "ohne Soll: Vertrag ohne Sollvorgabe (reine Zeiterfassung) \u2014 dort entfallen Soll, Saldo und Gesamtsaldo.";
export const MONTHLY_EXPORT_DATEV_LEGEND =
  "DATEV-Std.: Normalstunden der DATEV-Datei in Dezimalstunden (Summe aller gültigen, abgeschlossenen Zeiteinträge des Monats). Sie können vom Ist abweichen: Das Ist stammt aus dem Arbeitszeitkonto, zählt nur Einträge der Art Arbeit an Tagen im Beschäftigungszeitraum, enthält die Berufsschul-Anrechnung und ist in abgeschlossenen Monaten der gespeicherte Stand.";
export const MONTHLY_EXPORT_UNITS_LEGEND =
  "Zeiten in Stunden:Minuten. Abwesenheiten in Arbeitstagen wie im DATEV-Export (leer = keine). Saldo Monat: der ganze Monat, im laufenden Monat als Prognose. Gesamtsaldo: Stand zum Monatsende, im laufenden Monat bis gestern.";

export interface MonthlyExportAbsenceDays {
  vacation: number;
  sick: number;
  sickChild: number;
  overtimeComp: number;
  special: number;
  education: number;
  unpaid: number;
  maternity: number;
  parental: number;
}

/**
 * Issue #617 (D-617-2, P-03) - the seven figures of section "Urlaubsjahr", in days. Every value is
 * read from the Resturlaub facade (`vacationBalanceForRow`) at the Stichtag; nothing is computed
 * here. `pendingDays` is "Beantragt" (pending requests created by the Stichtag, never deducted).
 */
export interface MonthlyExportVacation {
  entitlementDays: number;
  carriedOverEffectiveDays: number;
  availableDays: number;
  takenDays: number;
  approvedUpcomingDays: number;
  pendingDays: number;
  remainingDays: number;
}

export interface MonthlyExportRow {
  employeeName: string;
  employeeNumber: string;
  status: keyof typeof MONTHLY_EXPORT_STATUS_LABEL;
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  balanceAdjustmentMinutes: number;
  /**
   * Gesamtsaldo: the account's cumulative balance at the end of the month (a closed month's stored
   * carry-over; an open month's value through yesterday). `null` when the row is unlabelled.
   */
  closingBalanceMinutes: number | null;
  /** The worked minutes the person's DATEV Normalstunden line is built from. */
  datevWorkedMinutes: number;
  /** Arbeitstage of the month, exactly the DATEV Lohnart values. */
  absenceDays: MonthlyExportAbsenceDays;
  /** A confirmed § 9 BUrlG credit lies in the month (prints the § 9 legend). */
  section9: boolean;
  /** The year's VACATION figures at the Stichtag; `null` = no VACATION entitlement row. */
  vacation: MonthlyExportVacation | null;
}

export interface MonthlyExportData {
  tenantName: string;
  /** "September 2026" */
  monthLabel: string;
  year: number;
  month: number;
  /** "dd.MM.yyyy, HH:mm" in the tenant time zone. */
  generatedAt: string;
  /** The vacation year of section "Urlaubsjahr" and its Stichtag ("dd.MM.yyyy"). */
  vacationYear: { year: number; asOf: string };
  rows: MonthlyExportRow[];
}

type ExportColumn = {
  key: string;
  /** Header lines (an explicit break keeps long German words inside their column). */
  header: string[];
  /** Preferred width in points. */
  pref: number;
  align: "left" | "right";
  cell: (row: MonthlyExportRow) => string;
  /** Hidden when false (data-dependent columns). */
  visible: (rows: MonthlyExportRow[]) => boolean;
  /** Dash instead of the cell text for an unlabelled row (no Soll to compare against). */
  dashWhenUnlabelled?: boolean;
};

/**
 * Issue #617 (D-617-2) - the seven columns of section "Urlaubsjahr", in order. The in-app
 * Urlaubsuebersicht shows the same labels (`apps/web/src/lib/reports/vacation-columns.ts` mirrors
 * this constant and is pinned to it by a test).
 */
export const VACATION_YEAR_COLUMN_LABELS = [
  "Anspruch",
  "Übertrag (wirksam)",
  "Verfügbar",
  "Genommen",
  "Genehmigt",
  "Beantragt",
  "Resturlaub",
] as const;
export const VACATION_YEAR_LEGEND =
  "Verfügbar = Anspruch + wirksamer Übertrag. Genommen: genehmigte Tage bis einschließlich Stichtag. Genehmigt: genehmigte Tage nach dem Stichtag. Beantragt: bis zum Stichtag gestellte, noch nicht genehmigte Anträge, werden nicht abgezogen. Resturlaub = Verfügbar - Genommen - Genehmigt.";

const EXPORT_FONT_SIZE = 7;
const EXPORT_ROW_H = 14;
const EXPORT_HEADER_H = 22;
const EXPORT_MARGIN = 36;
// Content must end above the footer line at `page.height - 40`.
const EXPORT_BOTTOM_LIMIT = 56;
const ALWAYS = (): boolean => true;

function dayCell(value: number): string {
  return value === 0 ? "" : fmtDecimalDe(value, 1);
}

const anyRow =
  (pick: (row: MonthlyExportRow) => boolean) =>
  (rows: MonthlyExportRow[]): boolean =>
    rows.some(pick);

type AbsenceKind = keyof MonthlyExportAbsenceDays;

/** A day-count column of the absence block; shown always, or only when some row has a value. */
function absenceColumn(
  kind: AbsenceKind,
  header: string,
  pref: number,
  always: boolean,
): ExportColumn {
  return {
    key: kind,
    // "\n" separates the header lines (kept a plain string: the leave-type identity guard reads an
    // array literal holding a leave-type name as a control value, and this is a column title).
    header: header.split("\n"),
    pref,
    align: "right",
    cell: (r) => dayCell(r.absenceDays[kind]),
    visible: always ? ALWAYS : anyRow((r) => r.absenceDays[kind] !== 0),
  };
}

/** The columns of section "Monat". */
function monthColumns(): ExportColumn[] {
  return [
    {
      key: "name",
      header: ["Mitarbeiter"],
      pref: 130,
      align: "left",
      cell: (r) => r.employeeName,
      visible: ALWAYS,
    },
    {
      key: "number",
      header: ["Nr."],
      pref: 50,
      align: "left",
      cell: (r) => r.employeeNumber,
      visible: ALWAYS,
    },
    {
      key: "status",
      header: ["Status"],
      pref: 46,
      align: "left",
      cell: (r) => MONTHLY_EXPORT_STATUS_LABEL[r.status],
      visible: ALWAYS,
    },
    {
      key: "soll",
      header: ["Soll"],
      pref: 48,
      align: "right",
      cell: (r) => fmtHM(r.expectedMinutes),
      visible: ALWAYS,
      dashWhenUnlabelled: true,
    },
    {
      key: "ist",
      header: ["Ist"],
      pref: 48,
      align: "right",
      cell: (r) => fmtHM(r.workedMinutes),
      visible: ALWAYS,
    },
    {
      // The unit of the DATEV file (decimal hours with a comma), so the two documents reconcile line
      // by line.
      key: "datevHours",
      header: ["DATEV-Std."],
      pref: 48,
      align: "right",
      cell: (r) => fmtDecimalDe(r.datevWorkedMinutes / 60, 2),
      visible: ALWAYS,
    },
    {
      key: "adjustment",
      header: ["Verr."],
      pref: 44,
      align: "right",
      cell: (r) => fmtSignedHM(r.balanceAdjustmentMinutes),
      visible: anyRow((r) => r.balanceAdjustmentMinutes !== 0),
    },
    {
      key: "saldo",
      header: ["Saldo", "Monat"],
      pref: 48,
      align: "right",
      cell: (r) => fmtSignedHM(r.balanceMinutes),
      visible: ALWAYS,
      dashWhenUnlabelled: true,
    },
    {
      key: "closing",
      header: ["Gesamtsaldo"],
      pref: 54,
      align: "right",
      cell: (r) =>
        r.closingBalanceMinutes === null ? "\u2014" : fmtSignedHM(r.closingBalanceMinutes),
      visible: ALWAYS,
      dashWhenUnlabelled: true,
    },
    absenceColumn("vacation", "Urlaub", 36, true),
    absenceColumn("sick", "Krank", 36, true),
    absenceColumn("sickChild", "Kind\nkrank", 34, false),
    absenceColumn("overtimeComp", "Überstd.-\nAusgleich", 44, false),
    absenceColumn("special", "Sonder-\nurlaub", 38, false),
    absenceColumn("education", "Bildungs-\nurlaub", 42, false),
    absenceColumn("unpaid", "Unbezahlt", 42, false),
    absenceColumn("maternity", "Mutter-\nschutz", 38, false),
    absenceColumn("parental", "Eltern-\nzeit", 34, false),
  ];
}

/** The columns of section "Urlaubsjahr": the person, then the seven figures of the facade. */
function vacationColumns(): ExportColumn[] {
  const figure = (
    label: (typeof VACATION_YEAR_COLUMN_LABELS)[number],
    pref: number,
    pick: (v: MonthlyExportVacation) => number,
    key: string,
  ): ExportColumn => ({
    key,
    header: [label],
    pref,
    align: "right",
    cell: (r) => (r.vacation ? fmtDecimalDe(pick(r.vacation)) : ""),
    visible: ALWAYS,
  });
  return [
    {
      key: "name",
      header: ["Mitarbeiter"],
      pref: 130,
      align: "left",
      cell: (r) => r.employeeName,
      visible: ALWAYS,
    },
    {
      key: "number",
      header: ["Nr."],
      pref: 50,
      align: "left",
      cell: (r) => r.employeeNumber,
      visible: ALWAYS,
    },
    figure("Anspruch", 56, (v) => v.entitlementDays, "entitlement"),
    figure("Übertrag (wirksam)", 82, (v) => v.carriedOverEffectiveDays, "carryOver"),
    figure("Verfügbar", 62, (v) => v.availableDays, "available"),
    figure("Genommen", 62, (v) => v.takenDays, "taken"),
    figure("Genehmigt", 62, (v) => v.approvedUpcomingDays, "approved"),
    figure("Beantragt", 62, (v) => v.pendingDays, "requested"),
    figure("Resturlaub", 62, (v) => v.remainingDays, "remaining"),
  ];
}

/**
 * Column widths for the visible columns: every column keeps at least the width of its longest
 * header line; when the preferred widths do not fit, the name column gives way first, then the rest
 * shrinks towards its minimum. Widths are never below the text, so a header word never overflows.
 */
function exportColumnWidths(
  doc: PDFKit.PDFDocument,
  columns: ExportColumn[],
  available: number,
): number[] {
  doc.font("Helvetica-Bold").fontSize(EXPORT_FONT_SIZE);
  const mins = columns.map((c) => {
    const widest = Math.max(...c.header.map((line) => doc.widthOfString(line)));
    return Math.ceil(widest) + 6;
  });
  const prefs = columns.map((c, i) => Math.max(c.pref, mins[i]));
  const total = prefs.reduce((a, b) => a + b, 0);
  if (total <= available) {
    // Spare width goes to the name column.
    const widths = [...prefs];
    widths[0] += available - total;
    return widths;
  }
  // Shrink: the name column first (down to 90 pt), the others proportionally to their slack.
  const widths = [...prefs];
  let excess = total - available;
  const nameSlack = Math.max(0, widths[0] - Math.max(mins[0], 90));
  const nameCut = Math.min(excess, nameSlack);
  widths[0] -= nameCut;
  excess -= nameCut;
  if (excess > 0) {
    const slack = widths.map((w, i) => (i === 0 ? 0 : Math.max(0, w - mins[i])));
    const slackTotal = slack.reduce((a, b) => a + b, 0);
    const factor = slackTotal > 0 ? Math.min(1, excess / slackTotal) : 0;
    for (let i = 1; i < widths.length; i++) widths[i] -= slack[i] * factor;
  }
  return widths;
}

/** Truncates `text` with an ellipsis so it fits `width` at the current font. */
function fitText(doc: PDFKit.PDFDocument, text: string, width: number): string {
  if (doc.widthOfString(text) <= width) return text;
  let cut = text;
  while (cut.length > 1 && doc.widthOfString(`${cut}…`) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Writes one single-line table cell. Alignment is done by hand (x from the measured text width):
 * with `lineBreak: false` PDFKit ignores `width`/`align`, and a wrapping call could add a page.
 */
function drawCell(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "right",
): void {
  const textWidth = doc.widthOfString(text);
  const left = align === "right" ? x + width - 2 - textWidth : x + 2;
  doc.text(text, left, y, { lineBreak: false });
}

function drawExportTableHeader(
  doc: PDFKit.PDFDocument,
  columns: ExportColumn[],
  widths: number[],
  y: number,
): number {
  doc.font("Helvetica-Bold").fontSize(EXPORT_FONT_SIZE).fillColor("#374151");
  let x = EXPORT_MARGIN;
  columns.forEach((col, i) => {
    col.header.forEach((line, lineIndex) => {
      drawCell(doc, line, x, y + lineIndex * 9, widths[i], col.align);
    });
    x += widths[i];
  });
  const lineY = y + EXPORT_HEADER_H - 2;
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  doc
    .moveTo(EXPORT_MARGIN, lineY)
    .lineTo(EXPORT_MARGIN + totalWidth, lineY)
    .lineWidth(0.5)
    .stroke("#9ca3af");
  doc.fillColor("#111827");
  return y + EXPORT_HEADER_H;
}

function drawLegend(doc: PDFKit.PDFDocument, text: string, y: number): number {
  doc.font("Helvetica").fontSize(7).fillColor("#6b7280");
  const width = doc.page.width - 2 * EXPORT_MARGIN;
  const height = doc.heightOfString(text, { width });
  if (y + height > doc.page.height - EXPORT_BOTTOM_LIMIT) {
    doc.addPage();
    y = EXPORT_MARGIN;
  }
  doc.text(text, EXPORT_MARGIN, y, { width });
  doc.fillColor("#111827");
  return y + height + 3;
}

/**
 * Draws the Monatsexport body on `doc` (header band, section "Monat", legends). Separate from
 * `generateMonthlyExportPdf` so tests can drive it with a recording stub; the footer is added by
 * the generator in a second pass because "Seite X von Y" needs the final page count.
 */
export function drawMonthlyExport(doc: PDFKit.PDFDocument, data: MonthlyExportData): void {
  drawColoredHeader(doc, data.tenantName, `Monatsexport · ${data.monthLabel}`);
  const available = doc.page.width - 2 * EXPORT_MARGIN;

  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827");
  doc.text(`Monat: ${data.monthLabel}`, EXPORT_MARGIN, doc.y);
  let y = doc.y + 6;

  if (data.rows.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor("#374151");
    doc.text("Keine Personen in diesem Monat.", EXPORT_MARGIN, y);
    return;
  }

  const columns = monthColumns().filter((c) => c.visible(data.rows));
  const widths = exportColumnWidths(doc, columns, available);
  y = drawExportTableHeader(doc, columns, widths, y);

  for (const row of data.rows) {
    if (y + EXPORT_ROW_H > doc.page.height - EXPORT_BOTTOM_LIMIT) {
      doc.addPage();
      y = drawExportTableHeader(doc, columns, widths, EXPORT_MARGIN);
    }
    doc.font("Helvetica").fontSize(EXPORT_FONT_SIZE).fillColor("#111827");
    let x = EXPORT_MARGIN;
    columns.forEach((col, i) => {
      const unlabelledDash = col.dashWhenUnlabelled && row.status === "UNLABELLED";
      const raw = unlabelledDash ? "—" : col.cell(row);
      if (raw !== "") {
        drawCell(doc, fitText(doc, raw, widths[i] - 4), x, y + 3, widths[i], col.align);
      }
      x += widths[i];
    });
    const lineY = y + EXPORT_ROW_H - 1;
    doc
      .moveTo(EXPORT_MARGIN, lineY)
      .lineTo(EXPORT_MARGIN + widths.reduce((a, b) => a + b, 0), lineY)
      .lineWidth(0.25)
      .stroke("#e5e7eb");
    y += EXPORT_ROW_H;
  }

  // ── Legends: only what the table actually prints ─────────────────────────────
  y += 6;
  if (data.rows.some((r) => r.status === "FORECAST")) {
    y = drawLegend(doc, MONTHLY_EXPORT_FORECAST_LEGEND, y);
  }
  if (data.rows.some((r) => r.status === "UNLABELLED")) {
    y = drawLegend(doc, MONTHLY_EXPORT_UNLABELLED_LEGEND, y);
  }
  if (data.rows.some((r) => r.balanceAdjustmentMinutes !== 0)) {
    y = drawLegend(doc, BALANCE_ADJUSTMENT_LEGEND, y);
  }
  if (data.rows.some((r) => r.section9)) {
    y = drawLegend(doc, SECTION9_LEGEND, y);
  }
  if (data.rows.some((r) => Math.round(r.workedMinutes) !== Math.round(r.datevWorkedMinutes))) {
    y = drawLegend(doc, MONTHLY_EXPORT_DATEV_LEGEND, y);
  }
  y = drawLegend(doc, MONTHLY_EXPORT_UNITS_LEGEND, y);

  drawVacationYearSection(doc, data, y, available);
}

/**
 * Section "Urlaubsjahr <Jahr>, Stand <TT.MM.JJJJ>" (Issue #617, D-617-2, P-03): one row per person in
 * the order of section "Monat", the seven facade figures, the note `NO_ENTITLEMENT_LABEL` across the
 * figure columns for a person without a VACATION entitlement, and one legend. It starts on a new
 * page when the header and two rows no longer fit below the month section.
 */
function drawVacationYearSection(
  doc: PDFKit.PDFDocument,
  data: MonthlyExportData,
  startY: number,
  available: number,
): void {
  let y = startY + 6;
  if (y + 14 + EXPORT_HEADER_H + 2 * EXPORT_ROW_H > doc.page.height - EXPORT_BOTTOM_LIMIT) {
    doc.addPage();
    y = EXPORT_MARGIN;
  }
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827");
  doc.text(
    `Urlaubsjahr ${data.vacationYear.year}, Stand ${data.vacationYear.asOf}`,
    EXPORT_MARGIN,
    y,
    { lineBreak: false },
  );
  y += 14;

  const columns = vacationColumns();
  const widths = exportColumnWidths(doc, columns, available);
  y = drawExportTableHeader(doc, columns, widths, y);

  for (const row of data.rows) {
    if (y + EXPORT_ROW_H > doc.page.height - EXPORT_BOTTOM_LIMIT) {
      doc.addPage();
      y = drawExportTableHeader(doc, columns, widths, EXPORT_MARGIN);
    }
    doc.font("Helvetica").fontSize(EXPORT_FONT_SIZE).fillColor("#111827");
    let x = EXPORT_MARGIN;
    columns.forEach((col, i) => {
      if (row.vacation === null && i >= 2) {
        if (i === 2) {
          // One note across the seven figure columns instead of seven empty cells.
          const figureWidth = widths.slice(2).reduce((a, b) => a + b, 0);
          drawCell(
            doc,
            fitText(doc, NO_ENTITLEMENT_LABEL, figureWidth - 4),
            x,
            y + 3,
            figureWidth,
            "left",
          );
        }
      } else {
        const raw = col.cell(row);
        if (raw !== "") {
          drawCell(doc, fitText(doc, raw, widths[i] - 4), x, y + 3, widths[i], col.align);
        }
      }
      x += widths[i];
    });
    const lineY = y + EXPORT_ROW_H - 1;
    doc
      .moveTo(EXPORT_MARGIN, lineY)
      .lineTo(EXPORT_MARGIN + widths.reduce((a, b) => a + b, 0), lineY)
      .lineWidth(0.25)
      .stroke("#e5e7eb");
    y += EXPORT_ROW_H;
  }
  drawLegend(doc, VACATION_YEAR_LEGEND, y + 6);
}

/** Renders the Monatsexport as an A4 landscape PDF (header, table, "Seite X von Y" footer). */
export function generateMonthlyExportPdf(data: MonthlyExportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: EXPORT_MARGIN,
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      drawMonthlyExport(doc, data);

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        writeFooter(
          doc,
          `Erstellt am ${data.generatedAt}  ·  Seite ${i + 1} von ${range.count}  ·  Clokr`,
        );
      }
      doc.flushPages();
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
