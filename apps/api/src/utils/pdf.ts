import PDFDocument from "pdfkit";

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

export function generateMonthlyReportPdf(data: MonthlyReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc.fontSize(20).font("Helvetica-Bold").text("Clokr", { align: "center" });
    doc.fontSize(10).font("Helvetica").text("Monatsbericht", { align: "center" });
    doc.moveDown(1.5);

    // Employee info
    doc.fontSize(12).font("Helvetica-Bold").text(data.employeeName);
    doc.fontSize(9).font("Helvetica")
      .text(`Mitarbeiter-Nr.: ${data.employeeNumber}`)
      .text(`Zeitraum: ${data.month}`)
      .text(`Unternehmen: ${data.tenantName}`);
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
    doc.text(`Überstunden: ${data.overtimeHours >= 0 ? "+" : ""}${data.overtimeHours.toFixed(1)} h`, col3, sy);
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

      // Table header
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
        doc.text(entry.date, x, rowY, { width: colWidths[0] }); x += colWidths[0];
        doc.text(entry.start, x, rowY, { width: colWidths[1] }); x += colWidths[1];
        doc.text(entry.end || "\u2014", x, rowY, { width: colWidths[2] }); x += colWidths[2];
        doc.text(`${entry.breakMin} min`, x, rowY, { width: colWidths[3] }); x += colWidths[3];
        doc.text(`${entry.netHours.toFixed(1)} h`, x, rowY, { width: colWidths[4] }); x += colWidths[4];
        doc.text(entry.note || "", x, rowY, { width: colWidths[5] });

        rowY += 14;
      }
    }

    // Footer
    doc.fontSize(7).font("Helvetica")
      .text(
        `Erstellt am ${new Date().toLocaleDateString("de-DE")} \u2014 Clokr`,
        50,
        doc.page.height - 40,
        { align: "center", width: doc.page.width - 100 },
      );

    doc.end();
  });
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

    doc.fontSize(18).font("Helvetica-Bold").text("Clokr \u2014 Urlaubsübersicht", { align: "center" });
    doc.fontSize(10).font("Helvetica").text(`${data.tenantName} \u2014 ${data.year}`, { align: "center" });
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
    doc.moveTo(50, tableTop + 14).lineTo(50 + colWidths.reduce((a, b) => a + b, 0), tableTop + 14).stroke("#e5e7eb");

    doc.fontSize(9).font("Helvetica");
    let rowY = tableTop + 20;

    for (const emp of data.employees) {
      if (rowY > doc.page.height - 60) {
        doc.addPage();
        rowY = 50;
      }
      x = 50;
      doc.text(emp.name, x, rowY, { width: colWidths[0] }); x += colWidths[0];
      doc.text(emp.employeeNumber, x, rowY, { width: colWidths[1] }); x += colWidths[1];
      doc.text(`${emp.totalDays}`, x, rowY, { width: colWidths[2] }); x += colWidths[2];
      doc.text(`${emp.carriedOver}`, x, rowY, { width: colWidths[3] }); x += colWidths[3];
      doc.text(`${emp.usedDays}`, x, rowY, { width: colWidths[4] }); x += colWidths[4];
      doc.text(`${emp.remainingDays}`, x, rowY, { width: colWidths[5] });
      rowY += 16;
    }

    doc.fontSize(7).font("Helvetica")
      .text(
        `Erstellt am ${new Date().toLocaleDateString("de-DE")} \u2014 Clokr`,
        50,
        doc.page.height - 40,
        { align: "center", width: doc.page.width - 100 },
      );

    doc.end();
  });
}
